import type {
  ModelReasoningMetadataBaseData,
  ModelReasoningMetadataCompletedData,
  ModelReasoningMetadataProgressData,
  ModelReasoningMetadataStartedData,
  ModelReasoningSummaryCompletedData,
  ModelReasoningSummaryDeltaData,
} from "./contracts.js";
import type { ReasoningCapability } from "./provider-capabilities.js";

type JsonRecord = Record<string, unknown>;

export type NormalizedModelStreamEvent =
  | {
      type: "model.output_delta";
      data: {
        delta: string;
        item_id: string | null;
        source_type: string;
      };
    }
  | {
      type: "model.reasoning_summary_delta";
      data: ModelReasoningSummaryDeltaData;
    }
  | {
      type: "model.reasoning_summary_completed";
      data: ModelReasoningSummaryCompletedData;
    }
  | {
      type: "model.reasoning_metadata_started";
      data: ModelReasoningMetadataStartedData;
    }
  | {
      type: "model.reasoning_metadata_progress";
      data: ModelReasoningMetadataProgressData;
    }
  | {
      type: "model.reasoning_metadata_completed";
      data: ModelReasoningMetadataCompletedData;
    };

export interface PublicReasoningSummary {
  itemId: string | null;
  summaryIndex: number;
  text: string;
}

interface SummaryCoordinates {
  itemId: string | null;
  outputIndex: number | null;
  summaryIndex: number;
}

interface SummaryEvidence extends SummaryCoordinates {
  key: string;
  deltas: string[];
  streamText: string | null;
  itemText: string | null;
  sourceType: string | null;
  completed: boolean;
}

interface RawReasoningCoordinates {
  itemId: string | null;
  outputIndex: number | null;
  contentIndex: number | null;
}

interface RawReasoningEvidence extends RawReasoningCoordinates {
  key: string;
  deltaCount: number;
  unicodeCharacterCount: number;
  utf8ByteCount: number;
  pendingHighSurrogate: boolean;
  startedAtMs: number;
  lastObservedAtMs: number;
  lastProgressAtMs: number;
  doneAtMs: number | null;
  doneSeen: boolean;
  countSource: "delta_stream" | "done_fallback";
  providerReasoningTokens: number | null;
  responseClosed: boolean;
  completed: boolean;
  source: ModelReasoningMetadataBaseData["source"];
  sourceType: string;
}

export interface ModelStreamEventNormalizerOptions {
  now?: () => number;
  reasoningProgressIntervalMs?: number;
  reasoning?: ReasoningCapability;
}

export type ReasoningMetadataCompletionReason =
  "stream_ended" | "failed" | "cancelled";

const record = (value: unknown): JsonRecord | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;

const nonemptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const nonnegativeInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;

const reasoningTokens = (value: unknown): number | undefined => {
  const object = record(value);
  if (!object) return undefined;
  const details = object.output_tokens_details ?? object.outputTokensDetails;
  if (Array.isArray(details)) {
    const values = details
      .map((item) => reasoningTokens({ output_tokens_details: item }))
      .filter((item): item is number => item !== undefined);
    return values.length
      ? values.reduce((sum, item) => sum + item, 0)
      : undefined;
  }
  const detail = record(details);
  const direct =
    nonnegativeInteger(detail?.reasoning_tokens) ??
    nonnegativeInteger(detail?.reasoningTokens);
  return direct;
};

const countUtf8AndCodePoints = (
  evidence: RawReasoningEvidence,
  text: string,
) => {
  let index = 0;
  const addBmp = (codeUnit: number) => {
    evidence.unicodeCharacterCount += 1;
    if (codeUnit <= 0x7f) evidence.utf8ByteCount += 1;
    else if (codeUnit <= 0x7ff) evidence.utf8ByteCount += 2;
    else evidence.utf8ByteCount += 3;
  };
  if (evidence.pendingHighSurrogate) {
    const first = text.charCodeAt(0);
    if (text.length > 0 && first >= 0xdc00 && first <= 0xdfff) {
      evidence.unicodeCharacterCount += 1;
      evidence.utf8ByteCount += 4;
      index = 1;
    } else {
      evidence.unicodeCharacterCount += 1;
      evidence.utf8ByteCount += 3;
    }
    evidence.pendingHighSurrogate = false;
  }
  while (index < text.length) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= text.length) {
        evidence.pendingHighSurrogate = true;
        break;
      }
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        evidence.unicodeCharacterCount += 1;
        evidence.utf8ByteCount += 4;
        index += 2;
        continue;
      }
    }
    addBmp(codeUnit);
    index += 1;
  }
};

