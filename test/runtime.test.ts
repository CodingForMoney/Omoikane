import { afterEach, describe, expect, it } from "vitest";
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponse,
} from "@openai/agents/testing";
import type { Container } from "../src/container.js";
import { createApp } from "../src/api.js";
import { publishedAgent, testContainer } from "./helpers.js";

let container: Container | undefined;
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  container = undefined;
  cleanup = undefined;
});

describe("TypeScript runtime", () => {
  it("runs through OpenAI Agents SDK and durably restores a conversation", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([assistantMessage("Hello from Omoikane")]),
    ]);
    const fixture = await publishedAgent(container, { model });
    const session = await container.sessions.create(fixture.tenantId, {
      agent_version_id: fixture.version.id,
    });
    const created = await container.runner.create({
      tenantId: fixture.tenantId,
      agentVersionId: fixture.version.id,
      sessionId: session.id,
      input: "Hello",
    });
    expect(await container.runner.processNext()).toBe(true);
    const run = await container.runner.get(fixture.tenantId, created.id);
    expect(run.status).toBe("completed");
    expect(run.output_json).toBe("Hello from Omoikane");
    expect(model.calls).toHaveLength(1);
    const raw = await container.sessions.rawItems(session.id);
    expect(raw.length).toBeGreaterThanOrEqual(2);
    const chat = await container.sessions.chatMessages(session.id);
    expect(chat.map((message) => message.content)).toEqual([
      "Hello",
      "Hello from Omoikane",
    ]);
    const eventTypes = (await container.events.list(created.id)).map(
      (event) => event.type,
    );
    expect(eventTypes).toContain("run.completed");
    expect(eventTypes).toContain("usage.updated");
  }, 30_000);

  it("persists an approval interruption and resumes the serialized RunState", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([
        functionCall(
          "memory_create",
          { content: "The project codename is Omoikane" },
          { callId: "memory-call-1" },
        ),
      ]),
      modelResponse([assistantMessage("Memory saved after approval")]),
    ]);
    const fixture = await publishedAgent(container, {
      model,
      tools: ["memory-create"],
    });
    const created = await container.runner.create({
      tenantId: fixture.tenantId,
      agentVersionId: fixture.version.id,
      input: "Remember the codename",
    });
    await container.runner.processNext();
    const interrupted = await container.runner.get(
      fixture.tenantId,
      created.id,
    );
    expect(interrupted.status, JSON.stringify(interrupted.error_json)).toBe(
      "waiting_approval",
    );
    const approvals = await container.db.query<Record<string, unknown>>(
      "SELECT * FROM approvals WHERE run_id=$1",
      [created.id],
    );
    expect(approvals.rows).toHaveLength(1);
    expect(
      await container.memory.list(fixture.tenantId, { scope_type: "agent" }),
    ).toHaveLength(0);
    await container.runner.decideApproval(
      fixture.tenantId,
      String(approvals.rows[0]!.id),
      "approved",
      "reviewer",
    );
    await container.runner.processNext();
    const completed = await container.runner.get(fixture.tenantId, created.id);
    expect(completed.status).toBe("completed");
    expect(completed.output_json).toBe("Memory saved after approval");
    expect(
      await container.memory.list(fixture.tenantId, { scope_type: "agent" }),
    ).toHaveLength(1);
    expect(model.calls).toHaveLength(2);
  }, 30_000);

  it("rolls back run event, sequence, and webhook delivery atomically", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const fixture = await publishedAgent(container);
    const run = await container.runner.create({
      tenantId: fixture.tenantId,
      agentVersionId: fixture.version.id,
      input: "test",
    });
    await container.resources.create({
      tenantId: fixture.tenantId,
      kind: "webhook_subscription",
      name: "test webhook",
      data: {},
    });
    await container.db.query(
      "INSERT INTO webhook_subscriptions(id,tenant_id,name,url,secret_ciphertext,secret_checksum,event_types_json) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
      [
        "wh_test",
        fixture.tenantId,
        "test",
        "https://example.invalid",
        Buffer.from("x"),
        "x",
        JSON.stringify(["atomic.test"]),
      ],
    );
    const before = await container.runner.get(fixture.tenantId, run.id);
    await expect(
      container.db.transaction(async (tx) => {
        await container!.events.appendInTransaction(tx, run.id, "atomic.test", {
          value: 1,
        });
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");
    const after = await container.runner.get(fixture.tenantId, run.id);
    expect(after.version).toBe(before.version);
    expect(
      (await container.events.list(run.id)).filter(
        (event) => event.type === "atomic.test",
      ),
    ).toHaveLength(0);
    expect(
      (
        await container.db.query(
          "SELECT * FROM webhook_deliveries WHERE event_id IN (SELECT id FROM run_events WHERE run_id=$1 AND type='atomic.test')",
          [run.id],
        )
      ).rows,
    ).toHaveLength(0);
  });

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
      sessions: true,
      approvals: true,
      context_compaction: true,
      sandbox: true,
    });
    await app.close();
  });
});
