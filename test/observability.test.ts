import { afterEach, describe, expect, it } from "vitest";
import type { TracingExporter } from "@openai/agents";
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponse,
} from "@openai/agents/testing";
import { createApp } from "../src/api.js";
import { RuntimeStatusResponseSchema } from "../src/contracts.js";
import {
  registerTraceExporter,
  runtimeLogRecord,
  unregisterTraceExporter,
} from "../src/observability.js";
import {
  registerToolImplementation,
  unregisterToolImplementation,
} from "../src/tools.js";
import { publishedAgent, testContainer } from "./helpers.js";

let cleanup: (() => Promise<void>) | undefined;
const exporterKeys = new Set<string>();
const toolKeys = new Set<string>();

const registerExporter = (key: string, factory: () => TracingExporter) => {
  registerTraceExporter(key, factory);
  exporterKeys.add(key);
};

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  for (const key of exporterKeys) unregisterTraceExporter(key);
  exporterKeys.clear();
  for (const key of toolKeys) unregisterToolImplementation(key);
  toolKeys.clear();
});

describe("Runtime observability", () => {
  it("correlates one metadata-only SDK trace per execution attempt", async () => {
    const exported: unknown[] = [];
    const exporterKey = `capture.${crypto.randomUUID()}`;
    registerExporter(exporterKey, () => ({
      async export(items) {
        exported.push(
          ...items.map((item) =>
            (item as { toJSON(): unknown }).toJSON(),
          ),
        );
      },
    }));
    const test = await testContainer({
      env: { OMOIKANE_TRACING_EXPORTER: `custom:${exporterKey}` },
    });
    cleanup = test.close;

    const toolKey = `test.trace-tool.${crypto.randomUUID()}`;
    const toolSlug = `trace-tool-${crypto.randomUUID().slice(0, 8)}`;
    registerToolImplementation(toolKey, async () => ({
      result: "TRACE_TOOL_RESULT_SENTINEL",
    }));
    toolKeys.add(toolKey);
    await test.container.tools.create({
      slug: toolSlug,
      name: "trace_tool",
      description: "Exercise metadata-only tracing",
      implementation_key: toolKey,
      schema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      policy: { requires_approval: true, side_effecting: false },
    });
    const model = new ScriptedModel([
      modelResponse([
        functionCall(
          "trace_tool",
          { value: "TRACE_TOOL_ARGUMENT_SENTINEL" },
          { callId: "trace-call" },
        ),
      ]),
      modelResponse([assistantMessage("TRACE_MODEL_OUTPUT_SENTINEL")]),
    ]);
    const fixture = await publishedAgent(test.container, {
      model,
      tools: [toolSlug],
    });
    const run = await test.container.runner.create({
      deploymentId: fixture.version.id,
      externalSessionId: "TRACE_EXTERNAL_SESSION_SENTINEL",
      input: "TRACE_MODEL_INPUT_SENTINEL",
    });

    await test.container.runner.processNext();
    const approval = (
      await test.container.db.query<{ id: string }>(
        "SELECT id FROM approvals WHERE run_id=$1",
        [run.id],
      )
    ).rows[0]!;
    await test.container.runner.decideApproval(approval.id, "approved");
    await test.container.runner.processNext();

    const rejectedFixture = await publishedAgent(test.container, {
      model: new ScriptedModel([
        modelResponse([assistantMessage("TRACE_REJECTED_OUTPUT_SENTINEL")]),
      ]),
      guardrails: {
        output: [
          {
            id: "trace-output-policy",
            implementation_key: "builtin.regex",
            config: { deny_patterns: ["TRACE_REJECTED_OUTPUT_SENTINEL"] },
          },
        ],
      },
    });
    const rejectedRun = await test.container.runner.create({
      deploymentId: rejectedFixture.version.id,
      input: "produce rejected output",
    });
    await test.container.runner.processNext();
    await test.container.observability.flush();

    expect((await test.container.runner.get(run.id)).status).toBe("completed");
    expect((await test.container.runner.get(rejectedRun.id)).status).toBe(
      "failed",
    );
    const starts = [
      ...(await test.container.events.list(run.id)),
      ...(await test.container.events.list(rejectedRun.id)),
    ].filter((event) => event.type === "run.started");
    expect(starts).toHaveLength(3);
    const sdkTraceIds = starts.map((event) =>
      String(event.payload_json.sdk_trace_id),
    );
    expect(new Set(sdkTraceIds).size).toBe(3);

    const traces = exported.filter(
      (item): item is Record<string, unknown> =>
        Boolean(
          item &&
            typeof item === "object" &&
            (item as Record<string, unknown>).object === "trace",
        ),
    );
    expect(traces).toHaveLength(3);
    expect(traces.map((trace) => trace.id).sort()).toEqual(
      [...sdkTraceIds].sort(),
    );
    for (const trace of traces.filter(
      (trace) =>
        (trace.metadata as Record<string, unknown> | undefined)?.run_id ===
        run.id,
    ))
      expect(trace.metadata).toMatchObject({
        run_id: run.id,
        run_trace_id: run.trace_id,
        deployment_id: fixture.version.id,
        provider: "xiaomi_mimo",
        model: "mimo-v2.5",
      });

    const encoded = JSON.stringify(exported);
    for (const sentinel of [
      "TRACE_MODEL_INPUT_SENTINEL",
      "TRACE_MODEL_OUTPUT_SENTINEL",
      "TRACE_TOOL_ARGUMENT_SENTINEL",
      "TRACE_TOOL_RESULT_SENTINEL",
      "TRACE_REJECTED_OUTPUT_SENTINEL",
      "TRACE_EXTERNAL_SESSION_SENTINEL",
      "test-only-key",
    ])
      expect(encoded).not.toContain(sentinel);
    expect(test.container.observability.status()).toMatchObject({
      enabled: true,
      exporter: `custom:${exporterKey}`,
      content_policy: "metadata_only",
      state: "ready",
      failure_count: 0,
    });
  }, 30_000);

  it("isolates exporter failures from Runs and reports degraded status", async () => {
    const exporterKey = `failure.${crypto.randomUUID()}`;
    registerExporter(exporterKey, () => ({
      async export() {
        throw new Error("TRACE_EXPORT_SECRET_MUST_NOT_ESCAPE");
      },
    }));
    const test = await testContainer({
      env: { OMOIKANE_TRACING_EXPORTER: `custom:${exporterKey}` },
    });
    cleanup = test.close;
    const fixture = await publishedAgent(test.container, {
      model: new ScriptedModel([
        modelResponse([assistantMessage("Run still succeeds")]),
      ]),
    });
    const run = await test.container.runner.create({
      deploymentId: fixture.version.id,
      input: "execute despite trace exporter failure",
    });

    await test.container.runner.processNext();
    await test.container.observability.flush();

    expect((await test.container.runner.get(run.id)).status).toBe("completed");
    const status = test.container.observability.status();
    expect(status).toMatchObject({
      state: "degraded",
      failure_count: 1,
    });
    expect(JSON.stringify(status)).not.toContain(
      "TRACE_EXPORT_SECRET_MUST_NOT_ESCAPE",
    );
  });

  it("flushes pending traces on close and exposes bounded Runtime status", async () => {
    let exportedItems = 0;
    const exporterKey = `close.${crypto.randomUUID()}`;
    registerExporter(exporterKey, () => ({
      async export(items) {
        exportedItems += items.length;
      },
    }));
    const test = await testContainer({
      env: { OMOIKANE_TRACING_EXPORTER: `custom:${exporterKey}` },
    });
    cleanup = test.close;
    const fixture = await publishedAgent(test.container, {
      model: new ScriptedModel([
        modelResponse([assistantMessage("pending trace")]),
      ]),
    });
    const run = await test.container.runner.create({
      deploymentId: fixture.version.id,
      input: "close flush",
    });
    await test.container.runner.processNext();

    const app = await createApp(test.container);
    const response = await app.inject({
      method: "GET",
      url: "/v1/runtime/status",
    });
    expect(response.statusCode).toBe(200);
    expect(RuntimeStatusResponseSchema.parse(response.json())).toMatchObject({
      workers: { configured: 0, active: 0 },
      maintenance: { configured: false, active: false },
      runs: { total: 1, by_status: { completed: 1 } },
      tracing: {
        enabled: true,
        exporter: `custom:${exporterKey}`,
        content_policy: "metadata_only",
      },
    });
    await app.close();
    await test.close();
    cleanup = undefined;
    expect(exportedItems).toBeGreaterThan(0);
  });

  it("drops non-allowlisted log fields and raw exception content", () => {
    const encoded = JSON.stringify(
      runtimeLogRecord("error", "test failure", {
        run_id: "run-safe",
        error_type: "ProviderError",
        api_key: "LOG_API_KEY_SENTINEL",
        message: "LOG_MESSAGE_SENTINEL",
        stack: "LOG_STACK_SENTINEL",
        provider_response: "LOG_PROVIDER_RESPONSE_SENTINEL",
      }),
    );
    expect(encoded).toContain("run-safe");
    expect(encoded).toContain("ProviderError");
    expect(encoded).not.toContain("SENTINEL");
  });
});
