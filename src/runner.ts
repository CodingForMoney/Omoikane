import {
  GuardrailExecutionError,
  InputGuardrailTripwireTriggered,
  OutputGuardrailTripwireTriggered,
  RunContext,
  Runner,
  RunState,
  type AgentInputItem,
  type RunToolApprovalItem,
  type StreamedRunResult,
} from "@openai/agents";
import type { Settings } from "./config.js";
import type { Database } from "./database.js";
import { ConflictError, ValidationError, required } from "./database.js";
import type { AgentFactory } from "./agent-factory.js";
import type { EventStore } from "./events.js";
import type { ProviderService } from "./providers.js";
import type { UsageEvidence, UsageService } from "./usage.js";
import type { CompactionService } from "./compaction.js";
import {
  CompactionAwareModel,
  CompactionRunController,
} from "./compaction/runtime.js";
import type { ArtifactService } from "./artifacts.js";
import {
  OPENAI_AGENTS_SDK_VERSION,
  RUN_STATE_FORMAT_VERSION,
} from "./runtime-versions.js";
import { hashJson, newId } from "./serialization.js";
import type { RuntimeContext, ToolService } from "./tools.js";
import type { SandboxHandle, SandboxService } from "./sandbox.js";
import {
  invalidStructuredOutputJson,
  parseAndValidateStructuredOutput,
  StructuredOutputError,
} from "./structured-output.js";
import { InjectedProcessCrash, type FaultInjector } from "./recovery.js";
import { safeErrorType, type ObservabilityService } from "./observability.js";
import {
  decodePageCursor,
  pageFromRows,
  pageLimit,
  type PageOptions,
} from "./pagination.js";
import {
  ModelStreamEventNormalizer,
  sanitizeReasoningItem,
  sanitizeReasoningRunItem,
  type NormalizedModelStreamEvent,
} from "./model-stream-events.js";
import {
  collectReasoningMetadata,
  providerReasoningTokensFromUsage,
} from "./reasoning-metadata.js";

export interface RunRow extends Record<string, unknown> {
  id: string;
  deployment_id: string;
  external_session_id: string | null;
  parent_run_id: string | null;
  status: string;
  input_json: string | AgentInputItem[];
  output_json: unknown;
  error_json: Record<string, unknown> | null;
  limits_json: Record<string, unknown>;
  context_json: Record<string, unknown>;
  conversation_json: AgentInputItem[];
  new_items_json: AgentInputItem[];
  projection_json: Record<string, unknown> | null;
  compaction_state_json: Record<string, unknown>;
  usage_json: Record<string, unknown>;
  execution_expires_at: string | null;
  payload_purged_at: string | null;
  idempotency_key: string | null;
  request_hash: string | null;
  sdk_version: string;
  config_hash: string;
  trace_id: string;
  version: number;
  execution_attempt: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  cancel_requested: boolean;
  created_at: string;
  updated_at: string;
  /** Attempt-scoped SDK trace ID; persisted in the run.started Event. */
  sdk_trace_id?: string;
}
export interface RunSummaryRow extends Record<string, unknown> {
  id: string;
  deployment_id: string;
  external_session_id: string | null;
  parent_run_id: string | null;
  status: string;
  error_code: string | null;
  trace_id: string;
  execution_attempt: number;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  cancel_requested: boolean;
  payload_purged_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}
const terminal = new Set(["completed", "failed", "cancelled"]);
const interruptionId = (item: RunToolApprovalItem) => {
  const raw = item.rawItem as unknown as Record<string, unknown>;
  return String(raw.callId ?? raw.call_id ?? raw.id ?? hashJson(raw));
};
const jsonValue = (value: unknown) => (value === undefined ? null : value);

