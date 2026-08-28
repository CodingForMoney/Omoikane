import type { InputGuardrail, OutputGuardrail } from "@openai/agents";
import { ValidationError } from "./database.js";
import type { EventStore } from "./events.js";
import type { RuntimeContext } from "./tools.js";

export type GuardrailStage = "input" | "output";
export type GuardrailFailurePolicy = "block" | "allow";

export type GuardrailDecision =
  | {
      decision: "allow";
      metadata?: Record<string, unknown>;
    }
  | {
      decision: "block";
      code: string;
      message?: string;
      metadata?: Record<string, unknown>;
    };

export interface GuardrailExecutionContext {
  stage: GuardrailStage;
  value: unknown;
  runtime: Readonly<RuntimeContext>;
  config: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}

export type GuardrailImplementation = (
  context: GuardrailExecutionContext,
) => GuardrailDecision | Promise<GuardrailDecision>;

export interface GuardrailBinding {
  id: string;
  implementation_key: string;
  config: Record<string, unknown>;
  timeout_ms: number;
  on_error: GuardrailFailurePolicy;
}

export interface GuardrailConfiguration {
  input: GuardrailBinding[];
  output: GuardrailBinding[];
}

export interface BuiltGuardrails {
  inputGuardrails: InputGuardrail[];
  outputGuardrails: OutputGuardrail<any, RuntimeContext>[];
  buffersOutput: boolean;
}

const DEFAULT_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_BINDINGS_PER_STAGE = 100;
const MAX_PATTERN_LENGTH = 4_096;
const MAX_MESSAGE_LENGTH = 512;
const MAX_METADATA_BYTES = 512;
const IMPLEMENTATION_KEY = /^[A-Za-z0-9._/-]+$/;
const BINDING_ID = /^[A-Za-z0-9._-]{1,128}$/;
const DECISION_CODE = /^[A-Za-z0-9._/-]{1,128}$/;

const implementations = new Map<string, GuardrailImplementation>();

const asRecord = (value: unknown, location: string) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationError(`${location} must be an object`);
  return value as Record<string, unknown>;
};

const assertOnlyKeys = (
  value: Record<string, unknown>,
  allowed: string[],
  location: string,
) => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length)
    throw new ValidationError(
      `${location} contains unsupported fields: ${unknown.join(", ")}`,
    );
};

const stringifyCheckedValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
};

const builtinRegex: GuardrailImplementation = ({ value, config }) => {
  const patterns = config.deny_patterns as string[];
  const checked = stringifyCheckedValue(value);
  const matchIndex = patterns.findIndex((pattern) =>
    new RegExp(pattern, "i").test(checked),
  );
  return matchIndex >= 0
    ? {
        decision: "block",
        code: "regex_deny_match",
        message: "content was blocked by a configured Guardrail",
        metadata: { pattern_index: matchIndex },
      }
    : { decision: "allow" };
};

export const registerGuardrailImplementation = (
  key: string,
  implementation: GuardrailImplementation,
): void => {
  if (!IMPLEMENTATION_KEY.test(key))
    throw new ValidationError("invalid Guardrail implementation key");
  if (key.startsWith("builtin."))
    throw new ValidationError(
      "builtin Guardrail implementation keys are reserved",
    );
  implementations.set(key, implementation);
};

export const unregisterGuardrailImplementation = (key: string): boolean =>
  implementations.delete(key);

export const guardrailImplementationRegistered = (key: string): boolean =>
  key === "builtin.regex" || implementations.has(key);

const implementationFor = (key: string): GuardrailImplementation => {
  if (key === "builtin.regex") return builtinRegex;
  const implementation = implementations.get(key);
  if (!implementation)
    throw new ValidationError(
      `Guardrail implementation is not registered: ${key}`,
    );
  return implementation;
};

const validateRegexConfig = (
  config: Record<string, unknown>,
  location: string,
) => {
  assertOnlyKeys(config, ["deny_patterns"], location);
  if (!Array.isArray(config.deny_patterns) || !config.deny_patterns.length)
    throw new ValidationError(
      `${location}.deny_patterns must be a non-empty array`,
    );
  for (const [index, pattern] of config.deny_patterns.entries()) {
    if (
      typeof pattern !== "string" ||
      !pattern ||
      pattern.length > MAX_PATTERN_LENGTH
    )
      throw new ValidationError(
        `${location}.deny_patterns[${index}] must be a non-empty string no longer than ${MAX_PATTERN_LENGTH} characters`,
      );
    try {
      new RegExp(pattern, "i");
    } catch {
      throw new ValidationError(
        `${location}.deny_patterns[${index}] is not a valid regular expression`,
      );
    }
  }
};

