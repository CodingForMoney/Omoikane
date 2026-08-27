import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { parseAgentMarkdown } from "./agent-definitions.js";
import type { Container } from "./container.js";
import { BudgetExceeded } from "./costs.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  required,
} from "./database.js";
import { encodeSse, publicEvent } from "./events.js";
import {
  AGENT_DEFINITION_VERSION,
  API_VERSION,
  COMPACTION_CHECKPOINT_VERSION,
  EVENT_SCHEMA_VERSION,
  MIGRATION_HEAD,
  OMOIKANE_VERSION,
  OPENAI_AGENTS_SDK_VERSION,
  RUN_STATE_FORMAT_VERSION,
} from "./runtime-versions.js";

type Dict = Record<string, unknown>;
const body = (request: FastifyRequest) => (request.body ?? {}) as Dict;
const params = (request: FastifyRequest) => request.params as Dict;
const query = (request: FastifyRequest) => request.query as Dict;
const identity = (request: FastifyRequest) => ({
  tenantId: String(request.headers["x-tenant-id"] ?? "default"),
  actorId: String(request.headers["x-actor-id"] ?? "development-user"),
});
const integer = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
};
const publicConnection = (record: Dict) => {
  const {
    api_key_ciphertext: _cipher,
    api_key_checksum: _checksum,
    data,
    ...rest
  } = record;
  const raw = (data ?? {}) as Dict;
  const {
    api_key_ciphertext: _dataCipher,
    api_key_checksum: _dataChecksum,
    ...safe
  } = raw;
  return { ...rest, ...safe, data: safe };
};