const finishPendingSurrogate = (evidence: RawReasoningEvidence) => {
  if (!evidence.pendingHighSurrogate) return;
  evidence.pendingHighSurrogate = false;
  evidence.unicodeCharacterCount += 1;
  evidence.utf8ByteCount += 3;
};

/**
 * Extract only reasoning text that the Provider adapter explicitly identified as
 * a public summary. Raw reasoning and encrypted Provider data are intentionally
 * outside this allowlisted path.
 */
export function extractPublicReasoningSummaries(
  value: unknown,
): PublicReasoningSummary[] {
  const item = record(value);
  if (item?.type !== "reasoning" || !Array.isArray(item.content)) return [];
  const itemId = nonemptyString(item.id) ?? null;
  const summaries: PublicReasoningSummary[] = [];
  for (const [summaryIndex, candidate] of item.content.entries()) {
    const part = record(candidate);
    const providerData = record(part?.providerData);
    const text = nonemptyString(part?.text);
    if (
      part?.type !== "input_text" ||
      providerData?.type !== "summary_text" ||
      !text
    )
      continue;
    summaries.push({ itemId, summaryIndex, text });
  }
  return summaries;
}

/** Strip private Provider reasoning fields before durable/public storage. */
export function sanitizeReasoningItem(value: unknown): unknown {
  const item = record(value);
  if (item?.type !== "reasoning") return value;
  const summaries = extractPublicReasoningSummaries(item);
  return {
    type: "reasoning",
    ...(nonemptyString(item.id) ? { id: item.id } : {}),
    content: summaries.map((summary) => ({
      type: "input_text",
      text: summary.text,
      providerData: { type: "summary_text" },
    })),
  };
}

/** Sanitize the SDK RunItem wrapper used by reasoning_item_created Events. */
export function sanitizeReasoningRunItem(value: unknown): unknown {
  const item = record(value);
  if (item?.type !== "reasoning_item") return value;
  const agent = record(item.agent);
  const agentName = nonemptyString(agent?.name);
  return {
    type: "reasoning_item",
    ...(agentName ? { agent: { name: agentName } } : {}),
    rawItem: sanitizeReasoningItem(item.rawItem),
  };
}

/**
 * Converts OpenAI Agents SDK 0.17 normalized events and Responses raw events
 * into the stable Omoikane model-event contract. One instance is scoped to one
 * execution attempt; callers must not reuse it after a Run is requeued.
 */
export class ModelStreamEventNormalizer {
  private readonly summaries = new Map<string, SummaryEvidence>();
  private readonly rawReasoning = new Map<string, RawReasoningEvidence>();
  private anonymousItemIndex = 0;
  private readonly now: () => number;
  private readonly reasoningProgressIntervalMs: number;
  private readonly reasoning?: ReasoningCapability;

  constructor(
    private readonly executionAttempt: number,
    options: ModelStreamEventNormalizerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.reasoning = options.reasoning;
    this.reasoningProgressIntervalMs = Math.max(
      1,
      options.reasoningProgressIntervalMs ?? 1_000,
    );
  }

  consume(value: unknown): NormalizedModelStreamEvent[] {
    const data = record(value);
    const type = nonemptyString(data?.type);
    if (!data || !type) return [];

    // This is the Provider-independent text event emitted by Agents SDK 0.17.
    if (type === "output_text_delta") {
      const delta = nonemptyString(data.delta);
      if (!delta) return [];
      return [
        {
          type: "model.output_delta",
          data: {
            delta,
            item_id: nonemptyString(data.itemId) ?? null,
            source_type: type,
          },
        },
      ];
    }

    if (type === "response_done") {
      this.observeResponseUsage(data.response);
      return [];
    }

    // Responses raw events are nested inside the SDK's generic `model` event.
    // Output text is deliberately ignored in this branch because the SDK emits
    // a normalized output_text_delta for the same token.
    if (type === "model") return this.consumeModelEvent(record(data.event));

    // Preserve compatibility with older/third-party adapters that surface a
    // Responses event directly rather than through the SDK `model` envelope.
    if (type.startsWith("response."))
      return this.consumeProviderEvent(data, true);

    return [];
  }

