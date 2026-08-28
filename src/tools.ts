import { tool, type FunctionTool, type RunContext } from "@openai/agents";
import type { ArtifactService } from "./artifacts.js";
import type { Database } from "./database.js";
import { ConflictError, ValidationError, required } from "./database.js";
import { ResourceStore } from "./resources.js";
import type { SandboxHandle, SandboxService } from "./sandbox.js";
import { hashJson, newId } from "./serialization.js";
import type { EventStore } from "./events.js";
import type { FaultInjector } from "./recovery.js";
import type { PageOptions } from "./pagination.js";

export interface RuntimeContext extends Record<string, unknown> {
  run_id: string;
  deployment_id: string;
  sandbox?: SandboxHandle;
  skill_bindings?: Array<Record<string, unknown>>;
}
export type ToolImplementation = (
  args: Record<string, unknown>,
  context: RuntimeContext,
) => unknown | Promise<unknown>;

const implementations = new Map<string, ToolImplementation>();
const removedMemoryImplementations = new Set([
  "builtin.memory_search",
  "builtin.memory_create",
]);
export const registerToolImplementation = (
  key: string,
  implementation: ToolImplementation,
): void => {
  if (!/^[A-Za-z0-9._/-]+$/.test(key))
    throw new ValidationError("invalid tool implementation key");
  implementations.set(key, implementation);
};
export const unregisterToolImplementation = (key: string): boolean =>
  implementations.delete(key);

export class ToolService {
  private readonly store: ResourceStore;
  private readonly builtins = new Map<string, ToolImplementation>();

  constructor(
    private readonly db: Database,
    artifacts: ArtifactService,
    sandbox: SandboxService,
    private readonly events: EventStore,
    private readonly faults: FaultInjector,
  ) {
    this.store = new ResourceStore(db);
    this.builtins.set("builtin.artifact_create", async (args, context) => {
      const data = args.content_base64
        ? Buffer.from(String(args.content_base64), "base64")
        : Buffer.from(String(args.content ?? ""));
      const artifact = await artifacts.create(
        String(args.filename ?? "artifact.txt"),
        data,
        {
          runId: context.run_id,
          mimeType: String(args.mime_type ?? "application/octet-stream"),
          source: "tool",
        },
      );
      return {
        artifact_id: artifact.id,
        filename: artifact.filename,
        size: artifact.size,
        sha256: artifact.sha256,
      };
    });
    this.builtins.set("builtin.sandbox_exec", (args, context) => {
      if (!context.sandbox)
        throw new ValidationError("sandbox is not enabled for this run");
      return sandbox.execute(
        context.sandbox,
        String(args.command),
        Array.isArray(args.args) ? args.args.map(String) : [],
      );
    });
  }

  async seed(): Promise<void> {
    const builtins = [
      {
        slug: "artifact-create",
        name: "artifact_create",
        description: "Create a temporary Run artifact from text or base64 data",
        implementation_key: "builtin.artifact_create",
        schema: {
          type: "object",
          properties: {
            filename: { type: "string" },
            content: { type: "string" },
            content_base64: { type: "string" },
            mime_type: { type: "string" },
          },
          required: ["filename"],
          additionalProperties: false,
        },
        policy: {},
      },
      {
        slug: "sandbox-exec",
        name: "sandbox_exec",
        description: "Execute one command inside the run sandbox",
        implementation_key: "builtin.sandbox_exec",
        schema: {
          type: "object",
          properties: {
            command: { type: "string" },
            args: { type: "array", items: { type: "string" } },
          },
          required: ["command"],
          additionalProperties: false,
        },
        policy: { requires_approval: true, side_effecting: true },
      },
    ];
    for (const item of builtins) {
      if (!(await this.store.findBySlug("tool", item.slug)))
        await this.create(item);
    }
  }

