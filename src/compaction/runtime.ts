import type {
  AgentInputItem,
  Model,
  ModelRequest,
  ModelResponse,
  StreamEvent,
} from "@openai/agents";
import type { Database } from "../database.js";
import type { EventStore } from "../events.js";
import { hashJson, newId } from "../serialization.js";
import type { CompactionService } from "../compaction.js";
import {
  InjectedProcessCrash,
  NO_FAULT_INJECTOR,
  modelFailureCategory,
  type FaultInjector,
} from "../recovery.js";
import {
  CalibratedTokenMeter,
  estimateItemsTokens,
  estimateModelRequest,
  providerInputTokens,
} from "./token-meter.js";
import type {
  CompactionProjectionV4,
  CompactionRuntimeState,
} from "./types.js";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export function isContextOverflow(error: unknown): boolean {
  const value = asRecord(error);
  const nested = asRecord(value?.error);
  const status = Number(value?.status ?? value?.statusCode ?? nested?.status);
  const code = String(value?.code ?? nested?.code ?? "");
  const message = String(
    value?.message ??
      nested?.message ??
      (error instanceof Error ? error.message : error),
  );
  return (
    ([400, 413].includes(status) &&
      /context|token|prompt|input|length|maximum/i.test(
        `${code} ${message}`,
      )) ||
    /context[_ ]length|maximum context|too many tokens|prompt is too long|input.*too long/i.test(
      `${code} ${message}`,
    )
  );
}

function itemsPrefixMatches(
  input: AgentInputItem[],
  prefix: AgentInputItem[],
): boolean {
  return (
    input.length >= prefix.length &&
    hashJson(input.slice(0, prefix.length)) === hashJson(prefix)
  );
}

export class CompactionRunController {
  private readonly meter = new CalibratedTokenMeter();
  private state: CompactionRuntimeState;
  private projection?: CompactionProjectionV4 | Record<string, unknown>;

  constructor(
    private readonly runId: string,
    private readonly db: Database,
    private readonly events: EventStore,
    private readonly service: CompactionService,
    initialState: Record<string, unknown> = {},
    initialProjection?: Record<string, unknown> | null,
  ) {
    this.state = {
      ...(initialState as unknown as CompactionRuntimeState),
      revision: Number(initialState.revision ?? 0),
      attempts: Number(initialState.attempts ?? 0),
      ineffective_attempts: Number(initialState.ineffective_attempts ?? 0),
    };
    this.projection = initialProjection ?? undefined;
  }

  get latestProjection(): Record<string, unknown> | null {
    return (this.projection as Record<string, unknown> | undefined) ?? null;
  }

  async modelCallStarted(
    request: ModelRequest,
    stream: boolean,
  ): Promise<string> {
    const callId = newId();
    await this.events.append(this.runId, "model.request_started", {
      call_id: callId,
      stream,
      input_checksum: hashJson(request.input),
      input_item_count: Array.isArray(request.input) ? request.input.length : 1,
      stateful: Boolean(request.previousResponseId || request.conversationId),
    });
    return callId;
  }

  async modelCallCompleted(
    callId: string,
    response?: Record<string, unknown>,
  ): Promise<void> {
    await this.events.append(this.runId, "model.request_completed", {
      call_id: callId,
      response_id: response?.responseId ?? response?.id ?? null,
      request_id: response?.requestId ?? null,
    });
  }

  async modelCallFailed(callId: string, error: unknown): Promise<void> {
    await this.events.append(this.runId, "model.request_failed", {
      call_id: callId,
      category: modelFailureCategory(error),
    });
  }