  consumeReasoningItem(value: unknown): NormalizedModelStreamEvent[] {
    const explicit = extractPublicReasoningSummaries(value);
    const item = record(value);
    const summaries =
      explicit.length ||
      this.reasoning?.visibility !== "summary" ||
      item?.type !== "reasoning" ||
      !Array.isArray(item.content)
        ? explicit
        : item.content.flatMap((candidate, summaryIndex) => {
            const part = record(candidate);
            const text =
              part?.type === "input_text"
                ? nonemptyString(part.text)
                : undefined;
            return text
              ? [
                  {
                    itemId: nonemptyString(item.id) ?? null,
                    summaryIndex,
                    text,
                  },
                ]
              : [];
          });
    const anonymousItemIndex = this.anonymousItemIndex++;
    const events: NormalizedModelStreamEvent[] = [];
    for (const summary of summaries) {
      let evidence = summary.itemId
        ? this.summaries.get(
            this.keyFor(
              {
                itemId: summary.itemId,
                outputIndex: null,
                summaryIndex: summary.summaryIndex,
              },
              anonymousItemIndex,
            ),
          )
        : this.findAnonymousStreamEvidence(summary.summaryIndex);
      if (!evidence) {
        const coordinates: SummaryCoordinates = {
          itemId: summary.itemId,
          outputIndex: null,
          summaryIndex: summary.summaryIndex,
        };
        const key = this.keyFor(coordinates, anonymousItemIndex);
        evidence = this.createEvidence(key, coordinates);
      }
      evidence.itemText = summary.text;
      if (evidence.completed) continue;
      const streamed = this.authoritativeStreamText(evidence);
      events.push(
        ...this.complete(
          evidence,
          streamed ?? summary.text,
          streamed ? "stream" : "reasoning_item",
          evidence.sourceType ?? "reasoning_item_created",
        ),
      );
    }
    return events;
  }

  /** Complete any well-formed summary and raw-reasoning metadata at stream end. */
  flush(
    completionReason: ReasoningMetadataCompletionReason = "stream_ended",
  ): NormalizedModelStreamEvent[] {
    const events: NormalizedModelStreamEvent[] = [];
    for (const evidence of this.summaries.values()) {
      if (evidence.completed) continue;
      const streamed = this.authoritativeStreamText(evidence);
      if (streamed)
        events.push(
          ...this.complete(
            evidence,
            streamed,
            "stream",
            evidence.sourceType ?? "stream_complete",
          ),
        );
      else if (evidence.itemText)
        events.push(
          ...this.complete(
            evidence,
            evidence.itemText,
            "reasoning_item",
            "reasoning_item_created",
          ),
        );
    }
    events.push(...this.flushReasoningMetadata(completionReason));
    return events;
  }

  /** Complete metadata on failure without publishing a partial public summary. */
  flushReasoningMetadata(
    completionReason: ReasoningMetadataCompletionReason,
  ): NormalizedModelStreamEvent[] {
    const events: NormalizedModelStreamEvent[] = [];
    for (const evidence of this.rawReasoning.values()) {
      if (evidence.completed) continue;
      events.push(
        ...this.completeReasoningMetadata(evidence, completionReason),
      );
    }
    return events;
  }