  async create(input: Record<string, unknown>) {
    const implementationKey = String(input.implementation_key);
    if (removedMemoryImplementations.has(implementationKey))
      throw new ValidationError(
        "built-in memory tools were removed; provide business memory through a custom Function Tool or MCP",
      );
    const suppliedPolicy = (input.policy ?? {}) as Record<string, unknown>;
    const policy = {
      ...suppliedPolicy,
      // A durable approval checkpoint is what lets the Runtime resume the
      // exact same Tool call and idempotency key after process loss.
      requires_approval: Boolean(
        suppliedPolicy.requires_approval || suppliedPolicy.side_effecting,
      ),
      side_effecting: Boolean(suppliedPolicy.side_effecting),
    };
    return this.store.create<Record<string, unknown>>({
      kind: "tool",
      slug: String(input.slug),
      name: String(input.name),
      data: {
        description: String(input.description),
        kind: String(input.kind ?? "function"),
        implementation_key: implementationKey,
        schema: input.schema ?? {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        policy,
      },
    });
  }

  async list() {
    const tools = await this.store.list<Record<string, unknown>>("tool");
    return tools.filter(
      (record) =>
        !removedMemoryImplementations.has(String(record.implementation_key)),
    );
  }

  async page(options: PageOptions & { status?: string } = {}) {
    const page = await this.store.page<Record<string, unknown>>(
      "tool",
      options,
    );
    return {
      ...page,
      data: page.data.filter(
        (record) =>
          !removedMemoryImplementations.has(String(record.implementation_key)),
      ),
    };
  }

  async resolve(
    references: unknown[],
  ): Promise<Array<Record<string, unknown>>> {
    const all = await this.list();
    return references.map((reference) => {
      const id =
        typeof reference === "string"
          ? reference
          : String(
              (reference as Record<string, unknown>).id ??
                (reference as Record<string, unknown>).slug,
            );
      const found = all.find(
        (item) => item.id === id || item.slug === id || item.name === id,
      );
      if (!found) throw new ValidationError(`tool not found: ${id}`);
      return found;
    });
  }

  build(
    record: Record<string, unknown>,
  ): FunctionTool<RuntimeContext, any, any> {
    const implementationKey = String(record.implementation_key);
    const implementation =
      this.builtins.get(implementationKey) ??
      implementations.get(implementationKey);
    if (!implementation)
      throw new ValidationError(
        `tool implementation is not registered: ${implementationKey}`,
      );
    const policy = (record.policy ?? {}) as Record<string, unknown>;
    const execute = async (
      args: Record<string, unknown>,
      runContext: RunContext<RuntimeContext>,
      details?: { toolCall: unknown },
    ) => {
      const context = runContext.context;
      const call = details?.toolCall as Record<string, unknown> | undefined;
      const callId = String(call?.callId ?? call?.call_id ?? newId());
      const idempotencyKey = hashJson({
        run_id: context.run_id,
        call_id: callId,
        tool: record.name,
      });
      const existing = (
        await this.db.query<Record<string, unknown>>(
          "SELECT * FROM tool_executions WHERE idempotency_key=$1",
          [idempotencyKey],
        )
      ).rows[0];
      if (existing?.status === "completed") return existing.output_json;
      if (
        existing &&
        (["running", "unknown"].includes(String(existing.status)) ||
          (Boolean(policy.side_effecting) &&
            existing.status === "failed" &&
            !existing.resolution_reason))
      ) {
        throw new ConflictError("tool execution outcome is unresolved");
      }
      const executionId = String(existing?.id ?? newId());
      if (existing) {
        await this.db.query(
          "UPDATE tool_executions SET status='running',attempt_count=attempt_count+1,error_json=NULL,lease_expires_at=now()+interval '5 minutes',updated_at=now() WHERE id=$1",
          [executionId],
        );
      } else {
        await this.db.query(
          `INSERT INTO tool_executions(id,run_id,tool_call_id,tool_name,implementation_key,idempotency_key,arguments_hash,lease_expires_at,side_effecting)
          VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '5 minutes',$8)`,
          [
            executionId,
            context.run_id,
            callId,
            record.name,
            implementationKey,
            idempotencyKey,
            hashJson(args),
            Boolean(policy.side_effecting),
          ],
        );
      }
      try {
        const output = await implementation(args, context);
        await this.faults.hit("tool.after_effect_before_commit", {
          run_id: context.run_id,
          execution_id: executionId,
          tool_name: record.name,
          side_effecting: Boolean(policy.side_effecting),
        });
        await this.db.query(
          "UPDATE tool_executions SET status='completed',output_json=$2::jsonb,completed_at=now(),lease_expires_at=NULL,updated_at=now() WHERE id=$1",
          [executionId, JSON.stringify(output ?? null)],
        );
        return output;
      } catch (error) {
        // For a declared side effect, every failure after dispatch is
        // ambiguous. A failed result commit must never authorize a replay.
        await this.db
          .query(
            "UPDATE tool_executions SET status=$2,error_json=$3::jsonb,completed_at=now(),lease_expires_at=NULL,updated_at=now() WHERE id=$1",
            [
              executionId,
              policy.side_effecting ? "unknown" : "failed",
              JSON.stringify({
                code: error instanceof Error ? error.name : "Error",
                message: String(error),
              }),
            ],
          )
          .catch(() => undefined);
        throw error;
      }
    };
    return tool<any, RuntimeContext, unknown>({
      name: String(record.name),
      description: String(record.description),
      parameters: record.schema as never,
      strict: false,
      ...(policy.side_effecting ? { errorFunction: null } : {}),
      needsApproval: Boolean(policy.requires_approval || policy.side_effecting),
      execute,
    } as never);
  }

  async executions(runId: string) {
    return (
      await this.db.query(
        "SELECT * FROM tool_executions WHERE run_id=$1 ORDER BY created_at",
        [runId],
      )
    ).rows;
  }

  async resolveExecution(id: string, input: Record<string, unknown>) {
    const status = String(input.status ?? "");
    if (!["completed", "failed"].includes(status))
      throw new ValidationError(
        "reconciled Tool execution status must be completed or failed",
      );
    if (!String(input.reason ?? "").trim())
      throw new ValidationError("reconciliation reason is required");
    return this.db.transaction(async (tx) => {
      const execution = await required<Record<string, unknown>>(
        tx,
        "SELECT * FROM tool_executions WHERE id=$1 FOR UPDATE",
        [id],
        "tool execution not found",
      );
      if (!["unknown", "failed"].includes(String(execution.status)))
        throw new ConflictError(
          "tool execution does not require reconciliation",
        );
      const updated = await required<Record<string, unknown>>(
        tx,
        "UPDATE tool_executions SET status=$2,output_json=$3::jsonb,error_json=$4::jsonb,resolution_reason=$5,completed_at=now(),lease_expires_at=NULL,updated_at=now() WHERE id=$1 RETURNING *",
        [
          id,
          status,
          JSON.stringify(input.output ?? null),
          JSON.stringify(input.error ?? null),
          String(input.reason),
        ],
      );
      const unresolved = (
        await tx.query<{ count: number }>(
          "SELECT count(*)::int count FROM tool_executions WHERE run_id=$1 AND status IN ('running','unknown')",
          [execution.run_id],
        )
      ).rows[0]?.count;
      if (!unresolved) {
        const run = (
          await tx.query<Record<string, unknown>>(
            "SELECT status FROM runs WHERE id=$1 FOR UPDATE",
            [execution.run_id],
          )
        ).rows[0];
        if (run?.status === "waiting_reconciliation") {
          await tx.query(
            "UPDATE runs SET status='queued',lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",
            [execution.run_id],
          );
          await this.events.appendInTransaction(
            tx,
            String(execution.run_id),
            "tool.reconciled",
            {
              execution_id: id,
              status,
              reason: String(input.reason),
            },
          );
        }
      }
      return updated;
    });
  }
}
