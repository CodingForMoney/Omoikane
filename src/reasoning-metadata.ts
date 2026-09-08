import type {
  ReasoningMetadataAttempt,
  ReasoningMetadataResponse,
  RuntimeEvent,
} from "./contracts.js";

type JsonRecord = Record<string, unknown>;

interface ReasoningMetadataEventLike {
  id?: string;
  seq?: number;
  type: string;
  data?: unknown;
  payload_json?: unknown;
}

interface ItemState {
  key: string;
  deltaCount: number;
  unicodeCharacterCount: number;
  utf8ByteCount: number;
  durationMs: number;
  startedAt: string;
  observedAt: string;
  completedAt: string | null;
  completionReason: ReasoningMetadataAttempt["completion_reason"] | null;
  providerReasoningTokens: number | null;
}

interface AttemptState {
  items: Map<string, ItemState>;
  publicSummaryObserved: boolean;
}

const record = (value: unknown): JsonRecord | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;

const nonnegativeInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;

const timestamp = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
};

const eventData = (event: ReasoningMetadataEventLike) =>
  record(event.data ?? event.payload_json);

const metadataItemKey = (
  event: ReasoningMetadataEventLike,
  data: JsonRecord,
) => {
  const itemId = typeof data.item_id === "string" ? data.item_id : null;
  const outputIndex = nonnegativeInteger(data.output_index);
  const contentIndex = nonnegativeInteger(data.content_index) ?? 0;
  if (itemId) return `item:${itemId}:${contentIndex}`;
  if (outputIndex !== undefined) return `output:${outputIndex}:${contentIndex}`;
  return `event:${event.id ?? event.seq ?? "unknown"}`;
};

const usageReasoningTokens = (details: unknown): number[] => {
  const values = Array.isArray(details) ? details : [details];
  return values.flatMap((value) => {
    const item = record(value);
    const count =
      nonnegativeInteger(item?.reasoning_tokens) ??
      nonnegativeInteger(item?.reasoningTokens);
    return count === undefined ? [] : [count];
  });
};

/** Return only authoritative Provider/SDK reasoning-token details. */
export function providerReasoningTokensFromUsage(
  usage: unknown,
): number | null {
  const value = record(usage);
  const counts = usageReasoningTokens(
    value?.output_tokens_details ?? value?.outputTokensDetails,
  );
  return counts.length ? counts.reduce((sum, count) => sum + count, 0) : null;
}

/**
 * Reduce stable Runtime Events into one content-free Raw CoT metadata view.
 * Cumulative progress snapshots replace earlier snapshots; their counts are
 * never added together.
 */
