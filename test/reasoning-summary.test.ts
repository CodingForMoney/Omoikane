import { afterEach, describe, expect, it } from "vitest";
import {
  ScriptedModel,
  assistantMessage,
  modelResponse,
  modelStream,
} from "@openai/agents/testing";
import type { Container } from "../src/container.js";
import {
  ModelStreamEventNormalizer,
  extractPublicReasoningSummaries,
} from "../src/model-stream-events.js";
import { publishedAgent, testContainer } from "./helpers.js";

let container: Container | undefined;
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  container = undefined;
  cleanup = undefined;
});

const publicReasoningItem = (
  text: string,
  options: { id?: string; privateText?: string; encrypted?: string } = {},
) => ({
  type: "reasoning" as const,
  ...(options.id ? { id: options.id } : {}),
  content: [
    {
      type: "input_text" as const,
      text,
      providerData: { type: "summary_text" },
    },
  ],
  ...(options.privateText
    ? {
        rawContent: [
          {
            type: "reasoning_text" as const,
            text: options.privateText,
          },
        ],
      }
    : {}),
  ...(options.encrypted
    ? { providerData: { encrypted_content: options.encrypted } }
    : {}),
});

const rawResponsesEvent = (event: Record<string, unknown>) => ({
  type: "model" as const,
  event,
  providerData: { rawModelEventSource: "openai-responses" },
});

const summaryDelta = (delta: string) =>
  rawResponsesEvent({
    type: "response.reasoning_summary_text.delta",
    item_id: "reasoning-1",
    output_index: 0,
    summary_index: 0,
    sequence_number: 1,
    delta,
  });

const summaryDone = (text: string) =>
  rawResponsesEvent({
    type: "response.reasoning_summary_text.done",
    item_id: "reasoning-1",
    output_index: 0,
    summary_index: 0,
    sequence_number: 2,
    text,
  });

