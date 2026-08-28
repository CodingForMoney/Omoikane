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
import { CompactionAwareModel } from "../src/compaction/runtime.js";
import type { Model, ModelRequest } from "@openai/agents";
import type { PortableCheckpointV4 } from "../src/compaction/types.js";

describe("compaction v4 invariants", () => {
  it("keeps a function call and its output in one atomic unit", () => {
    const items = [
      { role: "user", content: "inspect the file" },
      {
        type: "function_call",
        call_id: "call-42",
        name: "read_file",
        arguments: '{"path":"/tmp/demo.txt"}',
      },
      {
        type: "function_call_output",
        call_id: "call-42",
        output: "contents",
      },
      { role: "assistant", content: "done" },
    ] as never[];
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

  it("prunes only old or duplicate large tool results and keeps evidence", () => {
    const repeated = `RESULT-${"x".repeat(6_000)}`;
    const items = [
      { type: "function_call", call_id: "a", name: "fetch", arguments: "{}" },
      { type: "function_call_output", call_id: "a", output: repeated },
      { type: "function_call", call_id: "b", name: "fetch", arguments: "{}" },
      { type: "function_call_output", call_id: "b", output: repeated },
      { type: "function_call", call_id: "c", name: "fetch", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: "c",
        output: `LATEST-${"y".repeat(6_000)}`,
      },
    ] as never[];
    const result = pruneToolResults(items, {
      keepRecentResults: 1,
      minReclaimTokens: 1,
    });
    expect(result.committed).toBe(true);
    expect(result.pruned_count).toBe(2);
    expect(JSON.stringify(result.items[1])).toContain("sha256=");
    expect(JSON.stringify(result.items.at(-1))).toContain("LATEST-");
  });

  it("extracts deterministic anchors, user excerpts, and tool ledger", () => {
    const items = [
      {
        role: "user",
        content:
          "Fix #742 at /repo/src/agent.ts for v0.0.3; trace 019fa37d-d1a4-7d93-9b5a-d0e2afdbc75c",
      },
      {
        type: "function_call",
        call_id: "call-99",
        name: "edit",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call-99", output: "completed" },
    ] as never[];
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
});
