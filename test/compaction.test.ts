import { afterEach, describe, expect, it } from "vitest";
import {
  ScriptedModel,
  assistantMessage,
  modelResponse,
} from "@openai/agents/testing";
import type { Container } from "../src/container.js";
import { ValidationError } from "../src/database.js";
import { publishedAgent, testContainer } from "./helpers.js";

let container: Container | undefined;
let cleanup: (() => Promise<void>) | undefined;

const validSummary = {
  active_task: "Continue the current conversation task.",
  goal: "Preserve all required conversation facts.",
  decisions: [
    {
      text: "The business system owns the canonical transcript",
      source_refs: [0],
    },
  ],
  open_questions: [],
  constraints: [
    {
      text: "Omoikane returns a projection without storing a session",
      source_refs: [0],
    },
  ],
  completed_actions: [],
  current_state: [],
  errors: [],
  artifacts: [],
  critical_facts: [],
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

describe("external context compaction", () => {
  it("uses native Responses compaction for Codex Bridge and preserves the opaque item", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const fixture = await publishedAgent(container, {
      provider: "codex_bridge",
      modelId: "gpt-5.6-sol",
    });
    const items = [
      {
        role: "user",
        content: [{ type: "input_text", text: "Remember NATIVE-7429." }],
      },
      {
        role: "assistant",
        content: [
          { type: "output_text", text: "assistant history ".repeat(8_000) },
        ],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: "Continue the task." }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "more assistant history ".repeat(4_000),
          },
        ],
      },
    ] as Array<Record<string, unknown>>;
    container.providers.compactResponses = async () => ({
      id: "resp_compact_test",
      object: "response.compaction",
      output: [
        { type: "message", ...items[0] },
        { type: "message", ...items[2] },
        {
          id: "cmp_test",
          type: "compaction",
          encrypted_content: `opaque-${"x".repeat(512)}`,
        },
      ],
      usage: { input_tokens: 42_000, output_tokens: 512, total_tokens: 42_512 },
    });
    const resolved = await container.providers.resolveConfig({
      ...((fixture.version.config ?? {}) as Record<string, unknown>),
      model_context_window: 100_000,
      compaction: { enabled: true, strategy: "auto" },
    });
    const compacted = await container.compaction.compact(
      items as never[],
      resolved,
      { force: true },
    );
    expect(compacted).toMatchObject({
      status: "completed",
      strategy: "native",
      metrics_json: {
        implementation: "responses_compact_v4",
        provider_response_id: "resp_compact_test",
        compaction_item_count: 1,
        retained_user_message_count: 2,
      },
    });
    const projection = compacted.projection!;
    expect(projection.items.map((item) => (item as any).type)).toEqual([
      "message",
      "message",
      "compaction",
    ]);
    expect((projection.items.at(-1) as any).encrypted_content).toMatch(
      /^opaque-/,
    );
    expect(projection.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(projection.validation.semantic_risk).toMatchObject({
      assurance: "degraded",
      recommended_action: "continue_with_business_validation",
      risk_reasons: expect.arrayContaining(["opaque_provider_checkpoint"]),
      evaluation_key: {
        provider: "codex_bridge",
        model: "gpt-5.6-sol",
        protocol: "responses",
        strategy: "native",
        projection_version: 4,
      },
    });
    const otherConnection = await container.providers.create({
      name: "Other Codex Bridge credential",
      provider: "codex_bridge",
      api_key: "different-test-only-key",
    });
    const otherConfig = await container.providers.resolveConfig({
      ...((fixture.version.config ?? {}) as Record<string, unknown>),
      provider: { connection_id: otherConnection.id },
      model: "gpt-5.6-sol",
    });
    expect(() =>
      container!.compaction.validateProjection(
        projection as never,
        otherConfig,
      ),
    ).toThrow("different provider, endpoint, or model");
  });

  it("falls back to portable compaction when auto native compaction is unavailable", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([assistantMessage(JSON.stringify(validSummary))]),
    ]);
    const fixture = await publishedAgent(container, {
      provider: "codex_bridge",
      modelId: "gpt-5.6-sol",
      model,
    });
    container.providers.compactResponses = async () => {
      throw Object.assign(new Error("native endpoint unavailable"), {
        status: 404,
        code: "CODEX_COMPACTION_UNAVAILABLE",
      });
    };
    const resolved = await container.providers.resolveConfig({
      ...((fixture.version.config ?? {}) as Record<string, unknown>),
      model_context_window: 100_000,
      compaction: {
        enabled: true,
        strategy: "auto",
        preserve_recent_tokens: 500,
      },
    });
    const compacted = await container.compaction.compact(
      historyItems(8, 400) as never[],
      resolved,
      { force: true },
    );
    expect(compacted).toMatchObject({
      status: "completed",
      strategy: "portable",
      metrics_json: {
        implementation: "portable_checkpoint_v4",
        requested_strategy: "auto",
        native_fallback: "CODEX_COMPACTION_UNAVAILABLE",
      },
    });
  });

  it("rejects explicit native compaction for an unsupported Provider", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const fixture = await publishedAgent(container);
    const resolved = await container.providers.resolveConfig({
      ...((fixture.version.config ?? {}) as Record<string, unknown>),
      model_context_window: 100_000,
      compaction: { enabled: true, strategy: "native" },
    });
    await expect(
      container.compaction.compact(historyItems(8, 400) as never[], resolved, {
        force: true,
      }),
    ).rejects.toThrow("does not support native Responses compaction");
  });

  it("returns a checksummed projection without writing session state", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([assistantMessage(JSON.stringify(validSummary))]),
      modelResponse([assistantMessage("continued from projection v4")]),
    ]);
    const fixture = await publishedAgent(container, { model });
    const items = historyItems(8, 400);
    const resolved = await container.providers.resolveConfig({
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
      items as never[],
      resolved,
      { force: true },
    );
    expect(compacted.status).toBe("completed");
    const projection = compacted.projection!;
    expect(projection.items.length).toBeLessThan(items.length);
    expect(JSON.stringify(projection.items[0])).toContain("context_checkpoint");
    expect(projection.checksum).toMatch(/^[a-f0-9]{64}$/);
    const run = await container.runner.create({
      deploymentId: fixture.version.id,
      projection: projection as unknown as Record<string, unknown>,
      input: "Continue from the full projection",
    });
    expect(run.projection_json).toMatchObject({
      version: 4,
      id: projection.id,
    });
    expect(run.conversation_json).toEqual(projection.items);
    await container.runner.processNext();
    expect(await container.runner.publicRun(run.id)).toMatchObject({
      status: "completed",
      output: "continued from projection v4",
      projection: { version: 4, id: projection.id },
    });
    const removedStateTables = await container.db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('sessions','context_projections','compactions')",
    );
    expect(removedStateTables.rows).toEqual([]);
  });

  it("evaluates current input against the same high watermark", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const fixture = await publishedAgent(container);
    const config = await container.providers.resolveConfig({
      ...((fixture.version.config ?? {}) as Record<string, unknown>),
      model_context_window: 5_000,
      compaction: {
        enabled: true,
        high_watermark_ratio: 0.6,
        low_watermark_ratio: 0.5,
      },
    });
    const items = historyItems(4, 40) as never[];
    expect(
      (await container.compaction.evaluate(items, config)).should_compact,
    ).toBe(false);
    expect(
      (
        await container.compaction.evaluate(
          items,
          config,
          "current input ".repeat(600),
        )
      ).should_compact,
    ).toBe(true);
  });

  it("automatically compacts a Run conversation and returns the projection", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([assistantMessage(JSON.stringify(validSummary))]),
      modelResponse([assistantMessage("continued after compaction")]),
    ]);
    const fixture = await publishedAgent(container, {
      model,
      modelContextWindow: 5_000,
      compaction: {
        enabled: true,
        high_watermark_ratio: 0.6,
        low_watermark_ratio: 0.5,
        preserve_recent_tokens: 64,
        max_checkpoint_tokens: 128,
        safety_margin_tokens: 32,
      },
    });
    const run = await container.runner.create({
      deploymentId: fixture.version.id,
      conversation: historyItems(4, 100) as never[],
      input: "Continue with this current payload ".repeat(80),
    });
    await container.runner.processNext();
    const completed = await container.runner.publicRun(run.id);
    expect(completed.status, JSON.stringify(completed.error_json)).toBe(
      "completed",
    );
    expect(completed.projection).toMatchObject({ version: 4 });
    expect(
      (await container.events.list(run.id)).map((event) => event.type),
    ).toContain("context.compacted");
  });

  it("skips below the high watermark", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const fixture = await publishedAgent(container);
    const config = await container.providers.resolveConfig({
      ...((fixture.version.config ?? {}) as Record<string, unknown>),
      model_context_window: 100_000,
      compaction: { enabled: true },
    });
    const result = await container.compaction.compact(
      historyItems(4, 2) as never[],
      config,
    );
    expect(result.status).toBe("skipped");
  });

  it("repairs malformed provider JSON once", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([assistantMessage("not-json")]),
      modelResponse([assistantMessage(JSON.stringify(validSummary))]),
    ]);
    const fixture = await publishedAgent(container, { model });
    const config = await container.providers.resolveConfig({
      ...((fixture.version.config ?? {}) as Record<string, unknown>),
      model_context_window: 100_000,
      compaction: { enabled: true },
    });
    await expect(
      container.compaction.compact(historyItems(6, 100) as never[], config, {
        force: true,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      metrics_json: { summary_validation_retries: 1 },
    });
  });

  it("rejects malformed provider JSON after one bounded repair", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([assistantMessage("not-json")]),
      modelResponse([assistantMessage("still-not-json")]),
    ]);
    const fixture = await publishedAgent(container, { model });
    const config = await container.providers.resolveConfig({
      ...((fixture.version.config ?? {}) as Record<string, unknown>),
      model_context_window: 100_000,
      compaction: { enabled: true },
    });
    await expect(
      container.compaction.compact(historyItems(6, 100) as never[], config, {
        force: true,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects ineffective checkpoints", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([
        assistantMessage(
          JSON.stringify({
            ...validSummary,
            critical_facts: [
              {
                text: "larger summary ".repeat(100),
                source_refs: [0],
              },
            ],
          }),
        ),
      ]),
    ]);
    const fixture = await publishedAgent(container, { model });
    const config = await container.providers.resolveConfig({
      ...((fixture.version.config ?? {}) as Record<string, unknown>),
      model_context_window: 100_000,
      compaction: { enabled: true },
    });
    await expect(
      container.compaction.compact(historyItems(4, 2) as never[], config, {
        force: true,
      }),
    ).rejects.toThrow("ineffective");
  });

  it("chains repeated portable checkpoints with explicit lineage", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const inheritedSummary = {
      ...validSummary,
      decisions: validSummary.decisions.map((fact) => ({
        ...fact,
        source_refs: [11],
      })),
      constraints: validSummary.constraints.map((fact) => ({
        ...fact,
        source_refs: [11],
      })),
    };
    const model = new ScriptedModel([
      modelResponse([assistantMessage(JSON.stringify(inheritedSummary))]),
      modelResponse([assistantMessage(JSON.stringify(inheritedSummary))]),
    ]);
    const fixture = await publishedAgent(container, { model });
    const config = await container.providers.resolveConfig({
      ...((fixture.version.config ?? {}) as Record<string, unknown>),
      model_context_window: 50_000,
      compaction: { enabled: true, preserve_recent_tokens: 0 },
    });
    const firstItems = [
      ...historyItems(10, 300),
      {
        type: "function_call",
        call_id: "call-inherited-17",
        name: "verify",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call-inherited-17",
        output: "completed",
      },
    ];
    const first = await container.compaction.compact(
      firstItems as never[],
      config,
      { force: true, strategy: "portable" },
    );
    const second = await container.compaction.compact(
      [...first.projection!.items, ...historyItems(6, 300)] as never[],
      config,
      {
        force: true,
        strategy: "portable",
        sourceProjection: first.projection as never,
      },
    );
    expect(second.projection).toMatchObject({ version: 4, revision: 2 });
    expect(second.projection!.checkpoint).toMatchObject({
      generation: 2,
      parent_checkpoint_id: first.projection!.checkpoint!.checkpoint_id,
      semantic: {
        decisions: [{ source_refs: [11] }],
      },
      anchors: expect.arrayContaining([
        expect.objectContaining({
          kind: "call_id",
          value: "call-inherited-17",
          source_refs: [10],
        }),
      ]),
      tool_ledger: expect.arrayContaining([
        expect.objectContaining({
          call_id: "call-inherited-17",
          status: "completed",
          source_refs: [10, 11],
        }),
      ]),
    });
    expect(second.projection!.validation.semantic_risk).toMatchObject({
      assurance: "insufficient",
      recommended_action: "request_source_items",
      risk_reasons: expect.arrayContaining([
        "lossy_model_generated_checkpoint",
        "repeated_compaction_can_accumulate_loss",
        "deterministic_evidence_capacity_exceeded",
      ]),
    });
    expect(second.metrics_json).toMatchObject({
      evidence_capacity_exceeded: true,
    });
  });

  it("does not hide native authentication failures behind portable fallback", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const fixture = await publishedAgent(container, {
      provider: "codex_bridge",
      modelId: "gpt-5.6-sol",
    });
    container.providers.compactResponses = async () => {
      throw Object.assign(new Error("unauthorized"), { status: 401 });
    };
    const config = await container.providers.resolveConfig({
      ...((fixture.version.config ?? {}) as Record<string, unknown>),
      model_context_window: 100_000,
      compaction: { enabled: true, strategy: "auto" },
    });
    await expect(
      container.compaction.compact(historyItems(8, 400) as never[], config, {
        force: true,
      }),
    ).rejects.toThrow("unauthorized");
  });

  it("treats a zero recent-tail budget as compact-all rather than no capacity", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([assistantMessage(JSON.stringify(validSummary))]),
    ]);
    const fixture = await publishedAgent(container, { model });
    const config = await container.providers.resolveConfig({
      ...((fixture.version.config ?? {}) as Record<string, unknown>),
      model_context_window: 100_000,
      compaction: { enabled: true, preserve_recent_tokens: 0 },
    });
    const result = await container.compaction.compact(
      historyItems(8, 300) as never[],
      config,
      { force: true, strategy: "portable" },
    );
    expect(result.status).toBe("completed");
    expect(result.metrics_json).toMatchObject({ tail_unit_count: 0 });
    expect(result.projection!.items).toHaveLength(1);
  });
});
