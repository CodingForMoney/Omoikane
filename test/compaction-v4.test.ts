import { describe, expect, it } from "vitest";
import {
  buildToolLedger,
  extractAnchors,
  extractUserExcerpts,
  itemContainsAnchor,
  planCompactionUnits,
  pruneToolResults,
  renderPortableCheckpointItem,
  parsePortableCheckpointItem,
  validateToolIntegrity,
} from "../src/compaction/items.js";
import { isContextOverflow } from "../src/compaction/runtime.js";
import {
  CompactionAwareModel,
  CompactionRunController,
} from "../src/compaction/runtime.js";
import type { AgentInputItem, Model, ModelRequest } from "@openai/agents";
import type { PortableCheckpointV4 } from "../src/compaction/types.js";
import { publishedAgent, testContainer } from "./helpers.js";

describe("compaction v4 invariants", () => {
  it("keeps a function call and its output in one atomic unit", () => {
    const items: AgentInputItem[] = [
      { role: "user", content: "inspect the file" },
      {
        type: "function_call",
        callId: "call-42",
        name: "read_file",
        arguments: '{"path":"/tmp/demo.txt"}',
      },
      {
        type: "function_call_result",
        callId: "call-42",
        name: "read_file",
        status: "completed",
        output: { type: "text", text: "contents" },
      },
      {
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "done" }],
      },
    ];
    const plan = planCompactionUnits(items);
    expect(plan.orphan_tool_results).toEqual([]);
    expect(plan.units[1]).toMatchObject({
      kind: "tool_transaction",
      from_index: 1,
      to_index: 2,
      unresolved_tool_call: false,
    });
    expect(validateToolIntegrity(plan.units[1]!.items)).toMatchObject({
      valid: true,
    });
  });

  it("keeps parallel function calls and their results in one atomic unit", () => {
    const items: AgentInputItem[] = [
      {
        type: "function_call",
        callId: "parallel-a",
        name: "fetch",
        arguments: '{"page":1}',
      },
      {
        type: "function_call",
        callId: "parallel-b",
        name: "fetch",
        arguments: '{"page":2}',
      },
      {
        type: "function_call_result",
        callId: "parallel-a",
        name: "fetch",
        status: "completed",
        output: "A",
      },
      {
        type: "function_call_result",
        callId: "parallel-b",
        name: "fetch",
        status: "completed",
        output: "B",
      },
    ];
    const plan = planCompactionUnits(items);
    expect(plan).toMatchObject({
      orphan_tool_results: [],
      units: [
        {
          kind: "tool_transaction",
          from_index: 0,
          to_index: 3,
          unresolved_tool_call: false,
        },
      ],
    });
    expect(validateToolIntegrity(items)).toEqual({
      valid: true,
      orphan_results: [],
      unresolved_calls: [],
    });
  });

  it("prunes only old or duplicate large tool results and keeps evidence", () => {
    const repeated = `RESULT-${"x".repeat(6_000)}`;
    const items: AgentInputItem[] = [
      { type: "function_call", callId: "a", name: "fetch", arguments: "{}" },
      {
        type: "function_call_result",
        callId: "a",
        name: "fetch",
        status: "completed",
        output: repeated,
      },
      { type: "function_call", callId: "b", name: "fetch", arguments: "{}" },
      {
        type: "function_call_result",
        callId: "b",
        name: "fetch",
        status: "completed",
        output: { type: "text", text: repeated },
      },
      { type: "function_call", callId: "c", name: "fetch", arguments: "{}" },
      {
        type: "function_call_result",
        callId: "c",
        name: "fetch",
        status: "completed",
        output: [{ type: "input_text", text: `LATEST-${"y".repeat(6_000)}` }],
      },
    ];
    const result = pruneToolResults(items, {
      keepRecentResults: 1,
      minReclaimTokens: 1,
    });
    expect(result.committed).toBe(true);
    expect(result.pruned_count).toBe(2);
    expect(result.items[1]).toMatchObject({
      type: "function_call_result",
      callId: "a",
      name: "fetch",
      status: "completed",
      output: expect.stringContaining("sha256="),
    });
    expect(result.items[3]).toMatchObject({
      type: "function_call_result",
      output: { type: "text", text: expect.stringContaining("sha256=") },
    });
    expect(JSON.stringify(result.items.at(-1))).toContain("LATEST-");
  });

  it("extracts deterministic anchors, user excerpts, and tool ledger", () => {
    const items: AgentInputItem[] = [
      {
        role: "user",
        content:
          "Fix #742 at /repo/src/agent.ts for v0.0.3; trace 019fa37d-d1a4-7d93-9b5a-d0e2afdbc75c",
      },
      {
        type: "function_call",
        callId: "call-99",
        name: "edit",
        arguments: "{}",
      },
      {
        type: "function_call_result",
        callId: "call-99",
        name: "edit",
        status: "completed",
        output: "completed",
      },
    ];
    expect(extractAnchors(items).map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["issue", "file", "version", "uuid", "call_id"]),
    );
    expect(extractUserExcerpts(items)[0]).toMatchObject({ source_ref: 0 });
    expect(buildToolLedger(items)[0]).toMatchObject({
      call_id: "call-99",
      tool_name: "edit",
      status: "completed",
      source_refs: [1, 2],
    });
    const callAnchor = extractAnchors(items).find(
      (entry) => entry.kind === "call_id",
    )!;
    expect(itemContainsAnchor(items[1]!, callAnchor)).toBe(true);
  });

  it("round-trips a typed checkpoint and recognizes only context overflow", () => {
    const checkpoint: PortableCheckpointV4 = {
      kind: "omoikane_context_checkpoint",
      schema_version: 4,
      checkpoint_id: "checkpoint-1",
      generation: 1,
      semantic: {
        active_task: "test",
        goal: "verify",
        constraints: [],
        decisions: [],
        completed_actions: [],
        current_state: [],
        open_questions: [],
        errors: [],
        artifacts: [],
        critical_facts: [],
      },
      anchors: [],
      user_excerpts: [],
      tool_ledger: [],
      source: { from_index: 0, to_index: 3, item_count: 4, checksum: "abc" },
    };
    expect(
      parsePortableCheckpointItem(renderPortableCheckpointItem(checkpoint)),
    ).toEqual(checkpoint);
    expect(
      isContextOverflow(
        Object.assign(new Error("maximum context length exceeded"), {
          status: 400,
        }),
      ),
    ).toBe(true);
    expect(
      isContextOverflow(
        Object.assign(new Error("unauthorized"), { status: 401 }),
      ),
    ).toBe(false);
    expect(
      isContextOverflow(
        Object.assign(new Error("provider unavailable"), { status: 503 }),
      ),
    ).toBe(false);
  });

  it("retries one non-streaming overflow only after producing a new projection", async () => {
    const prepared: ModelRequest[] = [];
    const controller = {
      prepare: async (
        request: ModelRequest,
        _config: unknown,
        force = false,
      ) => {
        const next = force
          ? { ...request, input: [{ role: "user", content: "checkpoint" }] }
          : request;
        prepared.push(next as ModelRequest);
        return next as ModelRequest;
      },
      observe: async () => undefined,
    };
    let calls = 0;
    const inner: Model = {
      getResponse: async () => {
        calls += 1;
        if (calls === 1)
          throw Object.assign(new Error("maximum context length exceeded"), {
            status: 400,
          });
        return {
          output: [],
          usage: {
            requests: 1,
            inputTokens: 10,
            outputTokens: 1,
            totalTokens: 11,
          },
        } as never;
      },
      getStreamedResponse: async function* () {},
    };
    const model = new CompactionAwareModel(inner, controller as never, {});
    const request = {
      input: [{ role: "user", content: "raw history" }],
      systemInstructions: "",
      modelSettings: {},
      tools: [],
      handoffs: [],
      outputType: "text",
      tracing: false,
    } as never;
    await expect(model.getResponse(request)).resolves.toMatchObject({
      output: [],
    });
    expect(calls).toBe(2);
    expect(prepared).toHaveLength(2);
    expect(prepared[1]!.input).not.toEqual(prepared[0]!.input);
  });

  it("persists compaction attempts and native fallback diagnostics on failure", async () => {
    const test = await testContainer();
    try {
      const fixture = await publishedAgent(test.container);
      const run = await test.container.runner.create({
        deploymentId: fixture.version.id,
        input: "diagnose failed compaction",
      });
      const failure = Object.assign(new Error("portable compaction failed"), {
        nativeFallback: "HTTP_400",
      });
      const service = {
        evaluate: async () => ({
          should_compact: true,
          reason: "high_watermark_reached",
          state: "high",
          estimated_tokens: 140_162,
          effective_input_budget_tokens: 200_000,
          reserved_output_tokens: 16_000,
          safety_margin_tokens: 2_000,
          request_overhead_tokens: 500,
          high_watermark_tokens: 130_000,
          low_watermark_tokens: 90_000,
          emergency_watermark_tokens: 180_000,
        }),
        compact: async () => {
          throw failure;
        },
      };
      const controller = new CompactionRunController(
        run.id,
        test.container.db,
        test.container.events,
        service as never,
      );
      const request = {
        input: [
          { role: "user", content: "one" },
          {
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "two" }],
          },
          { role: "user", content: "three" },
          {
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "four" }],
          },
        ],
        systemInstructions: "",
        modelSettings: {},
        tools: [],
        handoffs: [],
        outputType: "text",
        tracing: false,
      } as ModelRequest;

      await expect(
        controller.prepare(request, {
          compaction: { enabled: true, strategy: "auto" },
        }),
      ).rejects.toBe(failure);

      const persisted = await test.container.runner.get(run.id);
      expect(persisted.compaction_state_json).toMatchObject({
        attempts: 1,
        last_failure_code: "Error",
      });
      const events = await test.container.events.list(run.id);
      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "context.compaction_started",
          "context.compaction_failed",
        ]),
      );
      expect(
        events.find((event) => event.type === "context.compaction_failed")
          ?.payload_json,
      ).toMatchObject({
        attempt: 1,
        native_fallback: "HTTP_400",
        message: "portable compaction failed",
      });
    } finally {
      await test.close();
    }
  });
});
