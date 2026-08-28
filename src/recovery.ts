import type {
  ModelSettings,
  RetryDecision,
  RetryPolicyContext,
} from "@openai/agents";
import { ValidationError } from "./database.js";

export const FAILURE_POINTS = [
  "model.before_request",
  "model.after_response",
  "approval.before_commit",
  "tool.after_effect_before_commit",
  "run.before_terminal_commit",
  "run.after_terminal_commit",
  "maintenance.before_recovery_commit",
  "sse.before_event",
] as const;

export type FailurePoint = (typeof FAILURE_POINTS)[number];
export type FailureContext = Readonly<Record<string, unknown>>;

export interface FaultInjector {
  hit(point: FailurePoint, context?: FailureContext): void | Promise<void>;
}

export class InjectedProcessCrash extends Error {
  readonly point: FailurePoint;

  constructor(point: FailurePoint) {
    super(`injected process crash at ${point}`);
    this.name = "InjectedProcessCrash";
    this.point = point;
  }
}

export class DeterministicFaultInjector implements FaultInjector {
  private readonly remaining = new Map<FailurePoint, number>();

  constructor(plan: Partial<Record<FailurePoint, number>> = {}) {
    for (const point of FAILURE_POINTS) {
      const count = Number(plan[point] ?? 0);
      if (count > 0) this.remaining.set(point, Math.floor(count));
    }
  }

  arm(point: FailurePoint, count = 1): void {
    if (!Number.isSafeInteger(count) || count < 1)
      throw new ValidationError("fault count must be a positive integer");
    this.remaining.set(point, count);
  }

  clear(point?: FailurePoint): void {
    if (point) this.remaining.delete(point);
    else this.remaining.clear();
  }

  hit(point: FailurePoint): void {
    const count = this.remaining.get(point) ?? 0;
    if (count < 1) return;
    if (count === 1) this.remaining.delete(point);
    else this.remaining.set(point, count - 1);
    throw new InjectedProcessCrash(point);
  }
}

export const NO_FAULT_INJECTOR: FaultInjector = Object.freeze({
  hit: () => undefined,
});

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function boundedNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || number < min || number > max)
    throw new ValidationError(`${label} must be between ${min} and ${max}`);
  return number;
}

export function safeModelRetryPolicy(
  context: RetryPolicyContext,
): RetryDecision {
  const advice = context.providerAdvice;
  if (advice?.suggested === false || advice?.responseStarted) return false;

  // A Provider can positively identify a failure that happened before dispatch.
  // This is the only general replay-safe signal accepted by the Runtime.
  if (advice?.suggested === true && advice.replaySafety === "safe") {
    return {
      retry: true,
      delayMs: advice.retryAfterMs ?? context.normalized.retryAfterMs,
      reason: advice.reason ?? "provider marked replay as safe",
    };
  }

  // A rejected rate-limit request did not perform model work. Other timeouts,
  // network failures, and 5xx responses remain ambiguous and are not replayed.
  if (context.normalized.statusCode === 429) {
    return {
      retry: true,
      delayMs: advice?.retryAfterMs ?? context.normalized.retryAfterMs,
      reason: advice?.reason ?? "rate-limited before model execution",
    };
  }

  return false;
}

/**
 * Converts the persisted, JSON-only retry settings into the Runtime's bounded
 * in-process policy. Arbitrary callback policies are deliberately not loaded
 * from Agent definitions.
 */
export function withRuntimeModelRetry(
  modelSettings: Record<string, unknown> = {},
): ModelSettings {
  const raw = asRecord(modelSettings.retry) ?? {};
  const backoff = asRecord(raw.backoff) ?? {};
  const maxRetries = boundedNumber(
    raw.max_retries ?? raw.maxRetries,
    1,
    0,
    3,
    "model_settings.retry.max_retries",
  );
  if (!Number.isSafeInteger(maxRetries))
    throw new ValidationError(
      "model_settings.retry.max_retries must be an integer",
    );
  const initialDelayMs = boundedNumber(
    backoff.initial_delay_ms ?? backoff.initialDelayMs,
    250,
    0,
    60_000,
    "model_settings.retry.backoff.initial_delay_ms",
  );
  const maxDelayMs = boundedNumber(
    backoff.max_delay_ms ?? backoff.maxDelayMs,
    2_000,
    initialDelayMs,
    60_000,
    "model_settings.retry.backoff.max_delay_ms",
  );
  const multiplier = boundedNumber(
    backoff.multiplier,
    2,
    1,
    10,
    "model_settings.retry.backoff.multiplier",
  );

  return {
    ...modelSettings,
    retry: {
      maxRetries,
      policy: safeModelRetryPolicy,
      backoff: {
        initialDelayMs,
        maxDelayMs,
        multiplier,
        jitter: backoff.jitter === undefined ? true : Boolean(backoff.jitter),
      },
    },
  } as ModelSettings;
}

export function modelFailureCategory(error: unknown): string {
  if (error instanceof InjectedProcessCrash) return "process_crash";
  const value = asRecord(error);
  const status = Number(value?.status ?? value?.statusCode);
  const code = String(value?.code ?? "").toUpperCase();
  const name = error instanceof Error ? error.name : "Error";
  if (name === "AbortError") return "abort";
  if ([408, 504].includes(status) || /TIMEOUT|TIMEDOUT/.test(code))
    return "timeout";
  if (status === 429) return "rate_limit";
  if (/ECONN|ENET|EAI_AGAIN|FETCH/.test(code)) return "network";
  if (Number.isFinite(status) && status >= 500) return "provider_5xx";
  return "provider_error";
}