  private reuseProjection(input: AgentInputItem[]): AgentInputItem[] {
    const projection = this.projection;
    if (!projection || !Array.isArray(projection.items)) return input;
    const projected = projection.items as AgentInputItem[];
    if (itemsPrefixMatches(input, projected)) return input;
    const source = asRecord(projection.source);
    if (source) {
      const count = Number(source.item_count ?? 0);
      const from = Number(source.from_index ?? 0);
      if (
        from === 0 &&
        count > 0 &&
        input.length >= count &&
        hashJson(input.slice(0, count)) === source.checksum
      )
        return projection.strategy === "portable"
          ? [projected[0]!, ...input.slice(count)]
          : [...projected, ...input.slice(count)];
    }
    const projectionRecord = projection as unknown as Record<string, unknown>;
    const legacyFrom = Number(projectionRecord.source_from_index ?? 0);
    const legacyTo = Number(projectionRecord.source_to_index ?? -1);
    if (legacyFrom === 0 && legacyTo >= 0) {
      const count = legacyTo + 1;
      if (input.length >= count) return [...projected, ...input.slice(count)];
    }
    return input;
  }

  private async persist(
    projection: Record<string, unknown> | null,
    eventType?: string,
    event?: Record<string, unknown>,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(
        "UPDATE runs SET projection_json=$2::jsonb,compaction_state_json=$3::jsonb,updated_at=now() WHERE id=$1",
        [this.runId, JSON.stringify(projection), JSON.stringify(this.state)],
      );
      if (eventType && event)
        await this.events.appendInTransaction(tx, this.runId, eventType, event);
    });
  }

  async prepare(
    request: ModelRequest,
    config: Record<string, unknown>,
    force = false,
    trigger = "model_call",
  ): Promise<ModelRequest> {
    if (!Array.isArray(request.input) || request.input.length < 4)
      return request;
    const input = this.reuseProjection(request.input);
    const estimate = estimateModelRequest({ ...request, input });
    const calibratedItems = this.meter.estimateItems(input);
    const overhead = Math.max(
      0,
      estimate.total_tokens -
        estimate.input_tokens +
        calibratedItems -
        estimateItemsTokens(input),
    );
    const decision = await this.service.evaluate(
      input,
      config,
      undefined,
      overhead,
    );
    const policy = (config.compaction ?? {}) as Record<string, unknown>;
    const maxAttempts = Math.max(1, Number(policy.max_attempts_per_run ?? 2));
    const checksum = hashJson(input);
    if (!force && !decision.should_compact) return { ...request, input };
    if (this.state.attempts >= maxAttempts) return { ...request, input };
    if (!force && this.state.last_input_checksum === checksum)
      return { ...request, input };
    this.state.attempts += 1;
    this.state.last_input_checksum = checksum;
    await this.persist(this.latestProjection, "context.compaction_started", {
      trigger,
      attempt: this.state.attempts,
      input_checksum: checksum,
      estimated_input_tokens: decision.estimated_tokens,
      requested_strategy: String(
        (config.compaction as Record<string, unknown> | undefined)?.strategy ??
          "auto",
      ),
    });
    let compacted;
    try {
      compacted = await this.service.compact(input, config, {
        force: true,
        decision,
        requestOverheadTokens: overhead,
        trigger,
        runId: this.runId,
        sourceProjection: this.projection as
          Record<string, unknown> | undefined,
        recoveryRef: { run_id: this.runId },
        revision: this.state.revision + 1,
        signal: request.signal,
      });
    } catch (error) {
      const failure = asRecord(error);
      this.state.last_failure_code = String(
        failure?.code ?? (error instanceof Error ? error.name : "Error"),
      );
      await this.persist(this.latestProjection, "context.compaction_failed", {
        trigger,
        attempt: this.state.attempts,
        error_code: this.state.last_failure_code,
        ...(typeof failure?.nativeFallback === "string"
          ? { native_fallback: failure.nativeFallback }
          : {}),
        message:
          error instanceof Error
            ? error.message.slice(0, 1_024)
            : String(error).slice(0, 1_024),
      });
      throw error;
    }
    if (compacted.status !== "completed" || !compacted.projection)
      return { ...request, input };
    this.projection = compacted.projection as unknown as Record<
      string,
      unknown
    >;
    this.state.revision = Number(
      compacted.projection.revision ?? this.state.revision + 1,
    );
    this.state.last_projection_id = compacted.id;
    this.state.last_failure_code = undefined;
    this.state.last_effective_input_tokens = decision.estimated_tokens;
    this.state.verification_pending = true;
    const nativeFallback = compacted.metrics_json?.native_fallback;
    if (typeof nativeFallback === "string")
      await this.events.append(this.runId, "context.compaction_fallback", {
        trigger,
        attempt: this.state.attempts,
        native_failure_code: nativeFallback,
        selected_strategy: compacted.strategy,
      });
    await this.persist(this.latestProjection, "context.compacted", {
      compaction_id: compacted.id,
      trigger,
      revision: this.state.revision,
      metrics: compacted.metrics_json,
    });
    return { ...request, input: compacted.projection.items };
  }

  async observe(request: ModelRequest, usage: unknown): Promise<void> {
    const actual = providerInputTokens(usage);
    if (actual === undefined) return;
    const estimate = estimateModelRequest(request);
    this.meter.observe(estimate, actual);
    this.state.actual_input_tokens = actual;
    this.state.verification_pending = false;
    if (this.projection && Number(this.projection.version) === 4) {
      const validation = asRecord(this.projection.validation);
      if (validation) validation.actual_usage_verified = true;
    }
    await this.persist(this.latestProjection);
  }
}