interface GuardrailFailure {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

const guardrailFailure = (error: unknown): GuardrailFailure | undefined => {
  if (
    error instanceof InputGuardrailTripwireTriggered ||
    error instanceof OutputGuardrailTripwireTriggered
  ) {
    const stage =
      error instanceof InputGuardrailTripwireTriggered ? "input" : "output";
    const info =
      error.result.output.outputInfo &&
      typeof error.result.output.outputInfo === "object" &&
      !Array.isArray(error.result.output.outputInfo)
        ? (error.result.output.outputInfo as Record<string, unknown>)
        : {};
    const runtimeCode = String(
      info.runtime_code ?? `${stage}_guardrail_blocked`,
    );
    const allowedCodes = new Set([
      "input_guardrail_blocked",
      "output_guardrail_blocked",
      "guardrail_timeout",
      "guardrail_execution_failed",
    ]);
    const code = allowedCodes.has(runtimeCode)
      ? runtimeCode
      : `${stage}_guardrail_blocked`;
    return {
      code,
      message:
        typeof info.message === "string"
          ? info.message.slice(0, 512)
          : `${stage} was blocked by a configured Guardrail`,
      details: {
        stage,
        ...(typeof info.guardrail_id === "string"
          ? { guardrail_id: info.guardrail_id }
          : {}),
        ...(typeof info.implementation_key === "string"
          ? { implementation_key: info.implementation_key }
          : {}),
        ...(typeof info.policy_code === "string"
          ? { policy_code: info.policy_code }
          : {}),
      },
    };
  }
  if (error instanceof GuardrailExecutionError)
    return {
      code: "guardrail_execution_failed",
      message: "Guardrail execution failed",
      details: {},
    };
  return undefined;
};

const chunksByUtf8Bytes = (value: string, maximumBytes: number): string[] => {
  if (!value) return [];
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (current && currentBytes + characterBytes > maximumBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += characterBytes;
  }
  if (current) chunks.push(current);
  return chunks;
};

interface ExecutionPayload {
  input: string | AgentInputItem[];
  conversation: AgentInputItem[];
  context: Record<string, unknown>;
}

export class RunnerService {
  private readonly workerId: string;
  private stopped = false;
  private readonly controllers = new Map<string, AbortController>();
  private configuredWorkers = 0;
  private activeWorkers = 0;
  private workerLastActivityAt: string | null = null;
  private maintenanceConfigured = false;
  private maintenanceActive = false;
  private maintenanceLastSuccessAt: string | null = null;
  private maintenanceLastFailureAt: string | null = null;
  constructor(
    private readonly db: Database,
    private readonly settings: Settings,
    private readonly events: EventStore,
    private readonly factory: AgentFactory,
    private readonly providers: ProviderService,
    private readonly usage: UsageService,
    private readonly compaction: CompactionService,
    private readonly sandbox: SandboxService,
    private readonly tools: ToolService,
    private readonly artifacts: ArtifactService,
    private readonly faults: FaultInjector,
    private readonly observability: ObservabilityService,
  ) {
    this.workerId = `local:${process.pid}:${newId()}`;
  }
  configureWorkers(count: number, maintenance: boolean) {
    this.configuredWorkers = count;
    this.maintenanceConfigured = maintenance;
  }
  async create(input: {
    deploymentId: string;
    input: string | AgentInputItem[];
    conversation?: AgentInputItem[];
    projection?: Record<string, unknown>;
    externalSessionId?: string;
    context?: Record<string, unknown>;
    limits?: Record<string, unknown>;
    idempotencyKey?: string;
    parentRunId?: string;
  }) {
    let requestHash: string | undefined;
    const acceptExisting = (existing: RunRow) => {
      if (!requestHash || existing.request_hash !== requestHash)
        throw new ConflictError(
          "idempotency key was already used with a different request",
        );
      return existing;
    };
    try {
      return await this.db.transaction(async (tx) => {
        const version = await required<Record<string, unknown>>(
          tx,
          "SELECT * FROM resources WHERE id=$1 AND kind='agent_deployment'",
          [input.deploymentId],
          "Agent deployment not found",
        );
        if (version.status !== "active")
          throw new ValidationError("run requires an active Agent deployment");
        const data = version.data as Record<string, unknown>;
        const config = data.config as Record<string, unknown>;
        const mergedLimits = {
          ...((config.runtime_policy ?? {}) as object),
          ...(input.limits ?? {}),
        };
        if (Object.hasOwn(mergedLimits, "max_cost_usd"))
          throw new ValidationError(
            "max_cost_usd is not supported; configure financial limits with the Provider and use Omoikane Usage for token accounting",
          );
        const initialProjection = input.projection;
        if (initialProjection)
          this.compaction.validateProjection(initialProjection);
        const initialConversation = initialProjection
          ? (initialProjection.items as AgentInputItem[])
          : (input.conversation ?? []);
        requestHash = hashJson({
          deployment_id: input.deploymentId,
          input: input.input,
          conversation: initialConversation,
          ...(initialProjection ? { projection: initialProjection } : {}),
          external_session_id: input.externalSessionId ?? null,
          context: input.context ?? {},
          limits: mergedLimits,
          parent_run_id: input.parentRunId ?? null,
        });
        if (input.idempotencyKey) {
          const existing = (
            await tx.query<RunRow>(
              "SELECT * FROM runs WHERE idempotency_key=$1",
              [input.idempotencyKey],
            )
          ).rows[0];
          if (existing) return acceptExisting(existing);
        }
        const id = newId();
        const run = await required<RunRow>(
          tx,
          `INSERT INTO runs(id,deployment_id,external_session_id,parent_run_id,input_json,limits_json,context_json,conversation_json,projection_json,idempotency_key,request_hash,sdk_version,config_hash,trace_id)
          VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14) RETURNING *`,
          [
            id,
            input.deploymentId,
            input.externalSessionId ?? null,
            input.parentRunId ?? null,
            JSON.stringify(input.input),
            JSON.stringify(mergedLimits),
            JSON.stringify(input.context ?? {}),
            JSON.stringify(initialConversation),
            JSON.stringify(initialProjection ?? null),
            input.idempotencyKey ?? null,
            requestHash,
            OPENAI_AGENTS_SDK_VERSION,
            String(data.config_hash),
            newId(),
          ],
        );
        await this.events.appendInTransaction(tx, id, "run.created", {
          status: "queued",
        });
        return run;
      });
    } catch (error) {
      if (input.idempotencyKey) {
        const existing = (
          await this.db.query<RunRow>(
            "SELECT * FROM runs WHERE idempotency_key=$1",
            [input.idempotencyKey],
          )
        ).rows[0];
        if (existing) return acceptExisting(existing);
      }
      throw error;
    }
  }
  async get(id: string) {
    return required<RunRow>(
      this.db,
      "SELECT * FROM runs WHERE id=$1",
      [id],
      "run not found",
    );
  }
  async list(
    options: PageOptions & {
      status?: string;
      deploymentId?: string;
      externalSessionId?: string;
      parentRunId?: string;
    } = {},
  ) {
    const limit = pageLimit(options.limit);
    const scope = JSON.stringify([
      "runs",
      options.status ?? null,
      options.deploymentId ?? null,
      options.externalSessionId ?? null,
      options.parentRunId ?? null,
    ]);
    const cursor = decodePageCursor(options.cursor, scope);
    const conditions: string[] = [];
    const params: unknown[] = [];
    const equal = (column: string, value: string | undefined) => {
      if (value === undefined) return;
      params.push(value);
      conditions.push(`${column}=$${params.length}`);
    };
    equal("status", options.status);
    equal("deployment_id", options.deploymentId);
    equal("external_session_id", options.externalSessionId);
    equal("parent_run_id", options.parentRunId);
    if (cursor) {
      params.push(cursor.createdAt);
      const createdAtParameter = params.length;
      params.push(cursor.id);
      conditions.push(
        `(created_at<$${createdAtParameter} OR (created_at=$${createdAtParameter} AND id<$${params.length}))`,
      );
    }
    params.push(limit + 1);
    const rows = await this.db.query<RunSummaryRow>(
      `SELECT id,deployment_id,external_session_id,parent_run_id,status,
              error_json->>'code' AS error_code,trace_id,execution_attempt,
              started_at,completed_at,cancel_requested,payload_purged_at,
              created_at,updated_at
       FROM runs${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY created_at DESC,id DESC LIMIT $${params.length}`,
      params,
    );
    const page = pageFromRows(rows.rows, limit, scope);
    const timestamp = (value: Date | string | null) =>
      value === null ? null : new Date(value).toISOString();
    return {
      ...page,
      data: page.data.map((row) => ({
        ...row,
        started_at: timestamp(row.started_at),
        completed_at: timestamp(row.completed_at),
        payload_purged_at: timestamp(row.payload_purged_at),
        created_at: timestamp(row.created_at)!,
        updated_at: timestamp(row.updated_at)!,
      })),
    };
  }
  private payload(run: RunRow): ExecutionPayload {
    return {
      input: run.input_json,
      conversation: run.conversation_json ?? [],
      context: run.context_json ?? {},
    };
  }
  private result(run: RunRow) {
    return {
      output: run.output_json,
      new_items: run.new_items_json ?? [],
      projection: run.projection_json,
    };
  }
  async publicRun(id: string) {
    const run = await this.get(id);
    const {
      input_json: _legacyInput,
      context_json: _legacyContext,
      conversation_json: _legacyConversation,
      output_json: _legacyOutput,
      new_items_json: _legacyItems,
      projection_json: _legacyProjection,
      ...safe
    } = run;
    return {
      ...safe,
      ...(run.payload_purged_at ? {} : this.result(run)),
    };
  }
  async reasoningMetadata(id: string) {
    const run = await this.get(id);
    return collectReasoningMetadata(
      id,
      await this.events.reasoningMetadata(id),
      providerReasoningTokensFromUsage(run.usage_json),
    );
  }
  async cancel(id: string) {
    this.controllers.get(id)?.abort("cancel requested");
    const updated = await this.db.transaction(async (tx) => {
      const run = await required<RunRow>(
        tx,
        "SELECT * FROM runs WHERE id=$1 FOR UPDATE",
        [id],
        "run not found",
      );
      if (terminal.has(run.status)) return run;
      const immediate = ["queued", "waiting_approval"].includes(run.status);
      const updated = await required<RunRow>(
        tx,
        `UPDATE runs SET cancel_requested=TRUE,status=$2,completed_at=CASE WHEN $3 THEN now() ELSE completed_at END,execution_expires_at=CASE WHEN $3 THEN now()+($4 || ' seconds')::interval ELSE execution_expires_at END,updated_at=now() WHERE id=$1 RETURNING *`,
        [
          id,
          immediate ? "cancelled" : run.status,
          immediate,
          this.settings.terminalPayloadTtlSeconds,
        ],
      );
      await this.events.appendInTransaction(
        tx,
        id,
        immediate ? "run.cancelled" : "run.cancel_requested",
        { requested: true },
      );
      return updated;
    });
    if (terminal.has(String(updated.status)))
      await this.cleanupTerminalSandbox(id);
    return updated;
  }
  async claim() {
    return this.db.transaction(async (tx) => {
      const run = (
        await tx.query<RunRow>(
          `SELECT * FROM runs WHERE status='queued' AND cancel_requested=FALSE ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
        )
      ).rows[0];
      if (!run) return undefined;
      const sdkTraceId = this.observability.tracingEnabled
        ? this.observability.newAttemptTraceId()
        : undefined;
      const updated = await required<RunRow>(
        tx,
        "UPDATE runs SET status='running',execution_attempt=execution_attempt+1,started_at=COALESCE(started_at,now()),lease_owner=$2,lease_expires_at=now()+($3 || ' seconds')::interval,updated_at=now() WHERE id=$1 RETURNING *",
        [run.id, this.workerId, this.settings.runLeaseSeconds],
      );
      await this.events.appendInTransaction(tx, run.id, "run.started", {
        worker_id: this.workerId,
        execution_attempt: updated.execution_attempt,
        execution_semantics: "at_least_once",
        ...(sdkTraceId ? { sdk_trace_id: sdkTraceId } : {}),
      });
      return {
        ...updated,
        ...(sdkTraceId ? { sdk_trace_id: sdkTraceId } : {}),
      };
    });
  }
  async decideApproval(
    id: string,
    decision: "approved" | "rejected",
    reason?: string,
  ) {
    return this.db.transaction(async (tx) => {
      const approval = await required<Record<string, unknown>>(
        tx,
        "SELECT * FROM approvals WHERE id=$1 FOR UPDATE",
        [id],
        "approval not found",
      );
      if (approval.status !== "pending") {
        if (approval.status === decision) return approval;
        throw new ConflictError("approval was already decided differently");
      }
      const run = await required<RunRow>(
        tx,
        "SELECT * FROM runs WHERE id=$1 FOR UPDATE",
        [approval.run_id],
      );
      if (run.status !== "waiting_approval")
        throw new ConflictError("run is not waiting for approval");
      const updated = await required(
        tx,
        "UPDATE approvals SET status=$2,decision_reason=$3,decided_at=now(),updated_at=now() WHERE id=$1 RETURNING *",
        [id, decision, reason ?? null],
      );
      const pending =
        (
          await tx.query<{ count: number }>(
            "SELECT count(*)::int count FROM approvals WHERE run_id=$1 AND status='pending' AND id<>$2",
            [run.id, id],
          )
        ).rows[0]?.count ?? 0;
      if (!pending)
        await tx.query(
          "UPDATE runs SET status='queued',lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",
          [run.id],
        );
      await this.events.appendInTransaction(tx, run.id, "approval.resolved", {
        approval_id: id,
        decision,
      });
      return updated;
    });
  }
  async listApprovals(options: PageOptions & { status?: string } = {}) {
    const limit = pageLimit(options.limit);
    const scope = JSON.stringify(["approvals", options.status ?? null]);
    const cursor = decodePageCursor(options.cursor, scope);
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (options.status) {
      params.push(options.status);
      conditions.push(`status=$${params.length}`);
    }
    if (cursor) {
      params.push(cursor.createdAt);
      const createdAtParameter = params.length;
      params.push(cursor.id);
      conditions.push(
        `(created_at<$${createdAtParameter} OR (created_at=$${createdAtParameter} AND id<$${params.length}))`,
      );
    }
    params.push(limit + 1);
    const rows = await this.db.query<
      Record<string, unknown> & { id: string; created_at: Date | string }
    >(
      `SELECT * FROM approvals${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY created_at DESC,id DESC LIMIT $${params.length}`,
      params,
    );
    return pageFromRows(rows.rows, limit, scope);
  }
  private async context(
    run: RunRow,
    config: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const payload = this.payload(run);
    const context: RuntimeContext = {
      ...payload.context,
      run_id: run.id,
      deployment_id: run.deployment_id,
    };
    let conversation = payload.conversation;
    let projection: Record<string, unknown> | null =
      run.projection_json ?? null;
    let compactionState = run.compaction_state_json ?? {};
    if (projection) {
      this.compaction.validateProjection(projection, config as never);
      if (Array.isArray(projection.items))
        conversation = projection.items as AgentInputItem[];
    }
    if (conversation.length) {
      const decision = await this.compaction.evaluate(
        conversation,
        config,
        payload.input,
      );
      context.compaction_policy = decision;
      if (decision.should_compact) {
        const compacted = await this.compaction.compact(conversation, config, {
          force: false,
          runId: run.id,
          trigger: "preflight",
          currentInput: payload.input,
          decision,
          signal,
        });
        if (compacted.status === "completed") {
          projection = compacted.projection as unknown as Record<
            string,
            unknown
          >;
          conversation = projection.items as AgentInputItem[];
          compactionState = {
            ...compactionState,
            revision: Number(projection.revision ?? 1),
            attempts: Number(compactionState.attempts ?? 0) + 1,
            ineffective_attempts: Number(
              compactionState.ineffective_attempts ?? 0,
            ),
            last_projection_id: compacted.id,
            last_input_checksum: hashJson(payload.conversation),
            last_effective_input_tokens: decision.estimated_tokens,
            verification_pending: true,
          };
          await this.db.transaction(async (tx) => {
            await tx.query(
              "UPDATE runs SET projection_json=$2::jsonb,compaction_state_json=$3::jsonb,updated_at=now() WHERE id=$1",
              [
                run.id,
                JSON.stringify(projection),
                JSON.stringify(compactionState),
              ],
            );
            await this.events.appendInTransaction(
              tx,
              run.id,
              "context.compacted",
              {
                compaction_id: compacted.id,
                trigger: "preflight",
                revision: compactionState.revision,
                metrics: compacted.metrics_json,
              },
            );
          });
        }
      }
    }
    const sandboxConfig = (config.sandbox ?? {}) as Record<string, unknown>;
    if (sandboxConfig.enabled) {
      const existing = context.sandbox as SandboxHandle | undefined;
      context.sandbox =
        existing ??
        (await this.sandbox.create({
          runId: run.id,
          cpuLimit: Number(sandboxConfig.cpu_limit ?? 1),
          memoryMb: Number(sandboxConfig.memory_mb ?? 512),
          diskMb: Number(sandboxConfig.disk_mb ?? 1024),
          timeoutSeconds: Number(sandboxConfig.timeout_seconds ?? 60),
          networkEnabled: Boolean(sandboxConfig.network_enabled),
          image: sandboxConfig.image ? String(sandboxConfig.image) : undefined,
        }));
      if (!existing) {
        await this.db.query(
          "UPDATE runs SET context_json=$2::jsonb,updated_at=now() WHERE id=$1",
          [run.id, JSON.stringify(context)],
        );
        await this.events.append(run.id, "sandbox.created", {
          id: context.sandbox.id,
          provider: context.sandbox.provider,
        });
      }
    }
    const currentInput =
      typeof payload.input === "string"
        ? ([{ role: "user", content: payload.input }] as AgentInputItem[])
        : payload.input;
    return {
      context,
      input: conversation.length
        ? [...conversation, ...currentInput]
        : payload.input,
      projection,
      compactionState,
    };
  }
  private async cleanupTerminalSandbox(runId: string) {
    const run = await this.get(runId);
    if (!terminal.has(run.status)) return false;
    const handle = run.context_json?.sandbox as SandboxHandle | undefined;
    if (!handle) return false;
    await this.sandbox.destroy(handle);
    return this.db.transaction(async (tx) => {
      const current = await required<RunRow>(
        tx,
        "SELECT * FROM runs WHERE id=$1 FOR UPDATE",
        [runId],
      );
      const currentHandle = current.context_json?.sandbox as
        SandboxHandle | undefined;
      if (!terminal.has(current.status) || currentHandle?.id !== handle.id)
        return false;
      const { sandbox: _sandbox, ...context } = current.context_json;
      await tx.query(
        "UPDATE runs SET context_json=$2::jsonb,updated_at=now() WHERE id=$1",
        [runId, JSON.stringify(context)],
      );
      await this.events.appendInTransaction(tx, runId, "sandbox.destroyed", {
        id: handle.id,
      });
      return true;
    });
  }
  private async loadState(run: RunRow, agent: any, context: RuntimeContext) {
    const record = (
      await this.db.query<{
        format_version: number;
        sdk_version: string;
        state_json: Record<string, unknown>;
      }>("SELECT * FROM run_states WHERE run_id=$1", [run.id])
    ).rows[0];
    if (!record) return undefined;
    if (
      Number(record.format_version) !== RUN_STATE_FORMAT_VERSION ||
      record.sdk_version !== OPENAI_AGENTS_SDK_VERSION
    )
      throw new Error(
        `stored run state is incompatible: sdk=${record.sdk_version}, state=${record.format_version}`,
      );
    const state = await RunState.fromStringWithContext(
      agent,
      JSON.stringify(record.state_json),
      new RunContext(context),
      { contextStrategy: "replace" },
    );
    const approvals = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM approvals WHERE run_id=$1",
      [run.id],
    );
    const decisions = new Map(
      approvals.rows
        .filter((a) => a.status !== "pending")
        .map((a) => [String(a.interruption_id), a]),
    );
    for (const interruption of state.getInterruptions()) {
      const decision = decisions.get(interruptionId(interruption));
      if (!decision) throw new Error("resumed run has an unresolved approval");
      if (decision.status === "approved") state.approve(interruption);
      else
        state.reject(interruption, {
          message: String(decision.decision_reason ?? "Rejected by reviewer"),
        });
    }
    return state;
  }
  private async interrupt(
    run: RunRow,
    result: { state: RunState<any, any>; interruptions: RunToolApprovalItem[] },
  ) {
    const state = JSON.parse(result.state.toString()) as Record<
      string,
      unknown
    >;
    const expires = new Date(
      Date.now() +
        Number(
          run.limits_json.approval_timeout_seconds ??
            this.settings.defaultApprovalTimeoutSeconds,
        ) *
          1000,
    ).toISOString();
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO run_states(run_id,format_version,sdk_version,state_json) VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT(run_id) DO UPDATE SET format_version=excluded.format_version,sdk_version=excluded.sdk_version,state_json=excluded.state_json,updated_at=now()`,
        [
          run.id,
          RUN_STATE_FORMAT_VERSION,
          OPENAI_AGENTS_SDK_VERSION,
          JSON.stringify(state),
        ],
      );
      await tx.query(
        "UPDATE runs SET status='waiting_approval',lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",
        [run.id],
      );
      for (const item of result.interruptions) {
        const key = interruptionId(item);
        const existing = (
          await tx.query(
            "SELECT id FROM approvals WHERE run_id=$1 AND interruption_id=$2",
            [run.id, key],
          )
        ).rows[0];
        if (existing) continue;
        const id = newId();
        await tx.query(
          `INSERT INTO approvals(id,run_id,interruption_id,tool_name,request_json,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
          [
            id,
            run.id,
            key,
            item.name ?? item.toolName ?? "unknown",
            JSON.stringify(item.toJSON()),
            expires,
          ],
        );
        await this.events.appendInTransaction(tx, run.id, "approval.required", {
          approval_id: id,
          tool_name: item.name ?? item.toolName ?? "unknown",
          request: item.toJSON(),
          expires_at: expires,
        });
      }
      await this.faults.hit("approval.before_commit", {
        run_id: run.id,
        approval_count: result.interruptions.length,
      });
    });
  }
  private async recordUsage(
    run: RunRow,
    result: any,
    config: Record<string, unknown>,
    evidence: UsageEvidence,
  ) {
    const usage = result.runContext.usage;
    const provider = String((config.provider as Record<string, unknown>).name);
    const model = String(config.model);
    await this.db.transaction(async (tx) => {
      const records = await this.usage.record(tx, {
        runId: run.id,
        provider,
        model,
        usage,
        evidence,
      });
      await this.events.appendInTransaction(tx, run.id, "usage.updated", {
        usage_id: records.usage.id,
        reporting_status: records.summary.reporting_status,
        requests: records.summary.requests,
        input_tokens: records.summary.input_tokens,
        output_tokens: records.summary.output_tokens,
        total_tokens: records.summary.total_tokens,
      });
    });
  }
  private async execute(run: RunRow, signal: AbortSignal) {
    const versionRaw = await required<{ data: Record<string, unknown> }>(
      this.db,
      "SELECT data FROM resources WHERE id=$1 AND kind='agent_deployment'",
      [run.deployment_id],
      "Agent deployment not found",
    );
    const config = await this.providers.resolveConfig({
      ...((versionRaw.data.config ?? {}) as Record<string, unknown>),
    });
    const prepared = await this.context(run, config, signal);
    const context = prepared.context;
    const compactionController = new CompactionRunController(
      run.id,
      this.db,
      this.events,
      this.compaction,
      prepared.compactionState,
      prepared.projection,
    );
    const built = await this.factory.build(
      run.deployment_id,
      context,
      new Set<string>(),
      {
        modelDecorator: (model, agentConfig) =>
          new CompactionAwareModel(
            model,
            compactionController,
            agentConfig,
            this.faults,
          ),
      },
    );
    const previousBindings = new Set(
      (context.skill_bindings ?? []).map((binding) =>
        String(binding.version_id),
      ),
    );
    context.skill_bindings = built.skillBindings.map((binding) => ({
      version_id: binding.version_id,
      skill_id: binding.skill_id,
      slug: binding.slug,
      name: binding.name,
      content_hash: binding.content_hash,
      workspace: binding.workspace,
      entrypoints: binding.entrypoints,
      requirements: binding.requirements,
      file_count: binding.file_count,
    }));
    if (built.skillBindings.length) {
      await this.db.query(
        "UPDATE runs SET context_json=$2::jsonb,updated_at=now() WHERE id=$1",
        [run.id, JSON.stringify(context)],
      );
      for (const binding of built.skillBindings) {
        if (previousBindings.has(binding.version_id)) continue;
        await this.events.append(run.id, "skill.prepared", {
          version_id: binding.version_id,
          skill_id: binding.skill_id,
          slug: binding.slug,
          content_hash: binding.content_hash,
          workspace: binding.workspace,
          file_count: binding.file_count,
        });
      }
    }
    let toolCalls = 0,
      handoffs = 0;
    const sdkTraceId =
      run.sdk_trace_id ??
      (this.observability.tracingEnabled
        ? this.observability.newAttemptTraceId()
        : undefined);
    const sdkRunner = new Runner({
      tracingDisabled: !this.observability.tracingEnabled,
      traceIncludeSensitiveData: false,
      workflowName: String(config.name ?? "Omoikane agent"),
      traceId: sdkTraceId,
      traceMetadata: {
        run_id: run.id,
        run_trace_id: run.trace_id,
        execution_attempt: String(run.execution_attempt),
        deployment_id: run.deployment_id,
        provider: String(
          (config.provider as Record<string, unknown>).name ?? "unknown",
        ),
        model: String(config.model),
      },
    });
    const usageEvidence: UsageEvidence = {
      responses: 0,
      responsesWithRawUsage: 0,
      rawUsage: [],
    };
    let activeResult: StreamedRunResult<RuntimeContext, any> | undefined;
    let usageRecorded = false;
    const modelEventNormalizer = new ModelStreamEventNormalizer(
      run.execution_attempt,
      { reasoning: config._capabilities?.reasoning },
    );
    const bufferedReasoningEvents: NormalizedModelStreamEvent[] = [];
    const publishModelEvents = async (
      normalizedEvents: NormalizedModelStreamEvent[],
    ) => {
      for (const normalized of normalizedEvents) {
        const reasoningMetadata = normalized.type.startsWith(
          "model.reasoning_metadata_",
        );
        if (built.outputGuardrailsBuffered && !reasoningMetadata) {
          // Delayed deltas have no streaming value after the Guardrail passes.
          // Retain only the bounded canonical summary snapshot for terminal
          // publication; the normalizer still accumulates any streamed deltas.
          if (normalized.type === "model.reasoning_summary_completed")
            bufferedReasoningEvents.push(normalized);
          continue;
        }
        await this.events.append(
          run.id,
          normalized.type,
          normalized.type === "model.output_delta"
            ? {
                ...normalized.data,
                provisional: Boolean(built.structuredOutput),
              }
            : { ...normalized.data },
        );
      }
    };
    sdkRunner.on("agent_start", async (_ctx, agent) => {
      await this.events.append(run.id, "agent.started", { agent: agent.name });
    });
    sdkRunner.on("agent_end", async (_ctx, agent, output) => {
      await this.events.append(run.id, "agent.completed", {
        agent: agent.name,
        ...(built.structuredOutput || built.outputGuardrailsBuffered
          ? {
              output_available: false,
              output_validation: built.outputGuardrailsBuffered
                ? "guardrail_buffered"
                : "pending",
            }
          : {
              output,
              output_available: true,
              output_validation: "not_required",
            }),
      });
    });
    sdkRunner.on("agent_handoff", async (_ctx, from, to) => {
      handoffs++;
      if (handoffs > Number(run.limits_json.max_handoffs ?? 20))
        throw new Error("maximum handoff count exceeded");
      await this.events.append(run.id, "handoff.started", {
        from_agent: from.name,
        to_agent: to.name,
      });
    });
    sdkRunner.on("agent_tool_start", async (_ctx, agent, tool, details) => {
      toolCalls++;
      if (toolCalls > Number(run.limits_json.max_tool_calls ?? 50))
        throw new Error("maximum tool call count exceeded");
      await this.events.append(run.id, "tool.called", {
        agent: agent.name,
        tool: tool.name,
        tool_call: details.toolCall,
      });
    });
    sdkRunner.on(
      "agent_tool_end",
      async (_ctx, agent, tool, output, details) => {
        await this.events.append(run.id, "tool.completed", {
          agent: agent.name,
          tool: tool.name,
          output,
          tool_call: details.toolCall,
        });
      },
    );
    try {
      const state = await this.loadState(run, built.agent, context);
      const result = (activeResult = (await sdkRunner.run(
        built.agent,
        (state ?? prepared.input) as any,
        {
          stream: true,
          context: state ? undefined : context,
          maxTurns: Number(run.limits_json.max_turns ?? 20),
          signal,
        } as any,
      )) as StreamedRunResult<RuntimeContext, any>);
      for await (const event of result) {
        if (event.type === "raw_model_stream_event") {
          const data = event.data as unknown as Record<string, unknown>;
          const type = String(data.type);
          if (type === "response_done") {
            usageEvidence.responses += 1;
            const response = data.response as
              Record<string, unknown> | undefined;
            const rawUsage = response?.rawUsage;
            if (
              rawUsage &&
              typeof rawUsage === "object" &&
              !Array.isArray(rawUsage)
            ) {
              usageEvidence.responsesWithRawUsage += 1;
              usageEvidence.rawUsage.push(rawUsage as Record<string, unknown>);
            }
          }
          await publishModelEvents(modelEventNormalizer.consume(data));
        } else if (event.type === "run_item_stream_event") {
          const bufferedGuardrailItem =
            built.outputGuardrailsBuffered &&
            (event.name === "message_output_created" ||
              event.name === "reasoning_item_created");
          await this.events.append(
            run.id,
            event.name,
            bufferedGuardrailItem
              ? {
                  item_available: false,
                  output_validation: "guardrail_buffered",
                }
              : built.structuredOutput &&
                  event.name === "message_output_created"
                ? {
                    item_available: false,
                    output_validation: "pending",
                  }
                : {
                    item:
                      event.name === "reasoning_item_created"
                        ? sanitizeReasoningRunItem(event.item.toJSON())
                        : event.item.toJSON(),
                  },
          );
          if (event.name === "reasoning_item_created")
            await publishModelEvents(
              modelEventNormalizer.consumeReasoningItem(event.item.rawItem),
            );
        } else if (event.type === "agent_updated_stream_event")
          await this.events.append(run.id, "agent.updated", {
            agent: event.agent.name,
          });
      }
      try {
        await result.completed;
      } catch (error) {
        if (built.structuredOutput && error instanceof SyntaxError)
          throw invalidStructuredOutputJson(built.structuredOutput.mode);
        throw error;
      }
      await publishModelEvents(modelEventNormalizer.flush());
      await this.recordUsage(run, result, config, usageEvidence);
      usageRecorded = true;
      if (result.interruptions.length) {
        await this.interrupt(run, result);
        return;
      }
      let output: unknown;
      try {
        output = built.structuredOutput
          ? parseAndValidateStructuredOutput(
              result.finalOutput,
              built.structuredOutput,
            )
          : jsonValue(result.finalOutput);
      } catch (error) {
        if (built.structuredOutput && error instanceof SyntaxError)
          throw invalidStructuredOutputJson(built.structuredOutput.mode);
        throw error;
      }
      const newItems = result.newItems
        .map((item) => sanitizeReasoningItem(item.rawItem))
        .filter((item): item is AgentInputItem => Boolean(item));
      let committedStatus = "completed";
      await this.db.transaction(async (tx) => {
        const current = await required<RunRow>(
          tx,
          "SELECT * FROM runs WHERE id=$1 FOR UPDATE",
          [run.id],
        );
        const cancelled = current.cancel_requested;
        committedStatus = cancelled ? "cancelled" : "completed";
        await tx.query(
          "UPDATE runs SET status=$2,output_json=$3::jsonb,new_items_json=$4::jsonb,projection_json=$5::jsonb,completed_at=now(),execution_expires_at=now()+($6 || ' seconds')::interval,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",
          [
            run.id,
            cancelled ? "cancelled" : "completed",
            JSON.stringify(output),
            JSON.stringify(newItems),
            JSON.stringify(compactionController.latestProjection),
            this.settings.terminalPayloadTtlSeconds,
          ],
        );
        await tx.query("DELETE FROM run_states WHERE run_id=$1", [run.id]);
        if (!cancelled && built.outputGuardrailsBuffered)
          for (const normalized of bufferedReasoningEvents)
            await this.events.appendInTransaction(tx, run.id, normalized.type, {
              ...normalized.data,
              provisional: false,
              buffered: true,
            });
        if (!cancelled && built.outputGuardrailsBuffered) {
          const acceptedOutput =
            typeof output === "string"
              ? output
              : (JSON.stringify(output) ?? "null");
          const chunks = chunksByUtf8Bytes(
            acceptedOutput,
            Math.max(128, this.settings.maxEventPayloadBytes - 1_024),
          );
          for (const [index, delta] of chunks.entries())
            await this.events.appendInTransaction(
              tx,
              run.id,
              "model.output_delta",
              {
                delta,
                source_type: "guardrail.accepted_output",
                provisional: false,
                buffered: true,
                chunk_index: index,
                chunk_count: chunks.length,
              },
            );
          await this.events.appendInTransaction(
            tx,
            run.id,
            "message_output_created",
            {
              item_available: false,
              output_validation: "passed",
              guardrails_passed: true,
            },
          );
        }
        await this.events.appendInTransaction(
          tx,
          run.id,
          cancelled ? "run.cancelled" : "run.completed",
          cancelled
            ? { reason: "cancel requested" }
            : {
                output_available: true,
                new_item_count: newItems.length,
                structured_output_validated: Boolean(built.structuredOutput),
                structured_output_mode: built.structuredOutput?.mode ?? null,
              },
        );
        await this.faults.hit("run.before_terminal_commit", {
          run_id: run.id,
          status: cancelled ? "cancelled" : "completed",
          execution_attempt: current.execution_attempt,
        });
      });
      await this.faults.hit("run.after_terminal_commit", {
        run_id: run.id,
        status: committedStatus,
      });
    } catch (error) {
      const partialUsage = activeResult?.runContext.usage;
      if (
        activeResult &&
        !usageRecorded &&
        (usageEvidence.responses > 0 || Number(partialUsage?.requests ?? 0) > 0)
      ) {
        try {
          await this.recordUsage(run, activeResult, config, usageEvidence);
          usageRecorded = true;
        } catch (usageError) {
          this.observability.logger.write("error", "run_usage_persist_failed", {
            run_id: run.id,
            error_type: safeErrorType(usageError),
          });
        }
      }
      await publishModelEvents(
        modelEventNormalizer.flushReasoningMetadata(
          signal.reason === "cancel requested" ? "cancelled" : "failed",
        ),
      );
      throw error;
    } finally {
      await built.close();
    }
  }
  async process(run: RunRow) {
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    const maxDuration =
      Number(run.limits_json.max_duration_seconds ?? 1800) * 1000;
    const timeout = setTimeout(
      () => controller.abort("run duration exceeded"),
      maxDuration,
    );
    const renewal = setInterval(
      () =>
        void this.db.query(
          "UPDATE runs SET lease_expires_at=now()+($2 || ' seconds')::interval WHERE id=$1 AND status='running' AND lease_owner=$3",
          [run.id, this.settings.runLeaseSeconds, this.workerId],
        ),
      Math.max(1000, this.settings.runLeaseSeconds * 333),
    );
    try {
      await this.execute(run, controller.signal);
    } catch (error) {
      if (error instanceof InjectedProcessCrash) throw error;
      await this.db.transaction(async (tx) => {
        const current = await required<RunRow>(
          tx,
          "SELECT * FROM runs WHERE id=$1 FOR UPDATE",
          [run.id],
        );
        if (terminal.has(current.status)) return;
        const cancelled =
          current.cancel_requested ||
          controller.signal.reason === "cancel requested";
        if (!cancelled)
          await tx.query(
            `UPDATE tool_executions
             SET status='unknown',error_json=$2::jsonb,lease_expires_at=NULL,updated_at=now()
             WHERE run_id=$1 AND status='running' AND side_effecting=TRUE`,
            [
              run.id,
              JSON.stringify({
                code: "result_commit_unknown",
                message:
                  "the side effect may have completed before its result was committed",
              }),
            ],
          );
        const unresolved = cancelled
          ? 0
          : ((
              await tx.query<{ count: number }>(
                "SELECT count(*)::int count FROM tool_executions WHERE run_id=$1 AND status='unknown'",
                [run.id],
              )
            ).rows[0]?.count ?? 0);
        if (unresolved) {
          await tx.query(
            "UPDATE runs SET status='waiting_reconciliation',error_json=$2::jsonb,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",
            [
              run.id,
              JSON.stringify({
                code: "tool_outcome_unknown",
                message: "a side-effecting Tool requires reconciliation",
              }),
            ],
          );
          await this.events.appendInTransaction(
            tx,
            run.id,
            "tool.reconciliation_required",
            { code: "tool_outcome_unknown", count: unresolved },
          );
          return;
        }
        const guardrail = guardrailFailure(error);
        const code = cancelled
          ? "cancelled"
          : controller.signal.aborted
            ? "run_timeout"
            : guardrail
              ? guardrail.code
              : error instanceof StructuredOutputError
                ? error.code
                : error instanceof Error
                  ? error.name
                  : "Error";
        const message = guardrail
          ? guardrail.message
          : error instanceof StructuredOutputError
            ? error.message
            : String(error).slice(0, 4000);
        const failure = {
          code,
          message,
          ...(guardrail
            ? { details: guardrail.details }
            : error instanceof StructuredOutputError
              ? { details: error.details }
              : {}),
        };
        await tx.query(
          "UPDATE runs SET status=$2,error_json=$3::jsonb,completed_at=now(),execution_expires_at=now()+($4 || ' seconds')::interval,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",
          [
            run.id,
            cancelled ? "cancelled" : "failed",
            JSON.stringify(failure),
            this.settings.terminalPayloadTtlSeconds,
          ],
        );
        await this.events.appendInTransaction(
          tx,
          run.id,
          cancelled ? "run.cancelled" : "run.failed",
          failure,
        );
      });
    } finally {
      clearTimeout(timeout);
      clearInterval(renewal);
      this.controllers.delete(run.id);
      try {
        await this.cleanupTerminalSandbox(run.id);
      } catch (error) {
        this.observability.logger.write("error", "sandbox_cleanup_failed", {
          run_id: run.id,
          cleanup_type: "terminal_sandbox",
          error_type: safeErrorType(error),
        });
      }
    }
  }
  async reap() {
    const expired = await this.db.query<RunRow>(
      "SELECT * FROM runs WHERE status='running' AND lease_expires_at<now()",
    );
    let recoveredRuns = 0;
    for (const run of expired.rows) {
      const recovered = await this.db.transaction(async (tx) => {
        const current = (
          await tx.query<RunRow>(
            "SELECT * FROM runs WHERE id=$1 AND status='running' AND lease_expires_at<now() FOR UPDATE",
            [run.id],
          )
        ).rows[0];
        if (!current) return false;
        const unresolved =
          (
            await tx.query<{ count: number }>(
              "SELECT count(*)::int count FROM tool_executions WHERE run_id=$1 AND status IN ('running','unknown')",
              [run.id],
            )
          ).rows[0]?.count ?? 0;
        if (unresolved) {
          await tx.query(
            "UPDATE tool_executions SET status='unknown',error_json=$2::jsonb,lease_expires_at=NULL,updated_at=now() WHERE run_id=$1 AND status='running'",
            [
              run.id,
              JSON.stringify({
                code: "worker_lost",
                message: "tool outcome may be unknown",
              }),
            ],
          );
          await tx.query(
            "UPDATE runs SET status='waiting_reconciliation',lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",
            [run.id],
          );
          await this.events.appendInTransaction(
            tx,
            run.id,
            "tool.reconciliation_required",
            { code: "tool_outcome_unknown" },
          );
        } else {
          await tx.query(
            "UPDATE runs SET status='queued',lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",
            [run.id],
          );
          await this.events.appendInTransaction(tx, run.id, "run.requeued", {
            reason: "worker_lease_expired",
            previous_execution_attempt: current.execution_attempt,
            execution_semantics: "at_least_once",
            model_replay_possible: true,
            provisional_events_invalidated: true,
          });
        }
        await this.faults.hit("maintenance.before_recovery_commit", {
          run_id: run.id,
          previous_execution_attempt: current.execution_attempt,
          waiting_reconciliation: unresolved > 0,
        });
        return true;
      });
      if (recovered) recoveredRuns++;
    }
    const approvals = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM approvals WHERE status='pending' AND expires_at<=now()",
      [],
    );
    for (const approval of approvals.rows)
      await this.db.transaction(async (tx) => {
        await tx.query(
          "UPDATE approvals SET status='expired',decision_reason='approval request expired',decided_at=now(),updated_at=now() WHERE id=$1",
          [approval.id],
        );
        await tx.query(
          "UPDATE runs SET status='failed',error_json=$2::jsonb,completed_at=now(),execution_expires_at=now()+($3 || ' seconds')::interval,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND status='waiting_approval'",
          [
            approval.run_id,
            JSON.stringify({
              code: "approval_timeout",
              message: "approval request expired",
            }),
            this.settings.terminalPayloadTtlSeconds,
          ],
        );
        await this.events.appendInTransaction(
          tx,
          String(approval.run_id),
          "approval.expired",
          { approval_id: approval.id },
        );
      });
    const terminalSandboxes = await this.db.query<{ id: string }>(
      "SELECT id FROM runs WHERE status IN ('completed','failed','cancelled') AND context_json->'sandbox' IS NOT NULL",
    );
    let cleanedSandboxes = 0;
    for (const run of terminalSandboxes.rows)
      if (await this.cleanupTerminalSandbox(run.id)) cleanedSandboxes += 1;
    const purged = await this.db.query(
      `UPDATE runs SET input_json='null'::jsonb,context_json='{}'::jsonb,conversation_json='[]'::jsonb,
       output_json='null'::jsonb,new_items_json='[]'::jsonb,projection_json=NULL,compaction_state_json='{}'::jsonb,error_json=NULL,payload_purged_at=now(),updated_at=now()
       WHERE status IN ('completed','failed','cancelled') AND payload_purged_at IS NULL AND execution_expires_at<=now()`,
    );
    if (purged.rowCount) {
      await this.db.query(
        "UPDATE tool_executions SET output_json=NULL,error_json=NULL WHERE run_id IN (SELECT id FROM runs WHERE payload_purged_at IS NOT NULL)",
      );
      await this.db.query(
        "UPDATE usage_records SET raw_json='{}'::jsonb WHERE run_id IN (SELECT id FROM runs WHERE payload_purged_at IS NOT NULL)",
      );
      await this.db.query(
        "UPDATE approvals SET request_json='{}'::jsonb,decision_reason=NULL WHERE run_id IN (SELECT id FROM runs WHERE payload_purged_at IS NOT NULL)",
      );
      await this.db.query(
        "DELETE FROM run_states WHERE run_id IN (SELECT id FROM runs WHERE payload_purged_at IS NOT NULL)",
      );
    }
    const deletedEvents = await this.db.query(
      "DELETE FROM run_events WHERE created_at<now()-($1 || ' seconds')::interval AND run_id IN (SELECT id FROM runs WHERE status IN ('completed','failed','cancelled'))",
      [this.settings.eventTtlSeconds],
    );
    const expiredArtifacts = await this.artifacts.reapExpired();
    return (
      recoveredRuns +
      approvals.rowCount +
      purged.rowCount +
      deletedEvents.rowCount +
      cleanedSandboxes +
      expiredArtifacts
    );
  }
  async processNext() {
    const run = await this.claim();
    if (!run) return false;
    this.workerLastActivityAt = new Date().toISOString();
    await this.process(run);
    this.workerLastActivityAt = new Date().toISOString();
    return true;
  }
  async runForever(signal?: AbortSignal, _workerIndex?: number) {
    this.activeWorkers += 1;
    try {
      while (!this.stopped && !signal?.aborted) {
        try {
          if (await this.processNext()) continue;
        } catch (error) {
          this.observability.logger.write("error", "worker_loop_failed", {
            worker_id: this.workerId,
            error_type: safeErrorType(error),
          });
        }
        if (!this.stopped && !signal?.aborted)
          await new Promise((resolve) =>
            setTimeout(resolve, this.settings.workerPollMs),
          );
      }
    } finally {
      this.activeWorkers = Math.max(0, this.activeWorkers - 1);
    }
  }
  async maintainForever(signal?: AbortSignal) {
    this.maintenanceActive = true;
    try {
      while (!this.stopped && !signal?.aborted) {
        try {
          await this.reap();
          this.maintenanceLastSuccessAt = new Date().toISOString();
        } catch (error) {
          this.maintenanceLastFailureAt = new Date().toISOString();
          this.observability.logger.write("error", "maintenance_loop_failed", {
            worker_id: this.workerId,
            error_type: safeErrorType(error),
          });
        }
        if (!this.stopped && !signal?.aborted)
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(this.settings.workerPollMs, 1_000)),
          );
      }
    } finally {
      this.maintenanceActive = false;
    }
  }
  async runtimeStatus() {
    const counts = await this.db.query<{ status: string; count: number }>(
      "SELECT status,count(*)::int count FROM runs GROUP BY status ORDER BY status",
    );
    const byStatus = Object.fromEntries(
      counts.rows.map((row) => [row.status, Number(row.count)]),
    );
    return {
      status: "ok" as const,
      uptime_seconds: Math.floor(process.uptime()),
      workers: {
        configured: this.configuredWorkers,
        active: this.activeWorkers,
        last_activity_at: this.workerLastActivityAt,
      },
      maintenance: {
        configured: this.maintenanceConfigured,
        active: this.maintenanceActive,
        last_success_at: this.maintenanceLastSuccessAt,
        last_failure_at: this.maintenanceLastFailureAt,
      },
      runs: {
        total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
        by_status: byStatus,
      },
      tracing: this.observability.status(),
    };
  }
  stop() {
    this.stopped = true;
    for (const controller of this.controllers.values())
      controller.abort("worker stopping");
  }
}