const normalizeBinding = (
  value: unknown,
  stage: GuardrailStage,
  index: number,
): GuardrailBinding => {
  const location = `guardrails.${stage}[${index}]`;
  const record = asRecord(value, location);
  assertOnlyKeys(
    record,
    ["id", "implementation_key", "config", "timeout_ms", "on_error"],
    location,
  );
  const id = String(record.id ?? "");
  const implementationKey = String(record.implementation_key ?? "");
  if (!BINDING_ID.test(id))
    throw new ValidationError(`${location}.id is invalid`);
  if (!IMPLEMENTATION_KEY.test(implementationKey))
    throw new ValidationError(`${location}.implementation_key is invalid`);
  if (!guardrailImplementationRegistered(implementationKey))
    throw new ValidationError(
      `${location}.implementation_key is not registered: ${implementationKey}`,
    );
  const config =
    record.config === undefined
      ? {}
      : asRecord(record.config, `${location}.config`);
  const timeoutMs = Number(record.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  )
    throw new ValidationError(
      `${location}.timeout_ms must be an integer between 1 and ${MAX_TIMEOUT_MS}`,
    );
  const onError = String(record.on_error ?? "block");
  if (onError !== "block" && onError !== "allow")
    throw new ValidationError(`${location}.on_error must be block or allow`);
  if (implementationKey === "builtin.regex")
    validateRegexConfig(config, `${location}.config`);
  return {
    id,
    implementation_key: implementationKey,
    config,
    timeout_ms: timeoutMs,
    on_error: onError,
  };
};

const normalizeStage = (
  value: unknown,
  stage: GuardrailStage,
): GuardrailBinding[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new ValidationError(`guardrails.${stage} must be an array`);
  if (value.length > MAX_BINDINGS_PER_STAGE)
    throw new ValidationError(
      `guardrails.${stage} supports at most ${MAX_BINDINGS_PER_STAGE} entries`,
    );
  const normalized = value.map((binding, index) =>
    normalizeBinding(binding, stage, index),
  );
  const ids = new Set<string>();
  for (const binding of normalized) {
    if (ids.has(binding.id))
      throw new ValidationError(
        `guardrails.${stage} contains duplicate id: ${binding.id}`,
      );
    ids.add(binding.id);
  }
  return normalized;
};

/**
 * Validates and canonicalizes Guardrail configuration. The legacy regex shape
 * remains accepted so existing deployments keep their behavior.
 */
export function normalizeGuardrailConfiguration(
  value: unknown,
): GuardrailConfiguration {
  if (value === undefined || value === null) return { input: [], output: [] };
  const record = asRecord(value, "guardrails");
  assertOnlyKeys(
    record,
    ["input", "output", "input_deny_patterns", "output_deny_patterns"],
    "guardrails",
  );
  const hasNew = record.input !== undefined || record.output !== undefined;
  const hasLegacy =
    record.input_deny_patterns !== undefined ||
    record.output_deny_patterns !== undefined;
  if (hasNew && hasLegacy)
    throw new ValidationError(
      "guardrails cannot mix typed entries with legacy deny-pattern fields",
    );
  if (hasLegacy) {
    const legacyStage = (
      patterns: unknown,
      stage: GuardrailStage,
    ): GuardrailBinding[] => {
      if (patterns === undefined) return [];
      if (!Array.isArray(patterns))
        throw new ValidationError(
          `guardrails.${stage}_deny_patterns must be an array`,
        );
      if (!patterns.length) return [];
      return [
        normalizeBinding(
          {
            id: `legacy-${stage}-regex`,
            implementation_key: "builtin.regex",
            config: { deny_patterns: patterns },
          },
          stage,
          0,
        ),
      ];
    };
    return {
      input: legacyStage(record.input_deny_patterns, "input"),
      output: legacyStage(record.output_deny_patterns, "output"),
    };
  }
  return {
    input: normalizeStage(record.input, "input"),
    output: normalizeStage(record.output, "output"),
  };
}

const safeMetadata = (
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!metadata) return undefined;
  try {
    const encoded = JSON.stringify(metadata);
    if (Buffer.byteLength(encoded) > MAX_METADATA_BYTES)
      return { omitted: "metadata_too_large" };
    return JSON.parse(encoded) as Record<string, unknown>;
  } catch {
    return { omitted: "metadata_not_serializable" };
  }
};