export function collectReasoningMetadata(
  runId: string,
  events: ReasoningMetadataEventLike[],
  providerReasoningTokens: number | null = null,
): ReasoningMetadataResponse {
  const attempts = new Map<number, AttemptState>();
  let publicSummaryObserved = false;

  for (const event of events) {
    const data = eventData(event);
    if (!data) continue;
    if (
      event.type === "model.reasoning_summary_delta" ||
      event.type === "model.reasoning_summary_completed"
    ) {
      publicSummaryObserved = true;
      const executionAttempt = nonnegativeInteger(data.execution_attempt);
      if (executionAttempt !== undefined) {
        const attempt = attempts.get(executionAttempt) ?? {
          items: new Map<string, ItemState>(),
          publicSummaryObserved: false,
        };
        attempt.publicSummaryObserved = true;
        attempts.set(executionAttempt, attempt);
      }
      continue;
    }
    if (!event.type.startsWith("model.reasoning_metadata_")) continue;
    const executionAttempt = nonnegativeInteger(data.execution_attempt);
    const startedAt = timestamp(data.started_at);
    if (executionAttempt === undefined || !startedAt) continue;
    const attempt = attempts.get(executionAttempt) ?? {
      items: new Map<string, ItemState>(),
      publicSummaryObserved: false,
    };
    const key = metadataItemKey(event, data);
    const current = attempt.items.get(key) ?? {
      key,
      deltaCount: 0,
      unicodeCharacterCount: 0,
      utf8ByteCount: 0,
      durationMs: 0,
      startedAt,
      observedAt: startedAt,
      completedAt: null,
      completionReason: null,
      providerReasoningTokens: null,
    };
    current.startedAt =
      Date.parse(startedAt) < Date.parse(current.startedAt)
        ? startedAt
        : current.startedAt;
    const observedAt =
      timestamp(data.completed_at) ?? timestamp(data.observed_at) ?? startedAt;
    if (Date.parse(observedAt) >= Date.parse(current.observedAt)) {
      current.observedAt = observedAt;
      current.deltaCount =
        nonnegativeInteger(data.delta_count) ?? current.deltaCount;
      current.unicodeCharacterCount =
        nonnegativeInteger(data.unicode_character_count) ??
        current.unicodeCharacterCount;
      current.utf8ByteCount =
        nonnegativeInteger(data.utf8_byte_count) ?? current.utf8ByteCount;
      current.durationMs =
        nonnegativeInteger(data.duration_ms) ?? current.durationMs;
    }
    if (event.type === "model.reasoning_metadata_completed") {
      current.completedAt = timestamp(data.completed_at) ?? observedAt;
      const completionReason = data.completion_reason;
      if (
        completionReason === "done" ||
        completionReason === "stream_ended" ||
        completionReason === "failed" ||
        completionReason === "cancelled"
      )
        current.completionReason = completionReason;
      current.providerReasoningTokens =
        nonnegativeInteger(data.provider_reasoning_tokens) ?? null;
    }
    attempt.items.set(key, current);
    attempts.set(executionAttempt, attempt);
  }

  const normalizedAttempts = [...attempts.entries()]
    .filter(([, attempt]) => attempt.items.size > 0)
    .sort(([left], [right]) => left - right)
    .map(([executionAttempt, attempt]): ReasoningMetadataAttempt => {
      const items = [...attempt.items.values()];
      const startedAt = items.reduce(
        (earliest, item) =>
          Date.parse(item.startedAt) < Date.parse(earliest)
            ? item.startedAt
            : earliest,
        items[0]!.startedAt,
      );
      const completedValues = items
        .map((item) => item.completedAt)
        .filter((value): value is string => value !== null);
      const completedAt =
        completedValues.length === items.length
          ? completedValues.reduce((latest, value) =>
              Date.parse(value) > Date.parse(latest) ? value : latest,
            )
          : null;
      const reasons = new Set(items.map((item) => item.completionReason));
      let completionReason: ReasoningMetadataAttempt["completion_reason"];
      if (reasons.has(null)) completionReason = "incomplete";
      else if (reasons.size === 1)
        completionReason = [...reasons][0] as Exclude<
          ReasoningMetadataAttempt["completion_reason"],
          "incomplete" | "mixed"
        >;
      else completionReason = "mixed";
      const itemTokens = items
        .map((item) => item.providerReasoningTokens)
        .filter((value): value is number => value !== null);
      const finalObservedAt =
        completedAt ??
        items.reduce(
          (latest, item) =>
            Date.parse(item.observedAt) > Date.parse(latest)
              ? item.observedAt
              : latest,
          items[0]!.observedAt,
        );
      return {
        execution_attempt: executionAttempt,
        item_count: items.length,
        delta_count: items.reduce((sum, item) => sum + item.deltaCount, 0),
        unicode_character_count: items.reduce(
          (sum, item) => sum + item.unicodeCharacterCount,
          0,
        ),
        utf8_byte_count: items.reduce(
          (sum, item) => sum + item.utf8ByteCount,
          0,
        ),
        duration_ms: Math.max(
          0,
          Math.round(Date.parse(finalObservedAt) - Date.parse(startedAt)),
        ),
        started_at: startedAt,
        completed_at: completedAt,
        completion_reason: completionReason,
        provider_reasoning_tokens: itemTokens.length
          ? itemTokens.reduce((sum, value) => sum + value, 0)
          : null,
        public_summary_observed: attempt.publicSummaryObserved,
        content_available: false,
        content_persisted: false,
      };
    });

  const eventTokens = normalizedAttempts
    .map((attempt) => attempt.provider_reasoning_tokens)
    .filter((value): value is number => value !== null);
  return {
    run_id: runId,
    raw_reasoning_observed: normalizedAttempts.length > 0,
    public_summary_observed: publicSummaryObserved,
    provider_reasoning_tokens:
      providerReasoningTokens ??
      (eventTokens.length
        ? eventTokens.reduce((sum, value) => sum + value, 0)
        : null),
    content_available: false,
    content_persisted: false,
    attempts: normalizedAttempts,
  };
}

export type ReasoningMetadataRuntimeEvent = RuntimeEvent &
  ReasoningMetadataEventLike;
