import {
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
import type { MemoryService } from "./memory.js";
import type { ProviderService } from "./providers.js";
import type { CostService } from "./costs.js";
import type { CompactionService } from "./compaction.js";
import { StateCipher } from "./crypto.js";
import {
  OPENAI_AGENTS_SDK_VERSION,
  RUN_STATE_FORMAT_VERSION,
} from "./runtime-versions.js";
import { hashJson, newId } from "./serialization.js";
import { DatabaseSession, SessionService } from "./sessions.js";
import type { RuntimeContext, ToolService } from "./tools.js";
import type { SandboxHandle, SandboxService } from "./sandbox.js";

export interface RunRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  agent_version_id: string;
  session_id: string | null;
  parent_run_id: string | null;
  status: string;
  input_json: string | AgentInputItem[];
  output_json: unknown;
  error_json: Record<string, unknown> | null;
  limits_json: Record<string, unknown>;
  context_json: Record<string, unknown>;
  idempotency_key: string | null;
  sdk_version: string;
  runtime_generation: string;
  config_hash: string;
  trace_id: string;
  version: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  cancel_requested: boolean;
  created_at: string;
  updated_at: string;
}
const terminal = new Set(["completed", "failed", "cancelled"]);
const interruptionId = (item: RunToolApprovalItem) => {
  const raw = item.rawItem as unknown as Record<string, unknown>;
  return String(raw.callId ?? raw.call_id ?? raw.id ?? hashJson(raw));
};
const jsonValue = (value: unknown) => (value === undefined ? null : value);

