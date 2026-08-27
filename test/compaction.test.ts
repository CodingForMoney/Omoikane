import { afterEach, describe, expect, it } from "vitest";
import {
  ScriptedModel,
  assistantMessage,
  modelResponse,
  modelResponder,
} from "@openai/agents/testing";
import type { Container } from "../src/container.js";
import { createApp } from "../src/api.js";
import { ConflictError, ValidationError } from "../src/database.js";
import { publishedAgent, testContainer } from "./helpers.js";

let container: Container | undefined;
let cleanup: (() => Promise<void>) | undefined;

const validSummary = {
  summary: "The checkpoint preserves the relevant conversation facts.",
  decisions: ["Keep canonical history"],
  open_questions: [],
  constraints: ["Do not invent facts"],
  artifacts: [],
};

const historyItems = (count: number, repeats = 100) =>
  Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: [
      {
        type: index % 2 === 0 ? "input_text" : "output_text",
        text: `Message ${index}: ${"important context ".repeat(repeats)}`,
      },
    ],
  }));

afterEach(async () => {
  await cleanup?.();
  container = undefined;
  cleanup = undefined;
});

describe("context compaction", () => {
  it("creates a reversible projection without deleting canonical history", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const summary = {
      summary: "The user selected TypeScript and npm for the entire runtime.",
      decisions: ["No Python runtime remains"],
      open_questions: [],
      constraints: ["Preserve canonical history"],
      artifacts: ["AGENT.md"],
    };
    const model = new ScriptedModel([
      modelResponse([assistantMessage(JSON.stringify(summary))]),
    ]);
    const fixture = await publishedAgent(container, { model });
    const session = await container.sessions.create(fixture.tenantId);
    const items = Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: [
        {
          type: index % 2 === 0 ? "input_text" : "output_text",
          text: `Message ${index}: ${"important context ".repeat(400)}`,
        },
      ],
    }));
    await container.sessions.appendTransactional(session.id, items as never);
    const rawBefore = await container.sessions.rawItems(session.id);
    const resolved = await container.providers.resolveConfig(fixture.tenantId, {
      ...((fixture.version.config ?? {}) as Record<string, unknown>),
      model_context_window: 100_000,
      compaction: {
        enabled: true,
        high_watermark_ratio: 0.5,
        low_watermark_ratio: 0.3,
        preserve_recent_tokens: 500,
      },
    });
    const compacted = await container.compaction.compact(
      fixture.tenantId,
      session.id,
      resolved,
      { force: true },
    );
    expect(compacted.status).toBe("completed");
    expect(await container.sessions.rawItems(session.id)).toEqual(rawBefore);
    const effective = await container.sessions.effectiveItems(session.id);
    expect(effective.length).toBeLessThan(rawBefore.length);
    expect(JSON.stringify(effective[0])).toContain("context_checkpoint");
    const restored = await container.compaction.restore(
      fixture.tenantId,
      session.id,
      String(compacted.id),
    );
    expect(restored.restored).toBe(true);
  });

  it("uses the same current input decision and emits a real compaction event", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([assistantMessage(JSON.stringify(validSummary))]),
      modelResponse([assistantMessage("continued after compaction")]),
    ]);
    const compaction = {
      enabled: true,
      high_watermark_ratio: 0.6,
      low_watermark_ratio: 0.5,
      preserve_recent_tokens: 64,
      max_checkpoint_tokens: 128,
      safety_margin_tokens: 32,
    };
    const fixture = await publishedAgent(container, {
      model,
      compaction,
      modelContextWindow: 5_000,
    });
    const session = await container.sessions.create(fixture.tenantId, {
      agent_version_id: fixture.version.id,
    });
    await container.sessions.appendTransactional(
      session.id,
      historyItems(4, 60) as never,
    );
    const config = await container.providers.resolveConfig(fixture.tenantId, {
      ...((fixture.version.config ?? {}) as Record<string, unknown>),
    });
    const currentInput = "current input payload ".repeat(300);
    expect(
      (await container.compaction.evaluate(session.id, config)).should_compact,
    ).toBe(false);
    expect(
      (await container.compaction.evaluate(session.id, config, currentInput))
        .should_compact,
    ).toBe(true);

    const run = await container.runner.create({
      tenantId: fixture.tenantId,
      agentVersionId: fixture.version.id,
      sessionId: session.id,
      input: currentInput,
    });
    await container.runner.processNext();
    expect((await container.runner.get(fixture.tenantId, run.id)).status).toBe(
      "completed",
    );
    const events = await container.events.list(run.id);
    expect(
      events.filter((event) => event.type === "context.compacted"),
    ).toHaveLength(1);
    expect(model.calls).toHaveLength(2);
  }, 30_000);

  it("does not emit a compaction event below the high watermark", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([assistantMessage("no compaction needed")]),
    ]);
    const fixture = await publishedAgent(container, {
      model,
      modelContextWindow: 100_000,
      compaction: { enabled: true },
    });
    const session = await container.sessions.create(fixture.tenantId, {
      agent_version_id: fixture.version.id,
    });
    await container.sessions.appendTransactional(
      session.id,
      historyItems(4, 2) as never,
    );
    const run = await container.runner.create({
      tenantId: fixture.tenantId,
      agentVersionId: fixture.version.id,
      sessionId: session.id,
      input: "short input",
    });
    await container.runner.processNext();
    expect(
      (await container.events.list(run.id)).some(
        (event) => event.type === "context.compacted",
      ),
    ).toBe(false);
    expect(model.calls).toHaveLength(1);
  });

  it("defaults the manual API to a non-forced skipped compaction", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([]);
    const fixture = await publishedAgent(container, {
      model,
      modelContextWindow: 100_000,
      compaction: { enabled: true },
    });
    const session = await container.sessions.create(fixture.tenantId, {
      agent_version_id: fixture.version.id,
    });
    await container.sessions.appendTransactional(
      session.id,
      historyItems(4, 2) as never,
    );
    const app = await createApp(container);
    const response = await app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/compact`,
      headers: { "x-tenant-id": fixture.tenantId },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      compacted: false,
      compaction: { status: "skipped" },
    });
    expect(model.calls).toHaveLength(0);
    await app.close();
  });

  it("keeps the previous projection inactive when provider JSON is malformed", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([assistantMessage("this is not JSON")]),
    ]);
    const fixture = await publishedAgent(container, { model });
    const session = await container.sessions.create(fixture.tenantId);
    await container.sessions.appendTransactional(
      session.id,
      historyItems(4, 100) as never,
    );
    const raw = await container.sessions.rawItems(session.id);
    const config = await container.providers.resolveConfig(fixture.tenantId, {
      ...((fixture.version.config ?? {}) as Record<string, unknown>),
      model_context_window: 100_000,
      compaction: { enabled: true },
    });
    await expect(
      container.compaction.compact(fixture.tenantId, session.id, config, {
        force: true,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await container.sessions.rawItems(session.id)).toEqual(raw);
    expect(
      (await container.db.query("SELECT * FROM context_projections")).rows,
    ).toHaveLength(0);
  });

  it("invalidates projections after destructive session edits", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([assistantMessage(JSON.stringify(validSummary))]),
    ]);
    const fixture = await publishedAgent(container, { model });
    const session = await container.sessions.create(fixture.tenantId);
    await container.sessions.appendTransactional(
      session.id,
      historyItems(6, 100) as never,
    );
    const config = await container.providers.resolveConfig(fixture.tenantId, {
      ...((fixture.version.config ?? {}) as Record<string, unknown>),
      model_context_window: 100_000,
      compaction: { enabled: true, preserve_recent_tokens: 100 },
    });
    const compacted = await container.compaction.compact(
      fixture.tenantId,
      session.id,
      config,
      { force: true },
    );
    await container.sessions.pop(session.id);
    const updated = await container.sessions.get(fixture.tenantId, session.id);
    expect(updated.active_projection_revision).toBe(0);
    await expect(
      container.compaction.restore(
        fixture.tenantId,
        session.id,
        String(compacted.id),
      ),
    ).rejects.toThrow("invalidated");
    expect(
      JSON.stringify(await container.sessions.effectiveItems(session.id)),
    ).not.toContain("context_checkpoint");
  });

  it("invalidates projections when session history is cleared", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([assistantMessage(JSON.stringify(validSummary))]),
    ]);
    const fixture = await publishedAgent(container, { model });
    const session = await container.sessions.create(fixture.tenantId);
    await container.sessions.appendTransactional(
      session.id,
      historyItems(6, 100) as never,
    );
    const config = await container.providers.resolveConfig(fixture.tenantId, {
      ...((fixture.version.config ?? {}) as Record<string, unknown>),
      model_context_window: 100_000,
      compaction: { enabled: true, preserve_recent_tokens: 100 },
    });
    const compacted = await container.compaction.compact(
      fixture.tenantId,
      session.id,
      config,
      { force: true },
    );
    await container.sessions.clear(session.id);
    expect(
      (await container.sessions.get(fixture.tenantId, session.id))
        .active_projection_revision,
    ).toBe(0);
    expect(await container.sessions.effectiveItems(session.id)).toEqual([]);
    await expect(
      container.compaction.restore(
        fixture.tenantId,
        session.id,
        String(compacted.id),
      ),
    ).rejects.toThrow("invalidated");
  });

  it("falls back to canonical history and rejects restore on checksum mismatch", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([assistantMessage(JSON.stringify(validSummary))]),
    ]);
    const fixture = await publishedAgent(container, { model });
    const session = await container.sessions.create(fixture.tenantId);
    await container.sessions.appendTransactional(
      session.id,
      historyItems(6, 100) as never,
    );
    const raw = await container.sessions.rawItems(session.id);
    const config = await container.providers.resolveConfig(fixture.tenantId, {
      ...((fixture.version.config ?? {}) as Record<string, unknown>),
      model_context_window: 100_000,
      compaction: { enabled: true, preserve_recent_tokens: 100 },
    });
    const compacted = await container.compaction.compact(
      fixture.tenantId,
      session.id,
      config,
      { force: true },
    );
    await container.db.query(
      "UPDATE context_projections SET checksum='corrupted' WHERE compaction_id=$1",
      [compacted.id],
    );
    expect(await container.sessions.effectiveItems(session.id)).toEqual(
      raw.map((row) => row.item_json),
    );
    await expect(
      container.compaction.restore(
        fixture.tenantId,
        session.id,
        String(compacted.id),
      ),
    ).rejects.toThrow("checksum mismatch");
  });

  it("processes and hierarchically merges multiple chunks", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const responses = Array.from({ length: 16 }, () =>
      modelResponse([assistantMessage(JSON.stringify(validSummary))]),
    );
    const model = new ScriptedModel(responses);
    const fixture = await publishedAgent(container, { model });
    const session = await container.sessions.create(fixture.tenantId);
    await container.sessions.appendTransactional(
      session.id,
      historyItems(10, 1_000) as never,
    );
    const config = await container.providers.resolveConfig(fixture.tenantId, {
      ...((fixture.version.config ?? {}) as Record<string, unknown>),
      model_context_window: 12_000,
      compaction: {
        enabled: true,
        high_watermark_ratio: 0.8,
        low_watermark_ratio: 0.5,
        preserve_recent_tokens: 0,
        max_checkpoint_tokens: 256,
        safety_margin_tokens: 64,
      },
    });
    const compacted = (await container.compaction.compact(
      fixture.tenantId,
      session.id,
      config,
      { force: true },
    )) as Record<string, unknown>;
    const metrics = compacted.metrics_json as Record<string, unknown>;
    expect(Number(metrics.source_chunk_count)).toBeGreaterThan(1);
    expect(metrics.all_chunks_processed).toBe(true);
    expect(Number(metrics.merge_levels)).toBeGreaterThan(0);
    expect(metrics.projection_within_low_watermark).toBe(true);
  });

  it("losslessly retains facts from every partial summary when they fit", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const markers = Array.from({ length: 16 }, (_, index) => `PART-${index}`);
    const model = new ScriptedModel(
      markers.map((marker) =>
        modelResponse([
          assistantMessage(
            JSON.stringify({
              ...validSummary,
              summary: `Required distributed fact ${marker}`,
            }),
          ),
        ]),
      ),
    );
    const fixture = await publishedAgent(container, { model });
    const session = await container.sessions.create(fixture.tenantId);
    await container.sessions.appendTransactional(
      session.id,
      historyItems(12, 1_000) as never,
    );
    const config = await container.providers.resolveConfig(fixture.tenantId, {
      ...((fixture.version.config ?? {}) as Record<string, unknown>),
      model_context_window: 100_000,
      compaction: {
        enabled: true,
        preserve_recent_tokens: 0,
        max_checkpoint_tokens: 4_096,
      },
    });
    const compacted = (await container.compaction.compact(
      fixture.tenantId,
      session.id,
      config,
      { force: true },
    )) as Record<string, unknown>;
    const metrics = compacted.metrics_json as Record<string, unknown>;
    const chunkCount = Number(metrics.source_chunk_count);
    expect(chunkCount).toBeGreaterThan(1);
    expect(model.calls).toHaveLength(chunkCount);
    for (const marker of markers.slice(0, chunkCount))
      expect(String(compacted.summary_text)).toContain(marker);
  });

  it("rejects concurrent session changes without switching projection", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const model = new ScriptedModel([
      modelResponder(async () => {
        enteredResolve();
        await release;
        return [assistantMessage(JSON.stringify(validSummary))];
      }),
    ]);
    const fixture = await publishedAgent(container, { model });
    const session = await container.sessions.create(fixture.tenantId);
    await container.sessions.appendTransactional(
      session.id,
      historyItems(6, 100) as never,
    );
    const config = await container.providers.resolveConfig(fixture.tenantId, {
      ...((fixture.version.config ?? {}) as Record<string, unknown>),
      model_context_window: 100_000,
      compaction: { enabled: true, preserve_recent_tokens: 100 },
    });
    const compacting = container.compaction.compact(
      fixture.tenantId,
      session.id,
      config,
      { force: true },
    );
    await entered;
    await container.sessions.appendTransactional(
      session.id,
      historyItems(1, 2) as never,
    );
    releaseResolve();
    await expect(compacting).rejects.toBeInstanceOf(ConflictError);
    expect(
      (await container.db.query("SELECT * FROM context_projections")).rows,
    ).toHaveLength(0);
  });

  it("does not let force activate an ineffective checkpoint", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const huge = { ...validSummary, summary: "larger summary ".repeat(2_000) };
    const model = new ScriptedModel([
      modelResponse([assistantMessage(JSON.stringify(huge))]),
    ]);
    const fixture = await publishedAgent(container, { model });
    const session = await container.sessions.create(fixture.tenantId);
    await container.sessions.appendTransactional(
      session.id,
      historyItems(4, 2) as never,
    );
    const config = await container.providers.resolveConfig(fixture.tenantId, {
      ...((fixture.version.config ?? {}) as Record<string, unknown>),
      model_context_window: 100_000,
      compaction: { enabled: true },
    });
    await expect(
      container.compaction.compact(fixture.tenantId, session.id, config, {
        force: true,
      }),
    ).rejects.toThrow("ineffective");
    expect(
      (await container.db.query("SELECT * FROM context_projections")).rows,
    ).toHaveLength(0);
  });
});