  private consumeProviderEvent(
    event: JsonRecord | undefined,
    allowOutputTextDelta: boolean,
  ): NormalizedModelStreamEvent[] {
    const type = nonemptyString(event?.type);
    if (!event || !type) return [];

    if (allowOutputTextDelta && type === "response.output_text.delta") {
      const delta = nonemptyString(event.delta);
      if (!delta) return [];
      return [
        {
          type: "model.output_delta",
          data: {
            delta,
            item_id: nonemptyString(event.item_id) ?? null,
            source_type: type,
          },
        },
      ];
    }

    if (type === "response.reasoning_text.delta") {
      const delta = nonemptyString(event.delta);
      if (!delta) return [];
      const now = this.now();
      const coordinates = this.rawReasoningCoordinates(event);
      return this.observeRawReasoningDelta(
        coordinates,
        delta,
        "responses_reasoning_text",
        type,
        now,
      );
    }

    if (type === "response.reasoning_text.done") {
      const now = this.now();
      const evidence = this.rawReasoningEvidenceFor(
        this.rawReasoningCoordinates(event),
        now,
        "responses_reasoning_text",
        type,
      );
      if (evidence.completed) return [];
      evidence.doneSeen = true;
      evidence.doneAtMs = now;
      evidence.lastObservedAtMs = now;
      const text = nonemptyString(event.text);
      if (evidence.deltaCount === 0 && text) {
        evidence.countSource = "done_fallback";
        countUtf8AndCodePoints(evidence, text);
      }
      return [];
    }

    // Only public summaries and content-free raw-reasoning metadata are
    // normalized. Raw reasoning text never enters an Omoikane event.
    if (type === "response.reasoning_summary_text.delta") {
      const delta = nonemptyString(event.delta);
      if (!delta) return [];
      const coordinates = this.coordinates(event);
      const evidence = this.evidenceFor(coordinates);
      if (evidence.completed) return [];
      evidence.deltas.push(delta);
      evidence.sourceType = type;
      return [
        {
          type: "model.reasoning_summary_delta",
          data: {
            ...this.publicCoordinates(coordinates),
            delta,
            execution_attempt: this.executionAttempt,
            provisional: true,
            source_type: type,
          },
        },
      ];
    }

    if (type === "response.reasoning_summary_text.done") {
      const text = nonemptyString(event.text);
      if (!text) return [];
      const evidence = this.evidenceFor(this.coordinates(event));
      evidence.streamText = text;
      evidence.sourceType = type;
      return this.complete(evidence, text, "stream", type);
    }

    // Some Responses-compatible Providers send the completed part without a
    // separate summary_text.done event. It is still explicitly public.
    if (type === "response.reasoning_summary_part.done") {
      const part = record(event.part);
      const text =
        part?.type === "summary_text" ? nonemptyString(part.text) : undefined;
      if (!text) return [];
      const evidence = this.evidenceFor(this.coordinates(event));
      evidence.streamText = text;
      evidence.sourceType = type;
      // Keep this as fallback evidence until the stream ends. A subsequent
      // summary_text.done event is the more specific canonical snapshot.
      return [];
    }

    return [];
  }