export async function createApp(
  container: Container,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    bodyLimit: 100_000_000,
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
  });
  await app.register(multipart, {
    limits: { fileSize: 100_000_000, files: 1 },
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header(
      "Access-Control-Allow-Origin",
      String(request.headers.origin ?? "*"),
    );
    reply.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Tenant-ID, X-Actor-ID, X-Request-ID, Idempotency-Key, Last-Event-ID",
    );
    reply.header(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    );
  });
  app.options("*", async (_request, reply) => reply.code(204).send());
  app.setErrorHandler((error, request, reply) => {
    const status =
      error instanceof NotFoundError
        ? 404
        : error instanceof ConflictError
          ? 409
          : error instanceof BudgetExceeded
            ? 429
            : error instanceof ValidationError || error instanceof SyntaxError
              ? 422
              : ((error as { statusCode?: number }).statusCode ?? 500);
    request.log.error(error);
    reply.code(status).send({
      error: {
        code:
          error instanceof BudgetExceeded
            ? "budget_exceeded"
            : error instanceof ConflictError
              ? "conflict"
              : error instanceof NotFoundError
                ? "not_found"
                : status === 500
                  ? "internal_error"
                  : "invalid_request",
        message: error instanceof Error ? error.message : String(error),
        request_id: request.id,
        details: {},
      },
    });
  });

  app.get("/healthz", async () => {
    await container.db.query("SELECT 1");
    return {
      status: "ok",
      version: OMOIKANE_VERSION,
      sdk_version: OPENAI_AGENTS_SDK_VERSION,
      runtime_generation: container.settings.runtimeGeneration,
    };
  });
  app.get("/version", async () => ({
    name: "omoikane-runtime",
    language: "TypeScript",
    distribution: "npm",
    version: OMOIKANE_VERSION,
    build_commit: container.settings.buildCommit,
    api_version: API_VERSION,
    event_schema_version: EVENT_SCHEMA_VERSION,
    migration_head: MIGRATION_HEAD,
    runtime_generation: container.settings.runtimeGeneration,
    openai_agents_sdk_version: OPENAI_AGENTS_SDK_VERSION,
  }));
  app.get("/v1/capabilities", async () => ({
    api_versions: [API_VERSION],
    event_schema_versions: [EVENT_SCHEMA_VERSION],
    run_state_format_versions: [RUN_STATE_FORMAT_VERSION],
    agent_definition_versions: [AGENT_DEFINITION_VERSION],
    compaction_checkpoint_versions: [COMPACTION_CHECKPOINT_VERSION],
    runtime_generation: container.settings.runtimeGeneration,
    features: {
      sessions: true,
      sse: true,
      approvals: true,
      function_tools: true,
      mcp: true,
      structured_output: true,
      skill_bundles: true,
      long_term_memory: true,
      context_compaction: true,
      artifacts: true,
      database_storage: true,
      multi_agent: true,
      sandbox: true,
      tracing: true,
      usage_and_cost: true,
      project_releases: true,
      release_channels: true,
      reliable_webhooks: true,
      runtime_generation_routing: true,
    },
  }));
  app.get("/v1/runtime-generations", async (request) => {
    const { tenantId } = identity(request);
    const rows = await container.db.query<{
      runtime_generation: string;
      status: string;
      count: number;
    }>(
      "SELECT runtime_generation,status,count(*)::int count FROM runs WHERE tenant_id=$1 GROUP BY runtime_generation,status",
      [tenantId],
    );
    const generations: Record<string, Record<string, number>> = {};
    for (const row of rows.rows)
      (generations[row.runtime_generation] ??= {})[row.status] = Number(
        row.count,
      );
    return { current: container.settings.runtimeGeneration, generations };
  });

  app.get("/v1/provider-definitions", async () => ({
    data: container.providers.catalog(),
  }));
  app.post("/v1/provider-connections", async (request, reply) => {
    const { tenantId } = identity(request);
    let record = await container.providers.create(tenantId, body(request));
    let sync: unknown = null;
    if (query(request).sync_models !== "false") {
      sync = await container.providers.validate(tenantId, record.id);
      record = await container.providers.get(tenantId, record.id);
    }
    return reply
      .code(201)
      .send({ ...publicConnection(record), model_sync: sync });
  });
  app.get("/v1/provider-connections", async (request) => ({
    data: (await container.providers.list(identity(request).tenantId)).map(
      publicConnection,
    ),
  }));
  app.get("/v1/provider-connections/:connectionId", async (request) =>
    publicConnection(
      await container.providers.get(
        identity(request).tenantId,
        String(params(request).connectionId),
      ),
    ),
  );
  app.patch("/v1/provider-connections/:connectionId", async (request) =>
    publicConnection(
      await container.providers.update(
        identity(request).tenantId,
        String(params(request).connectionId),
        body(request),
      ),
    ),
  );
  app.post("/v1/provider-connections/:connectionId/validate", async (request) =>
    container.providers.validate(
      identity(request).tenantId,
      String(params(request).connectionId),
    ),
  );
  app.get("/v1/provider-connections/:connectionId/models", async (request) => ({
    data: await container.providers.listModels(
      identity(request).tenantId,
      String(params(request).connectionId),
    ),
  }));
  app.post(
    "/v1/provider-connections/:connectionId/models",
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await container.providers.addModel(
            identity(request).tenantId,
            String(params(request).connectionId),
            body(request),
          ),
        ),
  );

  app.post("/v1/agents", async (request, reply) => {
    const data = body(request);
    return reply.code(201).send(
      await container.definitions.createAgent(identity(request).tenantId, {
        slug: String(data.slug),
        name: String(data.name),
        description: data.description ? String(data.description) : undefined,
      }),
    );
  });
  app.get("/v1/agents", async (request) => ({
    data: await container.definitions.listAgents(identity(request).tenantId),
  }));
  app.get("/v1/agents/:agentId", async (request) =>
    container.definitions.getAgent(
      identity(request).tenantId,
      String(params(request).agentId),
    ),
  );
  app.get("/v1/agent-settings", async (request) =>
    container.definitions.settings(identity(request).tenantId),
  );
  app.put("/v1/agent-settings", async (request) => {
    const who = identity(request);
    return container.definitions.updateSettings(
      who.tenantId,
      body(request),
      who.actorId,
    );
  });
  app.post("/v1/agent-definitions/validate", async (request) => {
    const data = body(request);
    const document = parseAgentMarkdown(String(data.document));
    return container.definitions.compile(
      identity(request).tenantId,
      document,
      (data.overrides ?? {}) as Dict,
    );
  });
  app.post("/v1/agents/from-definition", async (request, reply) => {
    const data = body(request);
    const who = identity(request);
    const created = await container.definitions.createFromDefinition(
      who.tenantId,
      parseAgentMarkdown(String(data.document)),
      (data.overrides ?? {}) as Dict,
    );
    const version =
      data.publish === false
        ? created.version
        : await container.definitions.publish(
            who.tenantId,
            created.agent.id,
            Number(created.version.version),
          );
    return reply.code(201).send({ agent: created.agent, version });
  });
  app.post(
    "/v1/agents/:agentId/versions/from-definition",
    async (request, reply) => {
      const data = body(request);
      const who = identity(request);
      const agentId = String(params(request).agentId);
      const version = await container.definitions.createVersion(
        who.tenantId,
        agentId,
        {},
        parseAgentMarkdown(String(data.document)),
        (data.overrides ?? {}) as Dict,
      );
      return reply.code(201).send({
        agent: await container.definitions.getAgent(who.tenantId, agentId),
        version:
          data.publish === false
            ? version
            : await container.definitions.publish(
                who.tenantId,
                agentId,
                Number(version.version),
              ),
      });
    },
  );
  app.post("/v1/agents/:agentId/versions", async (request, reply) =>
    reply
      .code(201)
      .send(
        await container.definitions.createVersion(
          identity(request).tenantId,
          String(params(request).agentId),
          (body(request).config ?? {}) as Dict,
        ),
      ),
  );
  app.get("/v1/agents/:agentId/versions", async (request) => ({
    data: await container.definitions.versions(
      identity(request).tenantId,
      String(params(request).agentId),
    ),
  }));
  app.post("/v1/agents/:agentId/versions/:version/publish", async (request) =>
    container.definitions.publish(
      identity(request).tenantId,
      String(params(request).agentId),
      integer(params(request).version, 0),
    ),
  );
  app.get(
    "/v1/agents/:agentId/versions/:version/definition",
    async (request) => {
      const versions = await container.definitions.versions(
        identity(request).tenantId,
        String(params(request).agentId),
      );
      const version = versions.find(
        (item) => Number(item.version) === integer(params(request).version, 0),
      );
      if (!version) throw new NotFoundError("agent version not found");
      return {
        format: version.definition_format,
        document: version.definition_source,
        definition: version.definition_json,
        overrides: version.overrides,
        effective_config: version.config,
        global_defaults_revision: version.global_defaults_revision,
        platform_policy_revision: version.platform_policy_revision,
        config_hash: version.config_hash,
      };
    },
  );

  app.post("/v1/sessions", async (request, reply) =>
    reply
      .code(201)
      .send(
        await container.sessions.create(
          identity(request).tenantId,
          (body(request).scope ?? {}) as Dict,
        ),
      ),
  );
  app.get("/v1/sessions", async (request) => {
    const q = query(request);
    const rows = await container.sessions.list(
      identity(request).tenantId,
      integer(q.limit, 100),
      integer(q.offset, 0),
    );
    const data = [];
    for (const row of rows) {
      const chats = await container.sessions.chatMessages(row.id);
      data.push({
        ...row,
        agent_version_id: row.scope.agent_version_id,
        agent_id: row.scope.agent_id,
        title: String(
          row.scope.title ??
            chats.find((m) => m.role === "user")?.content ??
            "New conversation",
        ).slice(0, 80),
      });
    }
    return { data, limit: integer(q.limit, 100), offset: integer(q.offset, 0) };
  });
  app.get("/v1/sessions/:sessionId", async (request) =>
    container.sessions.get(
      identity(request).tenantId,
      String(params(request).sessionId),
    ),
  );
  app.get("/v1/sessions/:sessionId/messages", async (request) => {
    const id = String(params(request).sessionId);
    await container.sessions.get(identity(request).tenantId, id);
    if (String(query(request).include_compacted) === "true")
      return {
        view: "canonical_transcript",
        data: await container.sessions.rawItems(id),
      };
    return {
      view: "model_projection",
      data: (await container.sessions.effectiveItems(id)).map(
        (item_json, position) => ({ position, item_json }),
      ),
    };
  });
  app.get("/v1/sessions/:sessionId/chat-messages", async (request) => {
    const id = String(params(request).sessionId);
    await container.sessions.get(identity(request).tenantId, id);
    return {
      view: "canonical_chat",
      data: await container.sessions.chatMessages(id),
    };
  });
  const sessionConfig = async (
    tenantId: string,
    sessionId: string,
    agentVersionId?: string,
  ) => {
    const session = await container.sessions.get(tenantId, sessionId);
    let id = agentVersionId ?? String(session.scope.agent_version_id ?? "");
    if (!id) {
      const recent = (
        await container.db.query<{ agent_version_id: string }>(
          "SELECT agent_version_id FROM runs WHERE tenant_id=$1 AND session_id=$2 ORDER BY created_at DESC LIMIT 1",
          [tenantId, sessionId],
        )
      ).rows[0];
      id = recent?.agent_version_id ?? "";
    }
    if (!id) throw new ValidationError("agent_version_id is required");
    const version = await container.definitions.version(tenantId, id);
    return container.providers.resolveConfig(tenantId, {
      ...((version.config ?? {}) as Dict),
    });
  };
  app.post("/v1/sessions/:sessionId/compact", async (request) => {
    const data = body(request),
      who = identity(request),
      sessionId = String(params(request).sessionId);
    const config = await sessionConfig(
      who.tenantId,
      sessionId,
      data.agent_version_id ? String(data.agent_version_id) : undefined,
    );
    const result = await container.compaction.compact(
      who.tenantId,
      sessionId,
      config,
      {
        strategy: String(data.strategy ?? "auto"),
        focus: data.focus ? String(data.focus) : undefined,
        dryRun: Boolean(data.dry_run),
        force: data.force === undefined ? false : Boolean(data.force),
        trigger: "manual",
      },
    );
    return {
      compacted: (result as Dict).status !== "skipped",
      compaction: result,
    };
  });
  app.get("/v1/sessions/:sessionId/compactions", async (request) => ({
    data: await container.compaction.list(
      identity(request).tenantId,
      String(params(request).sessionId),
    ),
  }));
  app.get(
    "/v1/sessions/:sessionId/compactions/:compactionId",
    async (request) =>
      container.compaction.get(
        identity(request).tenantId,
        String(params(request).sessionId),
        String(params(request).compactionId),
      ),
  );
  app.post(
    "/v1/sessions/:sessionId/compactions/:compactionId/restore",
    async (request) =>
      container.compaction.restore(
        identity(request).tenantId,
        String(params(request).sessionId),
        String(params(request).compactionId),
      ),
  );
  app.get("/v1/sessions/:sessionId/context-preview", async (request) =>
    container.compaction.preview(
      identity(request).tenantId,
      String(params(request).sessionId),
    ),
  );

  app.post("/v1/runs", async (request, reply) => {
    const data = body(request),
      who = identity(request);
    return reply.code(202).send(
      await container.runner.create({
        tenantId: who.tenantId,
        agentVersionId: String(data.agent_version_id),
        input: data.input as never,
        sessionId: data.session_id ? String(data.session_id) : undefined,
        context: (data.context ?? {}) as Dict,
        limits: (data.limits ?? {}) as Dict,
        idempotencyKey: request.headers["idempotency-key"]
          ? String(request.headers["idempotency-key"])
          : undefined,
        parentRunId: data.parent_run_id
          ? String(data.parent_run_id)
          : undefined,
      }),
    );
  });
  app.get("/v1/runs/:runId", async (request) =>
    container.runner.get(
      identity(request).tenantId,
      String(params(request).runId),
    ),
  );
  app.post("/v1/runs/:runId/cancel", async (request) =>
    container.runner.cancel(
      identity(request).tenantId,
      String(params(request).runId),
    ),
  );
  app.get("/v1/runs/:runId/events", async (request) => {
    const id = String(params(request).runId);
    await container.runner.get(identity(request).tenantId, id);
    return {
      data: (
        await container.events.list(
          id,
          integer(query(request).after, 0),
          integer(query(request).limit, 500),
        )
      ).map(publicEvent),
    };
  });
  app.get("/v1/runs/:runId/tool-executions", async (request) => {
    const id = String(params(request).runId);
    await container.runner.get(identity(request).tenantId, id);
    return {
      data: await container.tools.executions(identity(request).tenantId, id),
    };
  });
  app.post("/v1/tool-executions/:executionId/resolve", async (request) =>
    container.tools.resolveExecution(
      identity(request).tenantId,
      String(params(request).executionId),
      body(request),
      identity(request).actorId,
    ),
  );
  app.get("/v1/runs/:runId/stream", async (request, reply) => {
    const who = identity(request),
      runId = String(params(request).runId);
    await container.runner.get(who.tenantId, runId);
    let cursor = integer(request.headers["last-event-id"], 0);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": String(request.headers.origin ?? "*"),
    });
    let lastWrite = Date.now();
    while (!reply.raw.destroyed) {
      const events = await container.events.list(runId, cursor, 1000);
      for (const event of events) {
        cursor = Number(event.seq);
        reply.raw.write(encodeSse(publicEvent(event)));
        lastWrite = Date.now();
      }
      const run = await container.runner.get(who.tenantId, runId);
      if (
        [
          "completed",
          "failed",
          "cancelled",
          "waiting_approval",
          "waiting_reconciliation",
        ].includes(run.status) &&
        !events.length
      )
        break;
      if (
        Date.now() - lastWrite >=
        container.settings.sseHeartbeatSeconds * 1000
      ) {
        reply.raw.write(": heartbeat\n\n");
        lastWrite = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    reply.raw.end();
  });

  app.get("/v1/approvals", async (request) => {
    const q = query(request),
      who = identity(request);
    const values: unknown[] = [who.tenantId];
    const condition = q.status ? (values.push(q.status), " AND status=$2") : "";
    return {
      data: (
        await container.db.query(
          `SELECT * FROM approvals WHERE tenant_id=$1${condition} ORDER BY created_at DESC`,
          values,
        )
      ).rows,
    };
  });
  app.get("/v1/approvals/:approvalId", async (request) =>
    required(
      container.db,
      "SELECT * FROM approvals WHERE id=$1 AND tenant_id=$2",
      [params(request).approvalId, identity(request).tenantId],
      "approval not found",
    ),
  );
  app.post("/v1/approvals/:approvalId/approve", async (request) => {
    const who = identity(request);
    return container.runner.decideApproval(
      who.tenantId,
      String(params(request).approvalId),
      "approved",
      who.actorId,
      body(request).reason ? String(body(request).reason) : undefined,
    );
  });
  app.post("/v1/approvals/:approvalId/reject", async (request) => {
    const who = identity(request);
    return container.runner.decideApproval(
      who.tenantId,
      String(params(request).approvalId),
      "rejected",
      who.actorId,
      body(request).reason ? String(body(request).reason) : undefined,
    );
  });

  app.post("/v1/tools", async (request, reply) =>
    reply
      .code(201)
      .send(
        await container.tools.create(identity(request).tenantId, body(request)),
      ),
  );
  app.get("/v1/tools", async (request) => ({
    data: await container.tools.list(identity(request).tenantId),
  }));
  app.post("/v1/mcp-servers", async (request, reply) => {
    const data = body(request);
    return reply.code(201).send(
      await container.resources.create({
        tenantId: identity(request).tenantId,
        kind: "mcp_server",
        slug: String(data.slug),
        name: String(data.name),
        data: {
          transport: data.transport,
          endpoint_config: data.endpoint_config ?? {},
          secret_refs: data.secret_refs ?? {},
          policy: data.policy ?? {},
        },
      }),
    );
  });
  app.get("/v1/mcp-servers", async (request) => ({
    data: await container.resources.list(
      identity(request).tenantId,
      "mcp_server",
    ),
  }));
  app.post("/v1/mcp-servers/:serverId/health", async (request) => {
    const server = await container.factory.mcpServer(
      identity(request).tenantId,
      String(params(request).serverId),
    );
    try {
      await server.connect();
      const tools = await server.listTools();
      return {
        status: "ok",
        tool_count: tools.length,
        tools: tools.map((tool) => tool.name),
      };
    } finally {
      await server.close();
    }
  });
  app.post("/v1/skills/import", async (request, reply) =>
    reply
      .code(201)
      .send(
        await container.skills.importPath(
          identity(request).tenantId,
          String(body(request).path),
        ),
      ),
  );
  app.post("/v1/skills/bundles", async (request, reply) =>
    reply.code(201).send(
      await container.skills.importBundle(
        identity(request).tenantId,
        (body(request).files ?? []) as Array<{
          path: string;
          content_base64: string;
        }>,
      ),
    ),
  );
  app.get("/v1/skills", async (request) => ({
    data: await container.skills.list(identity(request).tenantId),
  }));
  app.get("/v1/skills/:skillId/versions", async (request) => ({
    data: await container.skills.versions(
      identity(request).tenantId,
      String(params(request).skillId),
    ),
  }));

  app.post("/v1/project-releases/validate", async (request) =>
    container.releases.validate(
      identity(request).tenantId,
      (body(request).manifest ?? {}) as Dict,
    ),
  );
  app.post("/v1/project-releases", async (request, reply) => {
    const who = identity(request);
    return reply
      .code(201)
      .send(
        await container.releases.create(
          who.tenantId,
          (body(request).manifest ?? {}) as Dict,
          who.actorId,
        ),
      );
  });
  app.get("/v1/project-releases", async (request) => ({
    data: await container.releases.list(
      identity(request).tenantId,
      query(request).project ? String(query(request).project) : undefined,
    ),
  }));
  app.get("/v1/project-releases/:releaseId", async (request) =>
    container.releases.get(
      identity(request).tenantId,
      String(params(request).releaseId),
    ),
  );
  app.put("/v1/projects/:project/channels/:channel", async (request) => {
    const who = identity(request),
      data = body(request);
    return container.releases.setChannel(
      who.tenantId,
      String(params(request).project),
      String(params(request).channel),
      String(data.release_id),
      data.expected_revision === undefined
        ? undefined
        : Number(data.expected_revision),
      who.actorId,
    );
  });
  app.get("/v1/projects/:project/channels/:channel", async (request) =>
    container.releases.channel(
      identity(request).tenantId,
      String(params(request).project),
      String(params(request).channel),
    ),
  );

  app.post("/v1/webhook-subscriptions", async (request, reply) =>
    reply
      .code(201)
      .send(
        await container.webhooks.create(
          identity(request).tenantId,
          body(request),
        ),
      ),
  );
  app.get("/v1/webhook-subscriptions", async (request) => ({
    data: await container.webhooks.list(identity(request).tenantId),
  }));
  app.patch("/v1/webhook-subscriptions/:subscriptionId", async (request) =>
    container.webhooks.patch(
      identity(request).tenantId,
      String(params(request).subscriptionId),
      body(request),
    ),
  );
  app.get("/v1/webhook-deliveries", async (request) => ({
    data: await container.webhooks.deliveries(
      identity(request).tenantId,
      query(request).status ? String(query(request).status) : undefined,
    ),
  }));
  app.post("/v1/webhook-deliveries/:deliveryId/replay", async (request) =>
    container.webhooks.replay(
      identity(request).tenantId,
      String(params(request).deliveryId),
    ),
  );
  app.post("/v1/memories", async (request, reply) => {
    const who = identity(request);
    return reply.code(201).send(
      await container.memory.create(who.tenantId, body(request), {
        actor_id: who.actorId,
      }),
    );
  });
  app.get("/v1/memories", async (request) => ({
    data: await container.memory.list(
      identity(request).tenantId,
      query(request),
    ),
  }));
  app.patch("/v1/memories/:memoryId", async (request) =>
    container.memory.patch(
      identity(request).tenantId,
      String(params(request).memoryId),
      body(request),
    ),
  );
  app.delete("/v1/memories/:memoryId", async (request, reply) => {
    await container.memory.patch(
      identity(request).tenantId,
      String(params(request).memoryId),
      { enabled: false },
    );
    return reply.code(204).send();
  });
  app.post("/v1/artifacts", async (request, reply) => {
    const part = await request.file();
    if (!part) throw new ValidationError("multipart file is required");
    const data = await part.toBuffer();
    return reply.code(201).send(
      await container.artifacts.create(
        identity(request).tenantId,
        part.filename,
        data,
        {
          runId: query(request).run_id
            ? String(query(request).run_id)
            : undefined,
          mimeType: part.mimetype,
        },
      ),
    );
  });
  app.get("/v1/artifacts/:artifactId", async (request) =>
    container.artifacts.get(
      identity(request).tenantId,
      String(params(request).artifactId),
    ),
  );
  app.get("/v1/artifacts/:artifactId/download", async (request, reply) => {
    const row = await container.artifacts.get(
      identity(request).tenantId,
      String(params(request).artifactId),
    );
    reply
      .type(row.mime_type)
      .header(
        "Content-Disposition",
        `attachment; filename="${row.filename.replace(/"/g, "")}"`,
      );
    return reply.send(
      Buffer.from(
        await container.artifacts.bytes(identity(request).tenantId, row.id),
      ),
    );
  });
  app.delete("/v1/artifacts/:artifactId", async (request, reply) => {
    await container.artifacts.remove(
      identity(request).tenantId,
      String(params(request).artifactId),
    );
    return reply.code(204).send();
  });
  app.post("/v1/prices", async (request, reply) =>
    reply.code(201).send(await container.costs.createPrice(body(request))),
  );
  app.get("/v1/usage", async (request) => ({
    data: await container.costs.usage(
      identity(request).tenantId,
      query(request).run_id ? String(query(request).run_id) : undefined,
    ),
  }));
  app.get("/v1/costs", async (request) => {
    const data = await container.costs.costs(
      identity(request).tenantId,
      query(request).run_id ? String(query(request).run_id) : undefined,
    );
    return {
      data,
      tenant_total: data.reduce(
        (sum, row) => sum + Number((row as Dict).amount),
        0,
      ),
    };
  });
  return app;
}
