import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/api.js";
import type { Container } from "../src/container.js";
import { ModelStreamEventNormalizer } from "../src/model-stream-events.js";
import { collectReasoningMetadata } from "../src/reasoning-metadata.js";
import { publishedAgent, testContainer } from "./helpers.js";

let container: Container | undefined;
let app: FastifyInstance | undefined;
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await app?.close();
  await cleanup?.();
  app = undefined;
  container = undefined;
  cleanup = undefined;
});

const rawReasoningEvent = (
  type: "response.reasoning_text.delta" | "response.reasoning_text.done",
  text: string,
) => ({
  type: "model",
  event: {
    type,
    item_id: "reasoning-1",
    output_index: 0,
    content_index: 0,
    ...(type.endsWith(".delta") ? { delta: text } : { text }),
  },
});

describe("raw reasoning metadata", () => {
  it("counts streamed Unicode without retaining text or double-counting done", () => {
    let now = 1_000;
    const normalizer = new ModelStreamEventNormalizer(4, {
      now: () => now,
      reasoningProgressIntervalMs: 1_000,
    });
    const privateText = "PRIVATE_RAW_REASONING_MUST_NOT_PERSIST";
    const events = [
      ...normalizer.consume(
        rawReasoningEvent("response.reasoning_text.delta", "中"),
      ),
    ];
    now = 1_500;
    events.push(
      ...normalizer.consume(
        rawReasoningEvent("response.reasoning_text.delta", "\ud83d"),
      ),
    );
    now = 2_100;
    events.push(
      ...normalizer.consume(
        rawReasoningEvent("response.reasoning_text.delta", "\ude00A"),
      ),
    );
    now = 2_200;
    expect(
      normalizer.consume(
        rawReasoningEvent("response.reasoning_text.done", privateText),
      ),
    ).toEqual([]);
    normalizer.consume({
      type: "response_done",
      response: {
        rawUsage: { output_tokens_details: { reasoning_tokens: 17 } },
      },
    });
    events.push(...normalizer.flush());

    expect(events.map((event) => event.type)).toEqual([
      "model.reasoning_metadata_started",
      "model.reasoning_metadata_progress",
      "model.reasoning_metadata_completed",
    ]);
    expect(events.at(-1)?.data).toMatchObject({
      execution_attempt: 4,
      delta_count: 3,
      unicode_character_count: 3,
      utf8_byte_count: 8,
      duration_ms: 1_200,
      done_event_seen: true,
      completion_reason: "done",
      count_source: "delta_stream",
      provider_reasoning_tokens: 17,
      public_summary_available: false,
      content_available: false,
      content_persisted: false,
    });
    expect(JSON.stringify(events)).not.toContain(privateText);
    expect(JSON.stringify(events)).not.toContain("中");
  });

  it("uses done text only as a counting fallback", () => {
    const normalizer = new ModelStreamEventNormalizer(1, {
      now: () => 10_000,
    });
    normalizer.consume(
      rawReasoningEvent("response.reasoning_text.done", "中😀"),
    );

    expect(normalizer.flush()[0]).toMatchObject({
      type: "model.reasoning_metadata_completed",
      data: {
        delta_count: 0,
        unicode_character_count: 2,
        utf8_byte_count: 7,
        count_source: "done_fallback",
        completion_reason: "done",
      },
    });
  });

  it("marks unfinished streams with the caller-supplied terminal reason", () => {
    const normalizer = new ModelStreamEventNormalizer(2, {
      now: () => 20_000,
    });
    normalizer.consume(
      rawReasoningEvent("response.reasoning_text.delta", "private"),
    );

    expect(normalizer.flushReasoningMetadata("failed")[0]?.data).toMatchObject({
      completion_reason: "failed",
      done_event_seen: false,
    });
    expect(normalizer.flushReasoningMetadata("failed")).toEqual([]);
  });

  it("reduces cumulative snapshots instead of adding them repeatedly", () => {
    const base = {
      schema_version: 1,
      id: "event",
      run_id: "run-1",
      seq: 1,
      time: new Date(0).toISOString(),
    };
    const common = {
      execution_attempt: 1,
      item_id: "reasoning-1",
      output_index: 0,
      content_index: 0,
      source: "responses_reasoning_text",
      source_type: "response.reasoning_text.delta",
      started_at: new Date(1_000).toISOString(),
      content_available: false,
      content_persisted: false,
    };
    const report = collectReasoningMetadata("run-1", [
      {
        ...base,
        type: "model.reasoning_metadata_started",
        data: common,
      },
      {
        ...base,
        id: "progress",
        seq: 2,
        type: "model.reasoning_metadata_progress",
        data: {
          ...common,
          observed_at: new Date(2_000).toISOString(),
          delta_count: 10,
          unicode_character_count: 20,
          utf8_byte_count: 30,
          duration_ms: 1_000,
          count_source: "delta_stream",
        },
      },
      {
        ...base,
        id: "completed",
        seq: 3,
        type: "model.reasoning_metadata_completed",
        data: {
          ...common,
          source_type: "response.reasoning_text.done",
          completed_at: new Date(3_000).toISOString(),
          delta_count: 12,
          unicode_character_count: 24,
          utf8_byte_count: 36,
          duration_ms: 2_000,
          count_source: "delta_stream",
          done_event_seen: true,
          completion_reason: "done",
          provider_reasoning_tokens: 7,
          public_summary_available: false,
        },
      },
    ]);

    expect(report).toMatchObject({
      run_id: "run-1",
      raw_reasoning_observed: true,
      provider_reasoning_tokens: 7,
      content_available: false,
      content_persisted: false,
      attempts: [
        {
          execution_attempt: 1,
          item_count: 1,
          delta_count: 12,
          unicode_character_count: 24,
          utf8_byte_count: 36,
          duration_ms: 2_000,
          completion_reason: "done",
        },
      ],
    });
  });

  it("serves the durable aggregate through REST", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const fixture = await publishedAgent(container);
    const run = await container.runner.create({
      deploymentId: fixture.version.id,
      input: "metadata API",
    });
    await container.events.append(
      run.id,
      "model.reasoning_metadata_completed",
      {
        execution_attempt: 1,
        item_id: "reasoning-1",
        output_index: 0,
        content_index: 0,
        source: "responses_reasoning_text",
        source_type: "response.reasoning_text.done",
        started_at: new Date(1_000).toISOString(),
        completed_at: new Date(2_000).toISOString(),
        delta_count: 4,
        unicode_character_count: 8,
        utf8_byte_count: 16,
        duration_ms: 1_000,
        count_source: "delta_stream",
        done_event_seen: true,
        completion_reason: "done",
        provider_reasoning_tokens: null,
        public_summary_available: false,
        content_available: false,
        content_persisted: false,
      },
    );
    app = await createApp(container);

    const response = await app.inject({
      method: "GET",
      url: `/v1/runs/${run.id}/reasoning-metadata`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      run_id: run.id,
      raw_reasoning_observed: true,
      attempts: [{ delta_count: 4, completion_reason: "done" }],
    });
  });
});
