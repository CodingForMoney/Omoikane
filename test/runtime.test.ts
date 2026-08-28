import { afterEach, describe, expect, it } from "vitest";
import { Usage } from "@openai/agents";
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponse,
} from "@openai/agents/testing";
import type { Container } from "../src/container.js";
import { createApp } from "../src/api.js";
import {
  registerToolImplementation,
  unregisterToolImplementation,
} from "../src/tools.js";
import { publishedAgent, testContainer } from "./helpers.js";

let container: Container | undefined;
let cleanup: (() => Promise<void>) | undefined;
const registeredToolKeys = new Set<string>();

afterEach(async () => {
  for (const key of registeredToolKeys) unregisterToolImplementation(key);
  registeredToolKeys.clear();
  await cleanup?.();
  container = undefined;
  cleanup = undefined;
});

describe("TypeScript runtime", () => {
  it("executes queued Runs with its in-process Worker pool", async () => {
    const test = await testContainer({ startWorker: true, runConcurrency: 2 });
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([assistantMessage("Worker pool completed")]),
    ]);
    const fixture = await publishedAgent(container, { model });
    const created = await container.runner.create({
      deploymentId: fixture.version.id,
      input: "Execute locally",
    });
    let run = await container.runner.get(created.id);
    for (
      let attempt = 0;
      attempt < 100 && run.status !== "completed";
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      run = await container.runner.get(created.id);
    }
    expect(run.status, JSON.stringify(run.error_json)).toBe("completed");
  });

  it("runs through OpenAI Agents SDK with durable local JSONB state", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([assistantMessage("Hello from Omoikane")]),
    ]);
    const fixture = await publishedAgent(container, { model });
    const created = await container.runner.create({
      deploymentId: fixture.version.id,
      externalSessionId: "business-session-1",
      conversation: [
        { role: "user", content: "Previous business-owned message" },
      ] as never[],
      input: "Hello",
    });
    expect(await container.runner.processNext()).toBe(true);
    const run = await container.runner.get(created.id);
    expect(run.status).toBe("completed");
    expect(run.input_json).toBe("Hello");
    expect(run.conversation_json).toHaveLength(1);
    expect(run.context_json).toEqual({});
    expect(run).not.toHaveProperty("encrypted_payload");
    const publicRun = await container.runner.publicRun(created.id);
    expect(publicRun.output).toBe("Hello from Omoikane");
    expect(publicRun.new_items).toEqual(expect.any(Array));
    expect((publicRun.new_items as Record<string, unknown>[])[0]).toMatchObject(
      { type: "message", role: "assistant" },
    );
    expect(
      (publicRun.new_items as Record<string, unknown>[])[0],
    ).not.toHaveProperty("rawItem");
    expect(publicRun).not.toHaveProperty("input_json");
    expect(model.calls).toHaveLength(1);
    const eventTypes = (await container.events.list(created.id)).map(
      (event) => event.type,
    );
    expect(eventTypes).toContain("run.completed");
    expect(eventTypes).toContain("usage.updated");
    expect(run.usage_json).toMatchObject({
      reporting_status: "missing",
      requests: 1,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
    });
    const usage = await container.usage.forRun(created.id);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      reporting_status: "missing",
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
    });
    expect(eventTypes.filter((type) => type.startsWith("memory."))).toEqual([]);
    const removedTables = await container.db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('memories','sessions','context_projections')",
    );
    expect(removedTables.rows).toEqual([]);
  }, 30_000);

  it("persists an approval interruption and resumes the serialized RunState", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const implementationKey = `test.approval.${crypto.randomUUID()}`;
    const toolSlug = `approval-action-${crypto.randomUUID().slice(0, 8)}`;
    registerToolImplementation(implementationKey, async (args) => ({
      accepted: args.value,
    }));
    registeredToolKeys.add(implementationKey);
    await container.tools.create({
      slug: toolSlug,
      name: "approval_action",
      description: "Perform one test action after approval",
      implementation_key: implementationKey,
      schema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      policy: { requires_approval: true, side_effecting: true },
    });
    const model = new ScriptedModel([
      modelResponse([
        functionCall(
          "approval_action",
          { value: "approved-value" },
          { callId: "approval-call-1" },
        ),
      ]),
      modelResponse([assistantMessage("Action completed after approval")]),
    ]);
    const fixture = await publishedAgent(container, {
      model,
      tools: [toolSlug],
    });
    const created = await container.runner.create({
      deploymentId: fixture.version.id,
      input: "Perform the approval-gated action",
    });
    await container.runner.processNext();
    const interrupted = await container.runner.get(created.id);
    expect(interrupted.status, JSON.stringify(interrupted.error_json)).toBe(
      "waiting_approval",
    );
    const approvals = await container.db.query<Record<string, unknown>>(
      "SELECT * FROM approvals WHERE run_id=$1",
      [created.id],
    );
    expect(approvals.rows).toHaveLength(1);
    expect(await container.tools.executions(created.id)).toHaveLength(0);
    await container.runner.decideApproval(
      String(approvals.rows[0]!.id),
      "approved",
    );
    await container.runner.processNext();
    const completed = await container.runner.publicRun(created.id);
    expect(completed.status).toBe("completed");
    expect(completed.output).toBe("Action completed after approval");
    const executions = await container.tools.executions(created.id);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      tool_name: "approval_action",
      status: "completed",
      output_json: { accepted: "approved-value" },
    });
    expect(model.calls).toHaveLength(2);
    const usage = await container.usage.forRun(created.id);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      reporting_status: "missing",
      requests: 2,
      total_tokens: null,
    });
  }, 30_000);

  it("records Provider-reported Usage without estimating money", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse({
        output: [assistantMessage("Usage recorded")],
        usage: new Usage({
          requests: 1,
          inputTokens: 90,
          outputTokens: 10,
          totalTokens: 100,
          inputTokensDetails: [{ cached_tokens: 25 }],
          outputTokensDetails: [{ reasoning_tokens: 4 }],
        }),
        rawUsage: {
          input_tokens: 90,
          output_tokens: 10,
          total_tokens: 100,
        },
      }),
    ]);
    const fixture = await publishedAgent(container, { model });
    const created = await container.runner.create({
      deploymentId: fixture.version.id,
      input: "Record Usage",
    });

    await container.runner.processNext();

    const run = await container.runner.get(created.id);
    expect(run.status).toBe("completed");
    expect(run.usage_json).toMatchObject({
      reporting_status: "reported",
      requests: 1,
      input_tokens: 90,
      output_tokens: 10,
      total_tokens: 100,
      input_tokens_details: [{ cached_tokens: 25 }],
      output_tokens_details: [{ reasoning_tokens: 4 }],
    });
    expect(run.usage_json).not.toHaveProperty("estimated_cost");
    expect(run.usage_json).not.toHaveProperty("currency");
  });

  it("rejects monetary Run and Agent controls", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const fixture = await publishedAgent(container);

    await expect(
      container.runner.create({
        deploymentId: fixture.version.id,
        input: "Do not price this Run",
        limits: { max_cost_usd: 1 },
      }),
    ).rejects.toThrow("max_cost_usd is not supported");

    await expect(
      container.definitions.deploy({
        config: {
          name: "Priced Agent",
          instructions: "Should be rejected",
          provider: { connection_id: fixture.connection.id },
          model: "mimo-v2.5",
          pricing: { input_per_million: 1 },
        },
      }),
    ).rejects.toThrow("pricing is not supported");

    await expect(
      container.definitions.deploy({
        config: {
          name: "Per-Agent Tracing",
          instructions: "Should be rejected",
          provider: { connection_id: fixture.connection.id },
          model: "mimo-v2.5",
          tracing: { enabled: true },
        },
      }),
    ).rejects.toThrow("tracing is configured once for the Runtime");

    const app = await createApp(container);
    const response = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { "idempotency-key": crypto.randomUUID() },
      payload: {
        deployment_id: fixture.version.id,
        input: "Reject legacy cost limit",
        limits: { max_cost_usd: 1 },
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toContain(
      "max_cost_usd is not supported",
    );
    await app.close();
  });

  it("rolls back run event and sequence atomically", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const fixture = await publishedAgent(container);
    const run = await container.runner.create({
      deploymentId: fixture.version.id,
      input: "test",
    });
    const before = await container.runner.get(run.id);
    await expect(
      container.db.transaction(async (tx) => {
        await container!.events.appendInTransaction(tx, run.id, "atomic.test", {
          value: 1,
        });
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");
    const after = await container.runner.get(run.id);
    expect(after.version).toBe(before.version);
    expect(
      (await container.events.list(run.id)).filter(
        (event) => event.type === "atomic.test",
      ),
    ).toHaveLength(0);
  });

  it("does not pass Runtime credentials into process Sandbox commands", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const sandbox = await container.sandbox.create({ runId: "env-boundary" });
    try {
      const result = await container.sandbox.execute(
        sandbox,
        process.execPath,
        [
          "-e",
          "process.stdout.write(JSON.stringify({provider:process.env.MIMO_API_KEY,credential:process.env.AGENT_CREDENTIAL_SECRET,marker:process.env.OMOIKANE_SANDBOX}))",
        ],
      );
      expect(result.exit_code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ marker: "process" });
    } finally {
      await container.sandbox.destroy(sandbox);
    }
  });

  it("keeps durable control state while purging expired execution payloads", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([assistantMessage("sensitive result")]),
    ]);
    const fixture = await publishedAgent(container, { model });
    const run = await container.runner.create({
      deploymentId: fixture.version.id,
      input: "sensitive input",
      context: { business_secret: "do-not-retain" },
    });
    await container.runner.processNext();
    await container.db.query(
      `INSERT INTO approvals(id,run_id,interruption_id,tool_name,request_json,status,decision_reason)
       VALUES($1,$2,$3,$4,$5::jsonb,'approved',$6)`,
      [
        "expired-approval",
        run.id,
        "expired-interruption",
        "sensitive_tool",
        JSON.stringify({ secret: "approval-secret" }),
        "sensitive decision",
      ],
    );
    const artifact = await container.artifacts.create(
      "temporary.txt",
      Buffer.from("temporary artifact"),
      { runId: run.id, mimeType: "text/plain" },
    );
    await container.db.query(
      "UPDATE runs SET execution_expires_at=now()-interval '1 second',error_json=$2::jsonb WHERE id=$1",
      [run.id, JSON.stringify({ message: "sensitive error" })],
    );
    await container.db.query(
      "UPDATE run_events SET created_at=now()-interval '8 days' WHERE run_id=$1",
      [run.id],
    );
    await container.db.query(
      "UPDATE artifacts SET expires_at=now()-interval '1 second' WHERE id=$1",
      [artifact.id],
    );

    await container.runner.reap();

    const retained = await container.runner.get(run.id);
    expect(retained).toMatchObject({
      id: run.id,
      deployment_id: fixture.version.id,
      status: "completed",
      input_json: null,
      output_json: null,
      error_json: null,
    });
    expect(retained.payload_purged_at).toBeTruthy();
    expect(await container.runner.publicRun(run.id)).not.toHaveProperty(
      "output",
    );
    const approval = (
      await container.db.query<Record<string, unknown>>(
        "SELECT request_json,decision_reason FROM approvals WHERE id=$1",
        ["expired-approval"],
      )
    ).rows[0];
    expect(approval).toMatchObject({ request_json: {}, decision_reason: null });
    expect((await container.usage.forRun(run.id))[0]?.raw_json).toEqual({});
    expect(await container.events.list(run.id)).toEqual([]);
    await expect(container.artifacts.get(artifact.id)).rejects.toThrow(
      "artifact not found",
    );
  }, 30_000);

  it("exposes the TypeScript/npm runtime contract through REST", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const app = await createApp(container);
    const version = await app.inject({ method: "GET", url: "/version" });
    expect(version.statusCode).toBe(200);
    expect(version.json()).toMatchObject({
      name: "omoikane-runtime",
      language: "TypeScript",
      distribution: "npm",
    });
    const capabilities = await app.inject({
      method: "GET",
      url: "/v1/capabilities",
    });
    expect(capabilities.json().features).toMatchObject({
      durable_runs: true,
      external_conversation_state: true,
      approvals: true,
      input_output_guardrails: true,
      pluggable_guardrails: true,
      buffered_output_guardrails: true,
      context_compaction: true,
      sandbox: false,
      run_usage: true,
      resource_limits: true,
    });
    expect(capabilities.json().features).not.toHaveProperty(
      "run_usage_and_budget",
    );
    expect(capabilities.json().features).not.toHaveProperty("long_term_memory");
    expect(capabilities.json()).not.toHaveProperty("runtime_generation");
    const allowedPreflight = await app.inject({
      method: "OPTIONS",
      url: "/v1/runs",
      headers: { origin: "http://localhost:3000" },
    });
    expect(allowedPreflight.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3000",
    );
    expect(
      allowedPreflight.headers["access-control-allow-headers"],
    ).not.toMatch(/Tenant|Actor|Authorization/i);
    const blockedPreflight = await app.inject({
      method: "OPTIONS",
      url: "/v1/runs",
      headers: { origin: "https://untrusted.example" },
    });
    expect(blockedPreflight.headers).not.toHaveProperty(
      "access-control-allow-origin",
    );
    for (const request of [
      { method: "GET", url: "/v1/memories" },
      {
        method: "POST",
        url: "/v1/memories",
        payload: {
          scope_type: "global",
          scope_id: "global",
          content: "must not be stored",
        },
      },
      { method: "PATCH", url: "/v1/memories/legacy-id", payload: {} },
      { method: "GET", url: "/v1/memories/legacy-id" },
      { method: "DELETE", url: "/v1/memories/legacy-id" },
      { method: "GET", url: "/v1/sessions" },
      { method: "POST", url: "/v1/sessions", payload: {} },
      { method: "GET", url: "/v1/agent-settings" },
      { method: "GET", url: "/v1/project-releases" },
      { method: "GET", url: "/v1/webhook-subscriptions" },
      { method: "GET", url: "/v1/costs" },
    ] as const) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(404);
    }
    expect(() =>
      container!.definitions.validate({
        apiVersion: "agentsdk/v1",
        kind: "Agent",
        instructions: "Test",
        spec: { memory: { enabled: true } },
      }),
    ).toThrow("memory is not supported");
    const deployment = await container.definitions.deploy({
      config: { name: "deployed", instructions: "test" },
    });
    expect(deployment).toMatchObject({
      kind: "agent_deployment",
      status: "active",
    });
    await expect(
      container.tools.create({
        slug: "legacy-memory-search",
        name: "memory_search",
        description: "legacy tool",
        implementation_key: "builtin.memory_search",
      }),
    ).rejects.toThrow("built-in memory tools were removed");
    await container.db.query(
      `INSERT INTO resources(id,kind,slug,name,data)
       VALUES($1,'tool',$2,$3,$4::jsonb)`,
      [
        "legacy-memory-tool",
        "legacy-memory-create",
        "memory_create",
        JSON.stringify({
          implementation_key: "builtin.memory_create",
          description: "legacy tool from an upgraded database",
          schema: { type: "object", properties: {} },
          policy: {},
        }),
      ],
    );
    expect(await container.tools.list()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "legacy-memory-tool" }),
      ]),
    );
    await expect(
      container.tools.resolve(["legacy-memory-create"]),
    ).rejects.toThrow("tool not found");
    await app.close();
  });
});