export class CompactionAwareModel implements Model {
  constructor(
    private readonly inner: Model,
    private readonly controller: CompactionRunController,
    private readonly config: Record<string, unknown>,
    private readonly faults: FaultInjector = NO_FAULT_INJECTOR,
  ) {}

  private async request(request: ModelRequest): Promise<ModelResponse> {
    const callId =
      (await this.controller.modelCallStarted?.(request, false)) ?? newId();
    await this.faults.hit("model.before_request", { call_id: callId });
    try {
      const response = await this.inner.getResponse(request);
      await this.faults.hit("model.after_response", {
        call_id: callId,
        response_id: response.responseId,
      });
      await this.controller.observe(
        request,
        response.rawUsage ?? response.usage,
      );
      await this.controller.modelCallCompleted?.(
        callId,
        response as unknown as Record<string, unknown>,
      );
      return response;
    } catch (error) {
      if (!(error instanceof InjectedProcessCrash))
        await this.controller.modelCallFailed?.(callId, error);
      throw error;
    }
  }

  private async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
    const callId =
      (await this.controller.modelCallStarted?.(request, true)) ?? newId();
    await this.faults.hit("model.before_request", { call_id: callId });
    let response: Record<string, unknown> | undefined;
    try {
      for await (const event of this.inner.getStreamedResponse(request)) {
        const value = event as unknown as Record<string, unknown>;
        if (value.type === "response_done") {
          response = asRecord(value.response);
          await this.controller.observe(
            request,
            response?.rawUsage ?? response?.usage,
          );
        }
        yield event;
      }
      await this.faults.hit("model.after_response", {
        call_id: callId,
        response_id: response?.responseId ?? response?.id,
      });
      await this.controller.modelCallCompleted?.(callId, response);
    } catch (error) {
      if (!(error instanceof InjectedProcessCrash))
        await this.controller.modelCallFailed?.(callId, error);
      throw error;
    }
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    let prepared = await this.controller.prepare(request, this.config);
    try {
      return await this.request(prepared);
    } catch (error) {
      if (!isContextOverflow(error)) throw error;
      const retry = await this.controller.prepare(
        request,
        this.config,
        true,
        "context_overflow_retry",
      );
      if (hashJson(retry.input) === hashJson(prepared.input)) throw error;
      prepared = retry;
      return this.request(prepared);
    }
  }

  async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncIterable<StreamEvent> {
    let prepared = await this.controller.prepare(request, this.config);
    let emitted = false;
    try {
      for await (const event of this.stream(prepared)) {
        emitted = true;
        yield event;
      }
      return;
    } catch (error) {
      if (emitted || !isContextOverflow(error)) throw error;
      const retry = await this.controller.prepare(
        request,
        this.config,
        true,
        "context_overflow_retry",
      );
      if (hashJson(retry.input) === hashJson(prepared.input)) throw error;
      prepared = retry;
    }
    yield* this.stream(prepared);
  }

  getRetryAdvice(args: Parameters<NonNullable<Model["getRetryAdvice"]>>[0]) {
    return this.inner.getRetryAdvice?.(args);
  }
}
