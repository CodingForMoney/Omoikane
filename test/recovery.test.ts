import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelError,
  modelResponse,
} from "@openai/agents/testing";
import { Container } from "../src/container.js";
import { OmoikaneClient, type RuntimeEvent } from "../src/client/index.js";
import { getSettings } from "../src/config.js";
import {
  DeterministicFaultInjector,
  InjectedProcessCrash,
} from "../src/recovery.js";
import {
  registerToolImplementation,
  unregisterToolImplementation,
} from "../src/tools.js";
import { publishedAgent, testContainer } from "./helpers.js";

let cleanup: (() => Promise<void>) | undefined;
const registeredTools = new Set<string>();

afterEach(async () => {
  for (const key of registeredTools) unregisterToolImplementation(key);
  registeredTools.clear();
  await cleanup?.();
  cleanup = undefined;
});

async function expireLease(container: Container, runId: string) {
  await container.db.query(
    "UPDATE runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [runId],
  );
}

describe("failure and recovery semantics", () => {
  it("retries only a Provider failure explicitly marked replay-safe", async () => {
    const test = await testContainer();
    cleanup = test.close;
    const failure = Object.assign(new Error("request was never dispatched"), {
      code: "ECONNREFUSED",
    });
    const model = new ScriptedModel([
      modelError(failure, {
        suggested: true,
        replaySafety: "safe",
        reason: "connection failed before dispatch",
      }),
      modelResponse([assistantMessage("safe retry completed")]),
    ]);
    const fixture = await publishedAgent(test.container, { model });
    const run = await test.container.runner.create({
      deploymentId: fixture.version.id,
      input: "retry safely",
    });

    await test.container.runner.processNext();

    expect(await test.container.runner.publicRun(run.id)).toMatchObject({
      status: "completed",
      output: "safe retry completed",
    });
    expect(model.calls).toHaveLength(2);
    const types = (await test.container.events.list(run.id)).map(
      (event) => event.type,
    );
    expect(
      types.filter((type) => type === "model.request_started"),
    ).toHaveLength(2);
    expect(types).toContain("model.request_failed");
    expect(types).toContain("model.request_completed");
  });

  it("does not replay an ambiguous Provider timeout", async () => {
    const test = await testContainer();
    cleanup = test.close;
    const failure = Object.assign(new Error("gateway timeout"), {
      status: 504,
      code: "ETIMEDOUT",
    });
    const model = new ScriptedModel([
      modelError(failure, {
        suggested: true,
        reason: "transient transport failure",
      }),
      modelResponse([assistantMessage("must not be reached")]),
    ]);
    const fixture = await publishedAgent(test.container, { model });
    const run = await test.container.runner.create({
      deploymentId: fixture.version.id,
      input: "do not replay an ambiguous timeout",
    });

    await test.container.runner.processNext();

    expect((await test.container.runner.get(run.id)).status).toBe("failed");
    expect(model.calls).toHaveLength(1);
    const failureEvent = (await test.container.events.list(run.id)).find(
      (event) => event.type === "model.request_failed",
    );
    expect(failureEvent?.payload_json).toMatchObject({ category: "timeout" });
  });

  it("rolls back terminal state before commit and exposes whole-Run replay", async () => {
    const faults = new DeterministicFaultInjector();
    const test = await testContainer({ faultInjector: faults });
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([assistantMessage("first provider result")]),
      modelResponse([assistantMessage("replayed provider result")]),
    ]);
    const fixture = await publishedAgent(test.container, { model });
    const run = await test.container.runner.create({
      deploymentId: fixture.version.id,
      input: "simulate a crash before commit",
    });
    faults.arm("run.before_terminal_commit");

    await expect(test.container.runner.processNext()).rejects.toBeInstanceOf(
      InjectedProcessCrash,
    );
    expect((await test.container.runner.get(run.id)).status).toBe("running");
    expect(
      (await test.container.events.list(run.id)).some(
        (event) => event.type === "run.completed",
      ),
    ).toBe(false);

    await expireLease(test.container, run.id);
    await test.container.runner.reap();
    const requeued = (await test.container.events.list(run.id)).find(
      (event) => event.type === "run.requeued",
    );
    expect(requeued?.payload_json).toMatchObject({
      execution_semantics: "at_least_once",
      model_replay_possible: true,
      provisional_events_invalidated: true,
    });

    await test.container.runner.processNext();
    expect(await test.container.runner.publicRun(run.id)).toMatchObject({
      status: "completed",
      output: "replayed provider result",
      execution_attempt: 2,
    });
    expect(model.calls).toHaveLength(2);
    const starts = (await test.container.events.list(run.id)).filter(
      (event) => event.type === "run.started",
    );
    expect(starts.map((event) => event.payload_json.execution_attempt)).toEqual(
      [1, 2],
    );
  });

  it("keeps terminal state and its matching Event atomic after commit", async () => {
    const faults = new DeterministicFaultInjector();
    const test = await testContainer({ faultInjector: faults });
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([assistantMessage("committed once")]),
    ]);
    const fixture = await publishedAgent(test.container, { model });
    const run = await test.container.runner.create({
      deploymentId: fixture.version.id,
      input: "crash after commit",
    });
    faults.arm("run.after_terminal_commit");

    await expect(test.container.runner.processNext()).rejects.toBeInstanceOf(
      InjectedProcessCrash,
    );

    expect(await test.container.runner.publicRun(run.id)).toMatchObject({
      status: "completed",
      output: "committed once",
    });
    expect(
      (await test.container.events.list(run.id)).filter(
        (event) => event.type === "run.completed",
      ),
    ).toHaveLength(1);
    await test.container.runner.reap();
    expect(model.calls).toHaveLength(1);
  });

  it("rolls back approval and maintenance transitions at injected commit boundaries", async () => {
    const faults = new DeterministicFaultInjector();
    const test = await testContainer({ faultInjector: faults });
    cleanup = test.close;
    const implementationKey = `recovery.approval.${crypto.randomUUID()}`;
    const toolSlug = `recovery-approval-${crypto.randomUUID().slice(0, 8)}`;
    registerToolImplementation(implementationKey, async () => ({ ok: true }));
    registeredTools.add(implementationKey);
    await test.container.tools.create({
      slug: toolSlug,
      name: "recovery_approval",
      description: "Approval transaction recovery fixture",
      implementation_key: implementationKey,
      schema: { type: "object", properties: {}, additionalProperties: false },
      policy: { requires_approval: true },
    });
    const call = () =>
      modelResponse([
        functionCall("recovery_approval", {}, { callId: "approval-call-1" }),
      ]);
    const model = new ScriptedModel([call(), call()]);
    const fixture = await publishedAgent(test.container, {
      model,
      tools: [toolSlug],
    });
    const run = await test.container.runner.create({
      deploymentId: fixture.version.id,
      input: "persist approval atomically",
    });
    faults.arm("approval.before_commit");

    await expect(test.container.runner.processNext()).rejects.toBeInstanceOf(
      InjectedProcessCrash,
    );
    expect((await test.container.runner.get(run.id)).status).toBe("running");
    expect(
      (
        await test.container.db.query(
          "SELECT id FROM approvals WHERE run_id=$1",
          [run.id],
        )
      ).rows,
    ).toEqual([]);

    await expireLease(test.container, run.id);
    faults.arm("maintenance.before_recovery_commit");
    await expect(test.container.runner.reap()).rejects.toBeInstanceOf(
      InjectedProcessCrash,
    );
    expect((await test.container.runner.get(run.id)).status).toBe("running");
    expect(
      (await test.container.events.list(run.id)).filter(
        (event) => event.type === "run.requeued",
      ),
    ).toHaveLength(0);

    await test.container.runner.reap();
    await test.container.runner.processNext();
    expect((await test.container.runner.get(run.id)).status).toBe(
      "waiting_approval",
    );
    expect(
      (
        await test.container.db.query(
          "SELECT id FROM approvals WHERE run_id=$1",
          [run.id],
        )
      ).rows,
    ).toHaveLength(1);
  });

  it("never repeats a side-effecting Function Tool after an uncertain commit", async () => {
    const faults = new DeterministicFaultInjector();
    const test = await testContainer({ faultInjector: faults });
    cleanup = test.close;
    const implementationKey = `recovery.side-effect.${crypto.randomUUID()}`;
    const toolSlug = `recovery-side-effect-${crypto.randomUUID().slice(0, 8)}`;
    let effects = 0;
    registerToolImplementation(implementationKey, async () => {
      effects += 1;
      return { effect_id: `effect-${effects}` };
    });
    registeredTools.add(implementationKey);
    const tool = await test.container.tools.create({
      slug: toolSlug,
      name: "durable_side_effect",
      description: "Recovery side-effect fixture",
      implementation_key: implementationKey,
      schema: { type: "object", properties: {}, additionalProperties: false },
      policy: { side_effecting: true },
    });
    expect(tool.policy).toMatchObject({
      side_effecting: true,
      requires_approval: true,
    });
    const model = new ScriptedModel([
      modelResponse([
        functionCall("durable_side_effect", {}, { callId: "effect-call-1" }),
      ]),
      modelResponse([assistantMessage("effect reconciled")]),
    ]);
    const fixture = await publishedAgent(test.container, {
      model,
      tools: [toolSlug],
    });
    const run = await test.container.runner.create({
      deploymentId: fixture.version.id,
      input: "perform one side effect",
    });

    await test.container.runner.processNext();
    expect((await test.container.runner.get(run.id)).status).toBe(
      "waiting_approval",
    );
    const approval = (
      await test.container.db.query<{ id: string }>(
        "SELECT id FROM approvals WHERE run_id=$1",
        [run.id],
      )
    ).rows[0]!;
    await test.container.runner.decideApproval(approval.id, "approved");
    faults.arm("tool.after_effect_before_commit");

    await test.container.runner.processNext();
    expect(effects).toBe(1);
    expect((await test.container.tools.executions(run.id))[0]).toMatchObject({
      status: "unknown",
      side_effecting: true,
    });

    expect((await test.container.runner.get(run.id)).status).toBe(
      "waiting_reconciliation",
    );
    const execution = (await test.container.tools.executions(run.id))[0]!;
    await test.container.tools.resolveExecution(String(execution.id), {
      status: "completed",
      output: { effect_id: "effect-1" },
      reason: "verified against the external system",
    });
    await test.container.runner.processNext();

    expect(await test.container.runner.publicRun(run.id)).toMatchObject({
      status: "completed",
      output: "effect reconciled",
    });
    expect(effects).toBe(1);
  }, 30_000);

  it("reuses a committed side effect when the Worker dies before Run completion", async () => {
    const faults = new DeterministicFaultInjector();
    const test = await testContainer({ faultInjector: faults });
    cleanup = test.close;
    const implementationKey = `recovery.committed-effect.${crypto.randomUUID()}`;
    const toolSlug = `committed-effect-${crypto.randomUUID().slice(0, 8)}`;
    let effects = 0;
    registerToolImplementation(implementationKey, async () => {
      effects += 1;
      return { committed_effect: effects };
    });
    registeredTools.add(implementationKey);
    await test.container.tools.create({
      slug: toolSlug,
      name: "committed_side_effect",
      description: "Committed side-effect recovery fixture",
      implementation_key: implementationKey,
      schema: { type: "object", properties: {}, additionalProperties: false },
      policy: { side_effecting: true },
    });
    const model = new ScriptedModel([
      modelResponse([
        functionCall("committed_side_effect", {}, { callId: "commit-call-1" }),
      ]),
      modelResponse([assistantMessage("first terminal result")]),
      modelResponse([assistantMessage("recovered terminal result")]),
    ]);
    const fixture = await publishedAgent(test.container, {
      model,
      tools: [toolSlug],
    });
    const run = await test.container.runner.create({
      deploymentId: fixture.version.id,
      input: "commit one side effect",
    });
    await test.container.runner.processNext();
    const approval = (
      await test.container.db.query<{ id: string }>(
        "SELECT id FROM approvals WHERE run_id=$1",
        [run.id],
      )
    ).rows[0]!;
    await test.container.runner.decideApproval(approval.id, "approved");
    faults.arm("run.before_terminal_commit");

    await expect(test.container.runner.processNext()).rejects.toBeInstanceOf(
      InjectedProcessCrash,
    );
    expect(effects).toBe(1);
    expect((await test.container.tools.executions(run.id))[0]).toMatchObject({
      status: "completed",
      output_json: { committed_effect: 1 },
    });

    await expireLease(test.container, run.id);
    await test.container.runner.reap();
    await test.container.runner.processNext();
    expect(await test.container.runner.publicRun(run.id)).toMatchObject({
      status: "completed",
      output: "recovered terminal result",
    });
    expect(effects).toBe(1);
  }, 30_000);

  it("reopens a persistent PGlite database and reclaims an expired lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "omoikane-pglite-restart-"));
    let first: Container | undefined;
    let second: Container | undefined;
    cleanup = async () => {
      await Promise.allSettled([first?.close(), second?.close()]);
      await rm(root, { recursive: true, force: true });
    };
    const settings = getSettings({
      AGENT_DATABASE_URL: `pglite://${join(root, "database")}`,
      AGENT_ARTIFACT_ROOT: join(root, "artifacts"),
      AGENT_SKILL_ROOT: join(root, "skills"),
      AGENT_SANDBOX_ROOT: join(root, "sandboxes"),
      AGENT_CREDENTIAL_SECRET: "pglite-restart-test-credential-secret",
      AGENT_TRACING_DISABLED: "true",
      AGENT_AUTO_MIGRATE: "true",
    });
    first = await Container.create(settings, { startWorker: false });
    const fixture = await publishedAgent(first, {
      model: new ScriptedModel([]),
    });
    const run = await first.runner.create({
      deploymentId: fixture.version.id,
      input: "survive local restart",
    });
    await first.runner.claim();
    await expireLease(first, run.id);
    await first.close();
    first = undefined;

    second = await Container.create(settings, { startWorker: false });
    const model = new ScriptedModel([
      modelResponse([assistantMessage("recovered from PGlite")]),
    ]);
    second.providers.modelFor = async () => model;
    await second.runner.reap();
    expect((await second.runner.get(run.id)).status).toBe("queued");
    await second.runner.processNext();
    expect(await second.runner.publicRun(run.id)).toMatchObject({
      status: "completed",
      output: "recovered from PGlite",
      execution_attempt: 2,
    });
  }, 30_000);

  it("reconnects a truncated SSE stream from Last-Event-ID without duplicates", async () => {
    const events: RuntimeEvent[] = [1, 2, 3].map((seq) => ({
      schema_version: 1,
      id: `event-${seq}`,
      run_id: "run-sse-recovery",
      seq,
      type: seq === 3 ? "run.completed" : "model.output_delta",
      time: new Date(0).toISOString(),
      data: seq === 3 ? { output_available: true } : { delta: String(seq) },
    }));
    const requests: string[] = [];
    let call = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      requests.push(new Headers(init?.headers).get("Last-Event-ID") ?? "");
      call += 1;
      const selected = call === 1 ? events.slice(0, 1) : events.slice(1);
      const body = selected
        .map(
          (event) =>
            `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join("");
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };
    const client = new OmoikaneClient({
      baseUrl: "http://127.0.0.1:1",
      fetch: fetcher,
    });
    const received: RuntimeEvent[] = [];
    for await (const event of client.streamRun("run-sse-recovery"))
      received.push(event);

    expect(received.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(requests).toEqual(["0", "1"]);
  });
});