  private consumeModelEvent(
    event: JsonRecord | undefined,
  ): NormalizedModelStreamEvent[] {
    if (!event) return [];
    const type = nonemptyString(event.type);
    if (type?.startsWith("response."))
      return this.consumeProviderEvent(event, false);

    if (
      type === "reasoning-delta" ||
      type === "reasoning_delta" ||
      type === "thinking-delta"
    ) {
      const delta =
        nonemptyString(event.delta) ??
        nonemptyString(event.text) ??
        nonemptyString(event.thinking);
      if (!delta) return [];
      const itemId = nonemptyString(event.id) ?? null;
      if (this.reasoning?.visibility === "summary") {
        const coordinates: SummaryCoordinates = {
          itemId,
          outputIndex: null,
          summaryIndex: 0,
        };
        const evidence = this.evidenceFor(coordinates);
        if (evidence.completed) return [];
        evidence.deltas.push(delta);
        evidence.sourceType = type;
        return [
          {
            type: "model.reasoning_summary_delta",
            data: {
              ...this.publicCoordinates(coordinates),
              delta,
              execution_attempt: this.executionAttempt,
              provisional: true,
              source_type: type,
            },
          },
        ];
      }
      return this.observeRawReasoningDelta(
        { itemId, outputIndex: null, contentIndex: 0 },
        delta,
        this.reasoningMetadataSource("ai_sdk_reasoning"),
        type,
      );
    }

    if (
      type === "reasoning-end" ||
      type === "reasoning_end" ||
      type === "thinking-end"
    ) {
      const itemId = nonemptyString(event.id) ?? null;
      if (this.reasoning?.visibility === "summary") {
        const evidence = this.evidenceFor({
          itemId,
          outputIndex: null,
          summaryIndex: 0,
        });
        const text = this.authoritativeStreamText(evidence);
        return text ? this.complete(evidence, text, "stream", type) : [];
      }
      this.markRawReasoningDone(
        { itemId, outputIndex: null, contentIndex: 0 },
        type,
      );
      return [];
    }

    const topLevelReasoning = this.reasoningText(event);
    if (topLevelReasoning && !Array.isArray(event.choices))
      return this.observeRawReasoningDelta(
        {
          itemId: nonemptyString(event.id) ?? null,
          outputIndex: 0,
          contentIndex: 0,
        },
        topLevelReasoning,
        this.reasoningMetadataSource("service_reasoning_steps"),
        type ?? "model.reasoning_steps",
      );
    if (!Array.isArray(event.choices)) return [];
    const events: NormalizedModelStreamEvent[] = [];
    for (const [position, rawChoice] of event.choices.entries()) {
      const choice = record(rawChoice);
      const delta = record(choice?.delta);
      const outputIndex = nonnegativeInteger(choice?.index) ?? position;
      const coordinates = {
        itemId: nonemptyString(event.id) ?? null,
        outputIndex,
        contentIndex: 0,
      };
      const source = this.reasoningMetadataSource();
      const reasoning = delta ? this.reasoningText(delta) : undefined;
      if (reasoning)
        events.push(
          ...this.observeRawReasoningDelta(
            coordinates,
            reasoning,
            source,
            `chat.completion.chunk.${source}`,
          ),
        );
      if (choice?.finish_reason)
        this.markRawReasoningDone(
          coordinates,
          `chat.completion.chunk.${String(choice.finish_reason)}`,
        );
    }
    return events;
  }

  private reasoningText(value: JsonRecord): string | undefined {
    const direct = [
      value.reasoning,
      value.reasoning_content,
      value.reasoningContent,
      value.reasoning_details,
      value.reasoningDetails,
      value.reasoning_steps,
      value.reasoningSteps,
    ];
    for (const candidate of direct) {
      const parts = this.textParts(candidate);
      if (parts.length) return parts.join("");
    }
    return undefined;
  }

  private textParts(value: unknown): string[] {
    if (typeof value === "string") return value ? [value] : [];
    if (Array.isArray(value))
      return value.flatMap((item) => this.textParts(item));
    const item = record(value);
    if (!item) return [];
    for (const key of ["text", "delta", "reasoning", "thinking", "content"]) {
      const parts = this.textParts(item[key]);
      if (parts.length) return parts;
    }
    return [];
  }

  private reasoningMetadataSource(
    fallback: ModelReasoningMetadataBaseData["source"] = "chat_reasoning_fields",
  ): ModelReasoningMetadataBaseData["source"] {
    return this.reasoning?.raw_trace_metadata ?? fallback;
  }

  private observeRawReasoningDelta(
    coordinates: RawReasoningCoordinates,
    delta: string,
    source: ModelReasoningMetadataBaseData["source"],
    sourceType: string,
    now = this.now(),
  ): NormalizedModelStreamEvent[] {
    const evidence = this.rawReasoningEvidenceFor(
      coordinates,
      now,
      source,
      sourceType,
    );
    if (evidence.completed) return [];
    const firstDelta = evidence.deltaCount === 0;
    evidence.deltaCount += 1;
    evidence.lastObservedAtMs = now;
    evidence.sourceType = sourceType;
    countUtf8AndCodePoints(evidence, delta);
    const events: NormalizedModelStreamEvent[] = [];
    if (firstDelta)
      events.push({
        type: "model.reasoning_metadata_started",
        data: {
          ...this.publicRawReasoningCoordinates(evidence),
          source,
          source_type: sourceType,
          started_at: new Date(evidence.startedAtMs).toISOString(),
          content_available: false,
          content_persisted: false,
        },
      });
    if (
      !firstDelta &&
      now - evidence.lastProgressAtMs >= this.reasoningProgressIntervalMs
    ) {
      evidence.lastProgressAtMs = now;
      events.push({
        type: "model.reasoning_metadata_progress",
        data: this.reasoningProgressData(evidence, now, sourceType),
      });
    }
    return events;
  }

