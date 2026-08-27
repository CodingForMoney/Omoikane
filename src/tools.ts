import { tool, type FunctionTool, type RunContext } from "@openai/agents";
import type { ArtifactService } from "./artifacts.js";
import type { Database } from "./database.js";
import { ConflictError, ValidationError, required } from "./database.js";
import type { MemoryService } from "./memory.js";
import { ResourceStore } from "./resources.js";
import type { SandboxHandle, SandboxService } from "./sandbox.js";
import { hashJson, newId } from "./serialization.js";

export interface RuntimeContext extends Record<string, unknown> {
  tenant_id: string;
  run_id: string;
  agent_version_id: string;
  retrieved_memories?: unknown[];
  sandbox?: SandboxHandle;
}
export type ToolImplementation = (
  args: Record<string, unknown>,
  context: RuntimeContext,
) => unknown | Promise<unknown>;

const implementations = new Map<string, ToolImplementation>();
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
    memory: MemoryService,
    sandbox: SandboxService,
  ) {
    this.store = new ResourceStore(db);
    this.builtins.set("builtin.artifact_create", async (args, context) => {
      const data = args.content_base64
        ? Buffer.from(String(args.content_base64), "base64")
        : Buffer.from(String(args.content ?? ""));
      const artifact = await artifacts.create(
        context.tenant_id,
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
    this.builtins.set("builtin.memory_search", (args, context) =>
      memory.retrieve(
        context.tenant_id,
        String(args.query ?? ""),
        (args.scopes as Array<[string, string]>) ?? [
          ["agent", context.agent_version_id],
          ["global", "global"],
        ],
        Number(args.limit ?? 8),
      ),
    );
    this.builtins.set("builtin.memory_create", (args, context) =>
      memory.create(
        context.tenant_id,
        {
          scope_type: args.scope_type ?? "agent",
          scope_id: args.scope_id ?? context.agent_version_id,
          kind: args.kind ?? "semantic",
          content: args.content,
          confidence: args.confidence ?? 0.8,
        },
        { run_id: context.run_id, source: "tool" },
      ),
    );
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

  async seed(tenantId = "default"): Promise<void> {
    const builtins = [
      {
        slug: "artifact-create",
        name: "artifact_create",
        description: "Create a durable artifact from text or base64 data",
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
        slug: "memory-search",
        name: "memory_search",
        description: "Search approved long-term memories",
        implementation_key: "builtin.memory_search",
        schema: {
          type: "object",
          properties: { query: { type: "string" }, limit: { type: "integer" } },
          required: ["query"],
          additionalProperties: false,
        },
        policy: {},
      },
      {
        slug: "memory-create",
        name: "memory_create",
        description: "Create a durable long-term memory",
        implementation_key: "builtin.memory_create",
        schema: {
          type: "object",
          properties: {
            content: { type: "string" },
            kind: { type: "string" },
            scope_type: { type: "string" },
            scope_id: { type: "string" },
            confidence: { type: "number" },
          },
          required: ["content"],
          additionalProperties: false,
        },
        policy: { requires_approval: true, side_effecting: true },
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
      if (!(await this.store.findBySlug(tenantId, "tool", item.slug)))
        await this.create(tenantId, item);
    }
  }

  async create(tenantId: string, input: Record<string, unknown>) {
    return this.store.create<Record<string, unknown>>({
      tenantId,
      kind: "tool",
      slug: String(input.slug),
      name: String(input.name),
      data: {
        description: String(input.description),
        kind: String(input.kind ?? "function"),
        implementation_key: String(input.implementation_key),
        schema: input.schema ?? {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        policy: input.policy ?? {},
      },
    });
  }

  async list(tenantId: string) {
    return this.store.list<Record<string, unknown>>(tenantId, "tool");
  }

  async resolve(
    tenantId: string,
    references: unknown[],
  ): Promise<Array<Record<string, unknown>>> {
    const local = await this.list(tenantId);
    const shared = tenantId === "default" ? [] : await this.list("default");
    const all = [...local, ...shared];
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
          "SELECT * FROM tool_executions WHERE tenant_id=$1 AND idempotency_key=$2",
          [context.tenant_id, idempotencyKey],
        )
      ).rows[0];
      if (existing?.status === "completed") return existing.output_json;
      if (
        existing &&
        ["running", "unknown"].includes(String(existing.status))
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
          `INSERT INTO tool_executions(id,tenant_id,run_id,tool_call_id,tool_name,implementation_key,idempotency_key,arguments_hash,lease_expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '5 minutes')`,
          [
            executionId,
            context.tenant_id,
            context.run_id,
            callId,
            record.name,
            implementationKey,
            idempotencyKey,
            hashJson(args),
          ],
        );
      }
      try {
        const output = await implementation(args, context);
        await this.db.query(
          "UPDATE tool_executions SET status='completed',output_json=$2::jsonb,completed_at=now(),lease_expires_at=NULL,updated_at=now() WHERE id=$1",
          [executionId, JSON.stringify(output ?? null)],
        );
        return output;
      } catch (error) {
        await this.db.query(
          "UPDATE tool_executions SET status='failed',error_json=$2::jsonb,completed_at=now(),lease_expires_at=NULL,updated_at=now() WHERE id=$1",
          [
            executionId,
            JSON.stringify({
              code: error instanceof Error ? error.name : "Error",
              message: String(error),
            }),
          ],
        );
        throw error;
      }
    };
    return tool<any, RuntimeContext, unknown>({
      name: String(record.name),
      description: String(record.description),
      parameters: record.schema as never,
      strict: false,
      needsApproval: Boolean(policy.requires_approval),
      execute,
    } as never);
  }

  async executions(tenantId: string, runId: string) {
    return (
      await this.db.query(
        "SELECT * FROM tool_executions WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at",
        [tenantId, runId],
      )
    ).rows;
  }

  async resolveExecution(
    tenantId: string,
    id: string,
    input: Record<string, unknown>,
    actorId: string,
  ) {
    const execution = await required<Record<string, unknown>>(
      this.db,
      "SELECT * FROM tool_executions WHERE id=$1 AND tenant_id=$2",
      [id, tenantId],
      "tool execution not found",
    );
    if (!["unknown", "failed"].includes(String(execution.status))) {
      throw new ConflictError("tool execution does not require reconciliation");
    }
    return required(
      this.db,
      "UPDATE tool_executions SET status=$3,output_json=$4::jsonb,error_json=$5::jsonb,resolved_by=$6,resolution_reason=$7,completed_at=now(),updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *",
      [
        id,
        tenantId,
        input.status,
        JSON.stringify(input.output ?? null),
        JSON.stringify(input.error ?? null),
        actorId,
        input.reason,
      ],
    );
  }
}