describe("reasoning summary normalization", () => {
  it("extracts only explicitly public summary_text content", () => {
    const item = {
      type: "reasoning",
      id: "reasoning-1",
      content: [
        {
          type: "input_text",
          text: "public summary",
          providerData: { type: "summary_text" },
        },
        {
          type: "input_text",
          text: "private disguised text",
          providerData: { type: "reasoning_text" },
        },
      ],
      rawContent: [{ type: "reasoning_text", text: "PRIVATE_REASONING" }],
      providerData: {
        encrypted_content: "ENCRYPTED_REASONING",
        reasoning_text: "PRIVATE_PROVIDER_REASONING",
      },
    };

    expect(extractPublicReasoningSummaries(item)).toEqual([
      {
        itemId: "reasoning-1",
        summaryIndex: 0,
        text: "public summary",
      },
    ]);
  });

  it("supports streamed-only summaries", () => {
    const normalizer = new ModelStreamEventNormalizer(3);
    const delta = normalizer.consume(summaryDelta("streamed "));
    const done = normalizer.consume(summaryDone("streamed summary"));

    expect(delta).toEqual([
      {
        type: "model.reasoning_summary_delta",
        data: expect.objectContaining({
          delta: "streamed ",
          item_id: "reasoning-1",
          summary_index: 0,
          execution_attempt: 3,
          provisional: true,
        }),
      },
    ]);
    expect(done).toEqual([
      {
        type: "model.reasoning_summary_completed",
        data: expect.objectContaining({
          text: "streamed summary",
          source: "stream",
          execution_attempt: 3,
        }),
      },
    ]);
    expect(normalizer.flush()).toEqual([]);
  });

  it("uses a completed summary part only when no text.done snapshot follows", () => {
    const fallback = new ModelStreamEventNormalizer(1);
    expect(
      fallback.consume(
        rawResponsesEvent({
          type: "response.reasoning_summary_part.done",
          item_id: "reasoning-1",
          output_index: 0,
          summary_index: 0,
          sequence_number: 1,
          part: { type: "summary_text", text: "part fallback" },
        }),
      ),
    ).toEqual([]);
    expect(fallback.flush()[0]?.data).toMatchObject({
      text: "part fallback",
      source: "stream",
    });

    const canonical = new ModelStreamEventNormalizer(1);
    canonical.consume(
      rawResponsesEvent({
        type: "response.reasoning_summary_part.done",
        item_id: "reasoning-1",
        output_index: 0,
        summary_index: 0,
        sequence_number: 1,
        part: { type: "summary_text", text: "part fallback" },
      }),
    );
    expect(
      canonical.consume(summaryDone("canonical text"))[0]?.data,
    ).toMatchObject({
      text: "canonical text",
      source_type: "response.reasoning_summary_text.done",
    });
  });

  it("supports reasoning-item-only summaries", () => {
    const normalizer = new ModelStreamEventNormalizer(1);

    expect(
      normalizer.consumeReasoningItem(
        publicReasoningItem("item summary", { id: "reasoning-1" }),
      ),
    ).toEqual([
      {
        type: "model.reasoning_summary_completed",
        data: expect.objectContaining({
          text: "item summary",
          source: "reasoning_item",
          execution_attempt: 1,
        }),
      },
    ]);
  });

  it("deduplicates both forms and keeps streamed text authoritative", () => {
    const normalizer = new ModelStreamEventNormalizer(1);
    normalizer.consume(summaryDelta("streamed summary"));

    const completed = normalizer.consumeReasoningItem(
      publicReasoningItem("different item summary", { id: "reasoning-1" }),
    );

    expect(completed).toEqual([
      {
        type: "model.reasoning_summary_completed",
        data: expect.objectContaining({
          text: "streamed summary",
          source: "stream",
        }),
      },
    ]);
    expect(normalizer.consume(summaryDone("streamed summary"))).toEqual([]);
    expect(
      normalizer.consumeReasoningItem(
        publicReasoningItem("different item summary", { id: "reasoning-1" }),
      ),
    ).toEqual([]);
  });

  it("scopes provisional evidence to one execution attempt", () => {
    const firstAttempt = new ModelStreamEventNormalizer(1);
    firstAttempt.consume(summaryDelta("stale summary"));

    const secondAttempt = new ModelStreamEventNormalizer(2);
    const completed = secondAttempt.consumeReasoningItem(
      publicReasoningItem("fresh summary", { id: "reasoning-1" }),
    );

    expect(completed[0]?.data).toMatchObject({
      text: "fresh summary",
      execution_attempt: 2,
      source: "reasoning_item",
    });
  });

  it("handles the Agents SDK 0.17 event envelope end to end", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const privateText = "PRIVATE_REASONING_TEXT";
    const encrypted = "ENCRYPTED_REASONING_CONTENT";
    const streamedText = "authoritative streamed summary";
    const responseOutput = [
      publicReasoningItem("different item summary", {
        id: "reasoning-1",
        privateText,
        encrypted,
      }),
      assistantMessage("final answer", { id: "message-1" }),
    ];
    const model = new ScriptedModel([
      modelStream([
        { type: "response_started" },
        {
          type: "output_text_delta",
          itemId: "message-1",
          delta: "final answer",
        },
        summaryDelta("authoritative "),
        summaryDelta("streamed summary"),
        rawResponsesEvent({
          type: "response.reasoning_text.delta",
          item_id: "reasoning-1",
          output_index: 0,
          content_index: 0,
          sequence_number: 3,
          delta: privateText,
        }),
        summaryDone(streamedText),
        {
          type: "response_done",
          response: {
            id: "response-1",
            usage: {
              requests: 1,
              inputTokens: 1,
              outputTokens: 2,
              totalTokens: 3,
            },
            output: responseOutput,
          },
        },
      ] as never),
    ]);
    const fixture = await publishedAgent(container, { model });
    const created = await container.runner.create({
      deploymentId: fixture.version.id,
      input: "test summaries",
    });

    await container.runner.processNext();

    expect((await container.runner.get(created.id)).status).toBe("completed");
    const events = await container.events.list(created.id);
    const outputDeltas = events.filter(
      (event) => event.type === "model.output_delta",
    );
    const summaryDeltas = events.filter(
      (event) => event.type === "model.reasoning_summary_delta",
    );
    const completed = events.filter(
      (event) => event.type === "model.reasoning_summary_completed",
    );
    const metadata = events.filter((event) =>
      event.type.startsWith("model.reasoning_metadata_"),
    );
    expect(outputDeltas).toHaveLength(1);
    expect(outputDeltas[0]?.payload_json).toMatchObject({
      delta: "final answer",
      source_type: "output_text_delta",
    });
    expect(summaryDeltas).toHaveLength(2);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.payload_json).toMatchObject({
      text: streamedText,
      source: "stream",
      execution_attempt: 1,
    });
    expect(metadata.map((event) => event.type)).toEqual([
      "model.reasoning_metadata_started",
      "model.reasoning_metadata_completed",
    ]);
    expect(metadata.at(-1)?.payload_json).toMatchObject({
      delta_count: 1,
      unicode_character_count: privateText.length,
      done_event_seen: false,
      completion_reason: "stream_ended",
      public_summary_available: true,
      content_available: false,
      content_persisted: false,
    });
    expect(events.some((event) => event.type === "model.reasoning_delta")).toBe(
      false,
    );
    const normalizedSummaryJson = JSON.stringify([
      ...summaryDeltas,
      ...completed,
    ]);
    expect(normalizedSummaryJson).not.toContain(privateText);
    expect(normalizedSummaryJson).not.toContain(encrypted);
    expect(JSON.stringify(metadata)).not.toContain(privateText);
    expect(JSON.stringify(metadata)).not.toContain(encrypted);
    expect(JSON.stringify(events)).not.toContain(privateText);
    expect(JSON.stringify(events)).not.toContain(encrypted);
    expect(
      JSON.stringify(await container.runner.publicRun(created.id)),
    ).not.toContain(privateText);
    expect(
      JSON.stringify(await container.runner.publicRun(created.id)),
    ).not.toContain(encrypted);
    expect(await container.runner.reasoningMetadata(created.id)).toMatchObject({
      raw_reasoning_observed: true,
      public_summary_observed: true,
      attempts: [{ delta_count: 1, completion_reason: "stream_ended" }],
    });
  });

  it("restores ordinary SDK output streaming", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const model = new ScriptedModel([
      modelResponse([assistantMessage("streamed answer")]),
    ]);
    const fixture = await publishedAgent(container, { model });
    const created = await container.runner.create({
      deploymentId: fixture.version.id,
      input: "test output streaming",
    });

    await container.runner.processNext();

    const deltas = (await container.events.list(created.id)).filter(
      (event) => event.type === "model.output_delta",
    );
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.payload_json).toMatchObject({
      delta: "streamed answer",
      item_id: null,
      source_type: "output_text_delta",
      provisional: false,
    });
  });
});