  private markRawReasoningDone(
    coordinates: RawReasoningCoordinates,
    sourceType: string,
  ) {
    const evidence = this.rawReasoning.get(this.rawReasoningKey(coordinates));
    if (!evidence || evidence.completed) return;
    const now = this.now();
    evidence.doneSeen = true;
    evidence.doneAtMs = now;
    evidence.lastObservedAtMs = now;
    evidence.sourceType = sourceType;
  }

  private coordinates(event: JsonRecord): SummaryCoordinates {
    return {
      itemId: nonemptyString(event.item_id) ?? null,
      outputIndex: nonnegativeInteger(event.output_index) ?? null,
      summaryIndex: nonnegativeInteger(event.summary_index) ?? 0,
    };
  }

  private rawReasoningCoordinates(event: JsonRecord): RawReasoningCoordinates {
    return {
      itemId: nonemptyString(event.item_id) ?? null,
      outputIndex: nonnegativeInteger(event.output_index) ?? null,
      contentIndex: nonnegativeInteger(event.content_index) ?? null,
    };
  }

  private publicRawReasoningCoordinates(coordinates: RawReasoningCoordinates) {
    return {
      item_id: coordinates.itemId,
      output_index: coordinates.outputIndex,
      content_index: coordinates.contentIndex,
      execution_attempt: this.executionAttempt,
    };
  }

  private rawReasoningKey(coordinates: RawReasoningCoordinates) {
    if (coordinates.itemId)
      return `item:${coordinates.itemId}:${coordinates.contentIndex ?? 0}`;
    if (coordinates.outputIndex !== null)
      return `output:${coordinates.outputIndex}:${coordinates.contentIndex ?? 0}`;
    return "anonymous:0";
  }

  private rawReasoningEvidenceFor(
    coordinates: RawReasoningCoordinates,
    now: number,
    source: ModelReasoningMetadataBaseData["source"],
    sourceType: string,
  ) {
    const key = this.rawReasoningKey(coordinates);
    const existing = this.rawReasoning.get(key);
    if (existing) return existing;
    const evidence: RawReasoningEvidence = {
      key,
      ...coordinates,
      deltaCount: 0,
      unicodeCharacterCount: 0,
      utf8ByteCount: 0,
      pendingHighSurrogate: false,
      startedAtMs: now,
      lastObservedAtMs: now,
      lastProgressAtMs: now,
      doneAtMs: null,
      doneSeen: false,
      countSource: "delta_stream",
      providerReasoningTokens: null,
      responseClosed: false,
      completed: false,
      source,
      sourceType,
    };
    this.rawReasoning.set(key, evidence);
    return evidence;
  }

  private reasoningProgressData(
    evidence: RawReasoningEvidence,
    now: number,
    sourceType: string,
  ): ModelReasoningMetadataProgressData {
    return {
      ...this.publicRawReasoningCoordinates(evidence),
      source: evidence.source,
      source_type: sourceType,
      started_at: new Date(evidence.startedAtMs).toISOString(),
      observed_at: new Date(now).toISOString(),
      delta_count: evidence.deltaCount,
      unicode_character_count: evidence.unicodeCharacterCount,
      utf8_byte_count: evidence.utf8ByteCount,
      duration_ms: Math.max(0, Math.round(now - evidence.startedAtMs)),
      count_source: "delta_stream",
      content_available: false,
      content_persisted: false,
    };
  }

  private observeResponseUsage(value: unknown) {
    const response = record(value);
    const tokens = reasoningTokens(response?.rawUsage ?? response?.usage);
    const pending = [...this.rawReasoning.values()].filter(
      (evidence) => !evidence.completed && !evidence.responseClosed,
    );
    if (tokens !== undefined && pending.length === 1)
      pending[0]!.providerReasoningTokens = tokens;
    for (const evidence of pending) evidence.responseClosed = true;
  }