const validateDecision = (value: unknown): GuardrailDecision => {
  const record = asRecord(value, "Guardrail decision");
  if (record.decision === "allow") {
    assertOnlyKeys(record, ["decision", "metadata"], "Guardrail decision");
    return {
      decision: "allow",
      ...(record.metadata === undefined
        ? {}
        : {
            metadata: asRecord(record.metadata, "Guardrail decision.metadata"),
          }),
    };
  }
  if (record.decision === "block") {
    assertOnlyKeys(
      record,
      ["decision", "code", "message", "metadata"],
      "Guardrail decision",
    );
    const code = String(record.code ?? "");
    if (!DECISION_CODE.test(code))
      throw new ValidationError("Guardrail block decision code is invalid");
    if (
      record.message !== undefined &&
      (typeof record.message !== "string" ||
        record.message.length > MAX_MESSAGE_LENGTH)
    )
      throw new ValidationError(
        `Guardrail block decision message must be no longer than ${MAX_MESSAGE_LENGTH} characters`,
      );
    return {
      decision: "block",
      code,
      ...(record.message === undefined ? {} : { message: record.message }),
      ...(record.metadata === undefined
        ? {}
        : {
            metadata: asRecord(record.metadata, "Guardrail decision.metadata"),
          }),
    };
  }
  throw new ValidationError("Guardrail decision must be allow or block");
};

const withTimeout = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new GuardrailTimeoutError());
          controller.abort("Guardrail timeout");
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

class GuardrailTimeoutError extends Error {
  constructor() {
    super("Guardrail execution timed out");
    this.name = "GuardrailTimeoutError";
  }
}

export class GuardrailService {
  constructor(private readonly events: EventStore) {}

  private async execute(
    stage: GuardrailStage,
    binding: GuardrailBinding,
    value: unknown,
    runtime: RuntimeContext,
  ) {
    const started = Date.now();
    const common = {
      guardrail_id: binding.id,
      stage,
      implementation_key: binding.implementation_key,
    };
    await this.events.append(runtime.run_id, "guardrail.started", common);
    try {
      const decision = validateDecision(
        await withTimeout(
          (signal) =>
            Promise.resolve(
              implementationFor(binding.implementation_key)({
                stage,
                value,
                runtime,
                config: binding.config,
                signal,
              }),
            ),
          binding.timeout_ms,
        ),
      );
      const durationMs = Date.now() - started;
      const metadata = safeMetadata(decision.metadata);
      if (decision.decision === "block") {
        await this.events.append(runtime.run_id, "guardrail.blocked", {
          ...common,
          duration_ms: durationMs,
          decision: "block",
          code: decision.code,
          ...(metadata ? { metadata } : {}),
        });
        return {
          tripwireTriggered: true,
          outputInfo: {
            ...common,
            decision: "block",
            runtime_code: `${stage}_guardrail_blocked`,
            policy_code: decision.code,
            message:
              decision.message ??
              `${stage} was blocked by a configured Guardrail`,
            ...(metadata ? { metadata } : {}),
          },
        };
      }
      await this.events.append(runtime.run_id, "guardrail.passed", {
        ...common,
        duration_ms: durationMs,
        decision: "allow",
        ...(metadata ? { metadata } : {}),
      });
      return {
        tripwireTriggered: false,
        outputInfo: {
          ...common,
          decision: "allow",
          ...(metadata ? { metadata } : {}),
        },
      };
    } catch (error) {
      const code =
        error instanceof GuardrailTimeoutError
          ? "guardrail_timeout"
          : "guardrail_execution_failed";
      await this.events.append(runtime.run_id, "guardrail.failed", {
        ...common,
        duration_ms: Date.now() - started,
        decision: binding.on_error === "allow" ? "allow" : "block",
        code,
        on_error: binding.on_error,
      });
      return {
        tripwireTriggered: binding.on_error === "block",
        outputInfo: {
          ...common,
          decision: binding.on_error === "block" ? "block" : "allow",
          runtime_code: code,
          message:
            code === "guardrail_timeout"
              ? "Guardrail execution timed out"
              : "Guardrail execution failed",
          on_error: binding.on_error,
        },
      };
    }
  }

  build(value: unknown): BuiltGuardrails {
    const config = normalizeGuardrailConfiguration(value);
    return {
      inputGuardrails: config.input.map((binding) => ({
        name: binding.id,
        runInParallel: false,
        execute: ({ input, context }) =>
          this.execute(
            "input",
            binding,
            input,
            context.context as RuntimeContext,
          ),
      })),
      outputGuardrails: config.output.map((binding) => ({
        name: binding.id,
        execute: ({ agentOutput, context }) =>
          this.execute("output", binding, agentOutput, context.context),
      })),
      buffersOutput: config.output.length > 0,
    };
  }
}