export class RunnerService {
  private readonly cipher: StateCipher;
  private readonly workerId: string;
  private stopped = false;
  private readonly controllers = new Map<string, AbortController>();
  private readonly sessions: SessionService;
  constructor(
    private readonly db: Database,
    private readonly settings: Settings,
    private readonly events: EventStore,
    private readonly factory: AgentFactory,
    private readonly providers: ProviderService,
    private readonly memory: MemoryService,
    private readonly costs: CostService,
    private readonly compaction: CompactionService,
    private readonly sandbox: SandboxService,
    private readonly tools: ToolService,
  ) {
    this.cipher = new StateCipher(settings.runStateSecret);
    this.workerId = `${settings.runtimeGeneration}:${process.pid}:${newId()}`;
    this.sessions = new SessionService(db);
  }
  async create(input: {
    tenantId: string;
    agentVersionId: string;
    input: string | AgentInputItem[];
    sessionId?: string;
    context?: Record<string, unknown>;
    limits?: Record<string, unknown>;
    idempotencyKey?: string;
    parentRunId?: string;
  }) {
    if (this.settings.defaultDailyBudgetUsd !== undefined) {
      const start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      if (
        (await this.costs.tenantSpend(input.tenantId, start)) >=
        this.settings.defaultDailyBudgetUsd
      )
        throw new Error("tenant daily budget is exhausted");
    }
    return this.db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const existing = (
          await tx.query<RunRow>(
            "SELECT * FROM runs WHERE tenant_id=$1 AND idempotency_key=$2",
            [input.tenantId, input.idempotencyKey],
          )
        ).rows[0];
        if (existing) return existing;
      }
      const version = await required<Record<string, unknown>>(
        tx,
        "SELECT * FROM resources WHERE id=$1 AND tenant_id=$2 AND kind='agent_version'",
        [input.agentVersionId, input.tenantId],
        "agent version not found",
      );
      if (version.status !== "published")
        throw new ValidationError("run requires a published agent version");
      if (input.sessionId)
        await required(
          tx,
          "SELECT id FROM sessions WHERE id=$1 AND tenant_id=$2",
          [input.sessionId, input.tenantId],
          "session not found",
        );
      const data = version.data as Record<string, unknown>;
      const config = data.config as Record<string, unknown>;
      const mergedLimits = {
        ...((config.runtime_policy ?? {}) as object),
        ...(input.limits ?? {}),
      };
      const id = newId();
      const run = await required<RunRow>(
        tx,
        `INSERT INTO runs(id,tenant_id,agent_version_id,session_id,parent_run_id,input_json,limits_json,context_json,idempotency_key,sdk_version,runtime_generation,config_hash,trace_id)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13) RETURNING *`,
        [
          id,
          input.tenantId,
          input.agentVersionId,
          input.sessionId ?? null,
          input.parentRunId ?? null,
          JSON.stringify(input.input),
          JSON.stringify(mergedLimits),
          JSON.stringify(input.context ?? {}),
          input.idempotencyKey ?? null,
          OPENAI_AGENTS_SDK_VERSION,
          this.settings.runtimeGeneration,
          String(data.config_hash),
          newId(),
        ],
      );
      await this.events.appendInTransaction(tx, id, "run.created", {
        status: "queued",
      });
      return run;
    });
  }
  async get(tenantId: string, id: string) {
    return required<RunRow>(
      this.db,
      "SELECT * FROM runs WHERE id=$1 AND tenant_id=$2",
      [id, tenantId],
      "run not found",
    );
  }
  async cancel(tenantId: string, id: string) {
    this.controllers.get(id)?.abort("cancel requested");
    return this.db.transaction(async (tx) => {
      const run = await required<RunRow>(
        tx,
        "SELECT * FROM runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
        [id, tenantId],
        "run not found",
      );
      if (terminal.has(run.status)) return run;
      const immediate = ["queued", "waiting_approval"].includes(run.status);
      const updated = await required<RunRow>(
        tx,
        `UPDATE runs SET cancel_requested=TRUE,status=$3,completed_at=CASE WHEN $4 THEN now() ELSE completed_at END,updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        [id, tenantId, immediate ? "cancelled" : run.status, immediate],
      );
      await this.events.appendInTransaction(
        tx,
        id,
        immediate ? "run.cancelled" : "run.cancel_requested",
        { requested: true },
      );
      return updated;
    });
  }
  async claim() {
    return this.db.transaction(async (tx) => {
      const run = (
        await tx.query<RunRow>(
          `SELECT * FROM runs WHERE status='queued' AND cancel_requested=FALSE AND runtime_generation=$1 ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [this.settings.runtimeGeneration],
        )
      ).rows[0];
      if (!run) return undefined;
      const updated = await required<RunRow>(
        tx,
        "UPDATE runs SET status='running',started_at=COALESCE(started_at,now()),lease_owner=$2,lease_expires_at=now()+($3 || ' seconds')::interval,updated_at=now() WHERE id=$1 RETURNING *",
        [run.id, this.workerId, this.settings.runLeaseSeconds],
      );
      await this.events.appendInTransaction(tx, run.id, "run.started", {
        worker_id: this.workerId,
        runtime_generation: this.settings.runtimeGeneration,
      });
      return updated;
    });
  }
  async decideApproval(
    tenantId: string,
    id: string,
    decision: "approved" | "rejected",
    actorId: string,
    reason?: string,
  ) {
    return this.db.transaction(async (tx) => {
      const approval = await required<Record<string, unknown>>(
        tx,
        "SELECT * FROM approvals WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
        [id, tenantId],
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
        "UPDATE approvals SET status=$3,decided_by=$4,decision_reason=$5,decided_at=now(),updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *",
        [id, tenantId, decision, actorId, reason ?? null],
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
        actor_id: actorId,
      });
      return updated;
    });
  }
  private async context(
    run: RunRow,
    config: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const context: RuntimeContext = {
      ...run.context_json,
      tenant_id: run.tenant_id,
      run_id: run.id,
      agent_version_id: run.agent_version_id,
    };
    if (run.session_id) {
      const decision = await this.compaction.evaluate(
        run.session_id,
        config,
        run.input_json,
      );
      context.compaction_policy = decision;
      if (decision.should_compact) {
        const compacted = await this.compaction.compact(
          run.tenant_id,
          run.session_id,
          config,
          {
            force: false,
            runId: run.id,
            trigger: "preflight",
            currentInput: run.input_json,
            decision,
            signal,
          },
        );
        if (compacted.status === "completed")
          await this.events.append(run.id, "context.compacted", {
            compaction_id: compacted.id,
            session_id: run.session_id,
            metrics: compacted.metrics_json,
          });
      }
    }
    const memoryConfig = (config.memory ?? {}) as Record<string, unknown>;
    if (memoryConfig.enabled !== false) {
      const scopes: Array<[string, string]> = [
        ["agent", run.agent_version_id],
        ["global", "global"],
      ];
      for (const item of (context.memory_scopes ?? []) as Array<
        Record<string, unknown>
      >) {
        if (item.type && item.id)
          scopes.push([String(item.type), String(item.id)]);
      }
      context.retrieved_memories = await this.memory.retrieve(
        run.tenant_id,
        typeof run.input_json === "string"
          ? run.input_json
          : JSON.stringify(run.input_json),
        scopes,
        Number(memoryConfig.max_retrieved_items ?? 8),
      );
      if (context.retrieved_memories.length)
        await this.events.append(run.id, "memory.retrieved", {
          memory_ids: (
            context.retrieved_memories as Array<Record<string, unknown>>
          ).map((m) => m.id),
        });
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
    return context;
  }
  private async loadState(run: RunRow, agent: any, context: RuntimeContext) {
    const record = (
      await this.db.query<{
        format_version: number;
        sdk_version: string;
        encrypted_state: Uint8Array;
        checksum: string;
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
    const plaintext = this.cipher
      .decrypt(record.encrypted_state, record.checksum)
      .toString();
    const state = await RunState.fromStringWithContext(
      agent,
      plaintext,
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
    const plaintext = result.state.toString();
    const encrypted = this.cipher.encrypt(plaintext);
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
        `INSERT INTO run_states(run_id,format_version,sdk_version,encrypted_state,checksum) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(run_id) DO UPDATE SET format_version=excluded.format_version,sdk_version=excluded.sdk_version,encrypted_state=excluded.encrypted_state,checksum=excluded.checksum,updated_at=now()`,
        [
          run.id,
          RUN_STATE_FORMAT_VERSION,
          OPENAI_AGENTS_SDK_VERSION,
          encrypted.ciphertext,
          encrypted.checksum,
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
          `INSERT INTO approvals(id,tenant_id,run_id,interruption_id,tool_name,request_json,expires_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
          [
            id,
            run.tenant_id,
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
    });
  }
  private async recordUsage(
    run: RunRow,
    result: any,
    config: Record<string, unknown>,
  ) {
    const usage = result.runContext.usage;
    const provider = String((config.provider as Record<string, unknown>).name);
    const model = String(config.model);
    await this.costs.assertRunBudget(
      provider,
      model,
      usage.inputTokens,
      usage.outputTokens,
      run.limits_json.max_cost_usd === undefined
        ? undefined
        : Number(run.limits_json.max_cost_usd),
    );
    await this.db.transaction(async (tx) => {
      const records = await this.costs.record(tx, {
        tenantId: run.tenant_id,
        runId: run.id,
        provider,
        model,
        requests: usage.requests,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        raw: {
          requests: usage.requests,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          total_tokens: usage.totalTokens,
          request_usage_entries: usage.requestUsageEntries,
        },
      });
      await this.events.appendInTransaction(tx, run.id, "usage.updated", {
        usage_id: records.usage.id,
        requests: usage.requests,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        total_tokens: usage.totalTokens,
        cost: records.cost.amount,
        currency: records.cost.currency,
      });
    });
  }
  private async execute(run: RunRow, signal: AbortSignal) {
    const versionRaw = await required<{ data: Record<string, unknown> }>(
      this.db,
      "SELECT data FROM resources WHERE id=$1 AND kind='agent_version'",
      [run.agent_version_id],
      "agent version not found",
    );
    const config = await this.providers.resolveConfig(run.tenant_id, {
      ...((versionRaw.data.config ?? {}) as Record<string, unknown>),
    });
    const context = await this.context(run, config, signal);
    const built = await this.factory.build(
      run.tenant_id,
      run.agent_version_id,
      context,
    );
    let toolCalls = 0,
      handoffs = 0;
    const sdkRunner = new Runner({
      tracingDisabled:
        this.settings.tracingDisabled ||
        !Boolean(
          (config.tracing as Record<string, unknown> | undefined)?.enabled ??
          true,
        ),
      workflowName: String(config.name ?? "Omoikane agent"),
      traceMetadata: { run_id: run.id, tenant_id: run.tenant_id },
    });
    sdkRunner.on("agent_start", async (_ctx, agent) => {
      await this.events.append(run.id, "agent.started", { agent: agent.name });
    });
    sdkRunner.on("agent_end", async (_ctx, agent, output) => {
      await this.events.append(run.id, "agent.completed", {
        agent: agent.name,
        output,
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
      const result = (await sdkRunner.run(
        built.agent,
        (state ?? run.input_json) as any,
        {
          stream: true,
          context: state ? undefined : context,
          maxTurns: Number(run.limits_json.max_turns ?? 20),
          session: run.session_id
            ? new DatabaseSession(this.sessions, run.session_id)
            : undefined,
          signal,
        } as any,
      )) as StreamedRunResult<RuntimeContext, any>;
      for await (const event of result) {
        if (event.type === "raw_model_stream_event") {
          const data = event.data as unknown as Record<string, unknown>;
          const type = String(data.type);
          const delta = data.delta;
          if (typeof delta === "string" && delta) {
            const mapped =
              type === "response.output_text.delta"
                ? "model.output_delta"
                : type.includes("reasoning_summary")
                  ? "model.reasoning_summary_delta"
                  : type.includes("reasoning")
                    ? "model.reasoning_delta"
                    : undefined;
            if (mapped)
              await this.events.append(run.id, mapped, {
                delta,
                source_type: type,
              });
          }
        } else if (event.type === "run_item_stream_event")
          await this.events.append(run.id, event.name, {
            item: event.item.toJSON(),
          });
        else if (event.type === "agent_updated_stream_event")
          await this.events.append(run.id, "agent.updated", {
            agent: event.agent.name,
          });
      }
      await result.completed;
      await this.recordUsage(run, result, config);
      if (result.interruptions.length) {
        await this.interrupt(run, result);
        return;
      }
      const output = jsonValue(result.finalOutput);
      await this.db.transaction(async (tx) => {
        const current = await required<RunRow>(
          tx,
          "SELECT * FROM runs WHERE id=$1 FOR UPDATE",
          [run.id],
        );
        const cancelled = current.cancel_requested;
        await tx.query(
          "UPDATE runs SET status=$2,output_json=$3::jsonb,completed_at=now(),lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",
          [
            run.id,
            cancelled ? "cancelled" : "completed",
            JSON.stringify(output),
          ],
        );
        await tx.query("DELETE FROM run_states WHERE run_id=$1", [run.id]);
        await this.events.appendInTransaction(
          tx,
          run.id,
          cancelled ? "run.cancelled" : "run.completed",
          cancelled ? { reason: "cancel requested" } : { output },
        );
      });
      if (
        !(
          (config.memory as Record<string, unknown> | undefined)?.write_mode ===
          "disabled"
        )
      ) {
        const created = await this.memory.consolidateRun(run.tenant_id, {
          ...run,
          output_json: output,
        });
        if (created)
          await this.events.append(run.id, "memory.updated", {
            memory_id: created.id,
            kind: created.kind,
          });
      }
    } finally {
      await built.close();
      if (
        context.sandbox &&
        terminal.has(String((await this.get(run.tenant_id, run.id)).status))
      ) {
        await this.sandbox.destroy(context.sandbox);
        await this.events.append(run.id, "sandbox.destroyed", {
          id: context.sandbox.id,
        });
      }
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
        const code = cancelled
          ? "cancelled"
          : controller.signal.aborted
            ? "run_timeout"
            : error instanceof Error
              ? error.name
              : "Error";
        await tx.query(
          "UPDATE runs SET status=$2,error_json=$3::jsonb,completed_at=now(),lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",
          [
            run.id,
            cancelled ? "cancelled" : "failed",
            JSON.stringify({ code, message: String(error).slice(0, 4000) }),
          ],
        );
        await this.events.appendInTransaction(
          tx,
          run.id,
          cancelled ? "run.cancelled" : "run.failed",
          { code, message: String(error).slice(0, 4000) },
        );
      });
    } finally {
      clearTimeout(timeout);
      clearInterval(renewal);
      this.controllers.delete(run.id);
    }
  }
  async reap() {
    const expired = await this.db.query<RunRow>(
      "SELECT * FROM runs WHERE status='running' AND lease_expires_at<now() AND runtime_generation=$1",
      [this.settings.runtimeGeneration],
    );
    for (const run of expired.rows) {
      const unresolved =
        (
          await this.db.query<{ count: number }>(
            "SELECT count(*)::int count FROM tool_executions WHERE run_id=$1 AND status IN ('running','unknown')",
            [run.id],
          )
        ).rows[0]?.count ?? 0;
      await this.db.transaction(async (tx) => {
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
          });
        }
      });
    }
    const approvals = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM approvals WHERE status='pending' AND expires_at<=now()",
      [],
    );
    for (const approval of approvals.rows)
      await this.db.transaction(async (tx) => {
        await tx.query(
          "UPDATE approvals SET status='expired',decided_by='system',decision_reason='approval request expired',decided_at=now(),updated_at=now() WHERE id=$1",
          [approval.id],
        );
        await tx.query(
          "UPDATE runs SET status='failed',error_json=$2::jsonb,completed_at=now(),lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND status='waiting_approval'",
          [
            approval.run_id,
            JSON.stringify({
              code: "approval_timeout",
              message: "approval request expired",
            }),
          ],
        );
        await this.events.appendInTransaction(
          tx,
          String(approval.run_id),
          "approval.expired",
          { approval_id: approval.id },
        );
      });
    return expired.rowCount + approvals.rowCount;
  }
  async processNext() {
    const run = await this.claim();
    if (!run) return false;
    await this.process(run);
    return true;
  }
  async runForever(signal?: AbortSignal) {
    while (!this.stopped && !signal?.aborted) {
      await this.events.dispatchPending();
      await this.reap();
      if (!(await this.processNext()))
        await new Promise((resolve) =>
          setTimeout(resolve, this.settings.workerPollMs),
        );
    }
  }
  stop() {
    this.stopped = true;
    for (const controller of this.controllers.values())
      controller.abort("worker stopping");
  }
}