  private publicSummaryAvailable(evidence: RawReasoningEvidence) {
    for (const summary of this.summaries.values()) {
      if (!summary.completed) continue;
      if (evidence.itemId && summary.itemId === evidence.itemId) return true;
      if (
        !evidence.itemId &&
        evidence.outputIndex !== null &&
        summary.outputIndex === evidence.outputIndex
      )
        return true;
    }
    return false;
  }

  private completeReasoningMetadata(
    evidence: RawReasoningEvidence,
    fallbackReason: ReasoningMetadataCompletionReason,
  ): NormalizedModelStreamEvent[] {
    if (evidence.completed) return [];
    finishPendingSurrogate(evidence);
    evidence.completed = true;
    const completedAt = evidence.doneAtMs ?? this.now();
    return [
      {
        type: "model.reasoning_metadata_completed",
        data: {
          ...this.publicRawReasoningCoordinates(evidence),
          source: evidence.source,
          source_type: evidence.doneSeen
            ? evidence.sourceType
            : "stream_complete",
          started_at: new Date(evidence.startedAtMs).toISOString(),
          completed_at: new Date(completedAt).toISOString(),
          delta_count: evidence.deltaCount,
          unicode_character_count: evidence.unicodeCharacterCount,
          utf8_byte_count: evidence.utf8ByteCount,
          duration_ms: Math.max(
            0,
            Math.round(completedAt - evidence.startedAtMs),
          ),
          count_source: evidence.countSource,
          done_event_seen: evidence.doneSeen,
          completion_reason: evidence.doneSeen ? "done" : fallbackReason,
          provider_reasoning_tokens: evidence.providerReasoningTokens,
          public_summary_available: this.publicSummaryAvailable(evidence),
          content_available: false,
          content_persisted: false,
        },
      },
    ];
  }

  private publicCoordinates(coordinates: SummaryCoordinates) {
    return {
      item_id: coordinates.itemId,
      output_index: coordinates.outputIndex,
      summary_index: coordinates.summaryIndex,
    };
  }

  private keyFor(
    coordinates: Pick<
      SummaryCoordinates,
      "itemId" | "outputIndex" | "summaryIndex"
    >,
    anonymousIndex = 0,
  ) {
    if (coordinates.itemId)
      return `item:${coordinates.itemId}:${coordinates.summaryIndex}`;
    if (coordinates.outputIndex !== null)
      return `output:${coordinates.outputIndex}:${coordinates.summaryIndex}`;
    return `anonymous:${anonymousIndex}:${coordinates.summaryIndex}`;
  }

  private evidenceFor(coordinates: SummaryCoordinates) {
    const key = this.keyFor(coordinates);
    return this.summaries.get(key) ?? this.createEvidence(key, coordinates);
  }

  private createEvidence(key: string, coordinates: SummaryCoordinates) {
    const evidence: SummaryEvidence = {
      key,
      ...coordinates,
      deltas: [],
      streamText: null,
      itemText: null,
      sourceType: null,
      completed: false,
    };
    this.summaries.set(key, evidence);
    return evidence;
  }

  private findAnonymousStreamEvidence(summaryIndex: number) {
    for (const evidence of this.summaries.values())
      if (
        !evidence.itemId &&
        !evidence.completed &&
        evidence.summaryIndex === summaryIndex &&
        (evidence.streamText !== null || evidence.deltas.length > 0)
      )
        return evidence;
    return undefined;
  }

  private authoritativeStreamText(evidence: SummaryEvidence) {
    return (
      evidence.streamText ??
      (evidence.deltas.length ? evidence.deltas.join("") : null)
    );
  }

  private complete(
    evidence: SummaryEvidence,
    text: string,
    source: "stream" | "reasoning_item",
    sourceType: string,
  ): NormalizedModelStreamEvent[] {
    if (evidence.completed || !text) return [];
    evidence.completed = true;
    return [
      {
        type: "model.reasoning_summary_completed",
        data: {
          ...this.publicCoordinates(evidence),
          text,
          execution_attempt: this.executionAttempt,
          provisional: true,
          source,
          source_type: sourceType,
        },
      },
    ];
  }
}
