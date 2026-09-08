import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { parseAgentMarkdown } from "./agent-definitions.js";
import type { Container } from "./container.js";
import {
  API_CONTRACTS,
  EmptyObjectSchema,
  type ApiRouteContract,
} from "./contracts.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  required,
} from "./database.js";
import { encodeSse, publicEvent } from "./events.js";
import { OPENAPI_DOCUMENT } from "./openapi.js";
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
import { safeErrorType } from "./observability.js";

type Dict = Record<string, unknown>;

class SseCapacityError extends Error {
  readonly statusCode = 429;
  constructor() {
    super("SSE connection capacity is temporarily exhausted");
  }
}

function mcpOAuthCompletionHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorization complete</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f5f1;color:#171914;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}.card{width:min(420px,calc(100vw - 48px));padding:36px;border:1px solid #d9dbd4;border-radius:18px;background:#fff;box-shadow:0 18px 60px rgba(20,24,18,.08);text-align:center}.mark{display:grid;place-items:center;width:48px;height:48px;margin:0 auto 18px;border-radius:50%;background:#e4f3e8;color:#1f6b39;font-size:26px;font-weight:700}h1{margin:0 0 10px;font-size:24px}p{margin:0;color:#62675e;line-height:1.6}</style></head><body><main class="card"><div class="mark">✓</div><h1>Authorization complete</h1><p>You can close this page and return to the application. This window will close automatically when the browser allows it.</p></main><script>history.replaceState(null,"",location.pathname);setTimeout(()=>window.close(),900);</script></body></html>`;
}

async function writeSseChunk(
  response: NodeJS.WritableStream & { destroyed?: boolean },
  chunk: string,
): Promise<boolean> {
  if (response.destroyed) return false;
  if (response.write(chunk)) return true;
  await new Promise<void>((resolve) => {
    const finish = () => {
      response.removeListener("drain", finish);
      response.removeListener("close", finish);
      response.removeListener("error", finish);
      resolve();
    };
    response.once("drain", finish);
    response.once("close", finish);
    response.once("error", finish);
  });
  return !response.destroyed;
}
type Contracts = typeof API_CONTRACTS;
type ContractSchemaKey = "body" | "params" | "query" | "headers";
type ContractNameWith<Key extends ContractSchemaKey> = {
  [Name in keyof Contracts]: Contracts[Name] extends Record<Key, z.ZodType>
    ? Name
    : never;
}[keyof Contracts];
type ContractSchema<
  Name extends keyof Contracts,
  Key extends ContractSchemaKey,
> =
  Contracts[Name] extends Record<Key, infer Schema extends z.ZodType>
    ? Schema
    : never;
const parsePart = <Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.output<Schema> => schema.parse(value ?? {});
const requestBody = <Name extends ContractNameWith<"body">>(
  request: FastifyRequest,
  name: Name,
): z.output<ContractSchema<Name, "body">> =>
  parsePart(
    (
      API_CONTRACTS[name] as unknown as {
        body: ContractSchema<Name, "body">;
      }
    ).body,
    request.body,
  );
const requestParams = <Name extends ContractNameWith<"params">>(
  request: FastifyRequest,
  name: Name,
): z.output<ContractSchema<Name, "params">> =>
  parsePart(
    (
      API_CONTRACTS[name] as unknown as {
        params: ContractSchema<Name, "params">;
      }
    ).params,
    request.params,
  );
const requestQuery = <Name extends ContractNameWith<"query">>(
  request: FastifyRequest,
  name: Name,
): z.output<ContractSchema<Name, "query">> =>
  parsePart(
    (
      API_CONTRACTS[name] as unknown as {
        query: ContractSchema<Name, "query">;
      }
    ).query,
    request.query,
  );
const requestHeaders = <Name extends ContractNameWith<"headers">>(
  request: FastifyRequest,
  name: Name,
): z.output<ContractSchema<Name, "headers">> =>
  parsePart(
    (
      API_CONTRACTS[name] as unknown as {
        headers: ContractSchema<Name, "headers">;
      }
    ).headers,
    request.headers,
  );
const pagination = (query: { limit?: string; cursor?: string }) => ({
  limit: query.limit === undefined ? undefined : Number(query.limit),
  cursor: query.cursor,
});
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
    logger:
      container.settings.logLevel === "silent"
        ? false
        : { level: container.settings.logLevel },
    bodyLimit: Math.max(
      100_000_000,
      container.settings.artifactMaxFileBytes + 1_000_000,
    ),
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
  });
  let activeSseConnections = 0;
  const activeSseByRun = new Map<string, number>();
  const acquireSse = (runId: string): (() => void) | undefined => {
    const activeForRun = activeSseByRun.get(runId) ?? 0;
    if (
      activeSseConnections >= container.settings.sseMaxConnections ||
      activeForRun >= container.settings.sseMaxConnectionsPerRun
    )
      return undefined;
    activeSseConnections += 1;
    activeSseByRun.set(runId, activeForRun + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeSseConnections = Math.max(0, activeSseConnections - 1);
      const remaining = Math.max(0, (activeSseByRun.get(runId) ?? 1) - 1);
      if (remaining) activeSseByRun.set(runId, remaining);
      else activeSseByRun.delete(runId);
    };
  };
  await app.register(multipart, {
    // The service owns the exact limit and typed error. One additional byte
    // lets its streaming meter detect overflow before multipart truncates it.
    limits: {
      fileSize: container.settings.artifactMaxFileBytes + 1,
      files: 1,
    },
  });
  const contractsByRoute = new Map(
    Object.values(API_CONTRACTS).map((contract) => [
      `${contract.method.toUpperCase()} ${contract.path}`,
      contract as ApiRouteContract,
    ]),
  );
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && container.settings.corsOrigins.includes(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
    }
    reply.header(
      "Access-Control-Allow-Headers",
      "Content-Type, X-Request-ID, Idempotency-Key, Last-Event-ID",
    );
    reply.header(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    );
  });
  app.addHook("preValidation", async (request) => {
    const contract = contractsByRoute.get(
      `${request.method} ${request.routeOptions.url}`,
    );
    if (!contract) return;
    parsePart(contract.params ?? EmptyObjectSchema, request.params);
    parsePart(contract.query ?? EmptyObjectSchema, request.query);
    if (contract.headers) parsePart(contract.headers, request.headers);
    if (contract.body) parsePart(contract.body, request.body);
    else if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method) &&
      contract.requestContentType !== "multipart/form-data"
    )
      parsePart(EmptyObjectSchema, request.body);
  });
  app.options("*", async (_request, reply) => reply.code(204).send());
  app.setErrorHandler((error, request, reply) => {
    const schemaError = error instanceof z.ZodError;
    const malformedJson =
      error instanceof SyntaxError ||
      (error as { code?: string }).code === "FST_ERR_CTP_INVALID_JSON_BODY";
    const status =
      error instanceof NotFoundError
        ? 404
        : error instanceof ConflictError
          ? 409
          : error instanceof ValidationError || malformedJson || schemaError
            ? 422
            : ((error as { statusCode?: number }).statusCode ?? 500);
    if (schemaError || malformedJson)
      request.log.warn(
        {
          request_id: request.id,
          issue_count: schemaError ? error.issues.length : 1,
        },
        "request contract validation failed",
      );
    else {
      const fields = {
        request_id: request.id,
        status,
        error_type: safeErrorType(error),
      };
      if (status >= 500 && status !== 507)
        request.log.error(fields, "request failed");
      else request.log.warn(fields, "request rejected");
    }
    const runtimeErrorCode = (error as { errorCode?: unknown }).errorCode;
    reply.code(status).send({
      error: {
        code:
          typeof runtimeErrorCode === "string"
            ? runtimeErrorCode
            : (error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE"
              ? "artifact_too_large"
              : error instanceof ConflictError
                ? "conflict"
                : error instanceof NotFoundError
                  ? "not_found"
                  : status === 429
                    ? "too_many_requests"
                    : status === 500
                      ? "internal_error"
                      : "invalid_request",
        message:
          schemaError || malformedJson
            ? "request validation failed"
            : status === 500
              ? "internal runtime error"
              : error instanceof Error
                ? error.message
                : String(error),
        request_id: request.id,
        details: schemaError
          ? {
              issues: error.issues.map((issue) => ({
                path: issue.path.length ? issue.path.join(".") : "$",
                code: issue.code,
                message: issue.message,
              })),
            }
          : malformedJson
            ? {
                issues: [
                  {
                    path: "$",
                    code: "invalid_json",
                    message: "malformed JSON request body",
                  },
                ],
              }
            : {},
      },
    });
  });

  app.get("/healthz", async () => {
    await container.db.query("SELECT 1");
    return {
      status: "ok",
      version: OMOIKANE_VERSION,
      sdk_version: OPENAI_AGENTS_SDK_VERSION,
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
    openai_agents_sdk_version: OPENAI_AGENTS_SDK_VERSION,
  }));
  app.get("/v1/runtime/status", async () => ({
    ...(await container.runner.runtimeStatus()),
    artifacts: await container.artifacts.usage(),
    sse_connections: {
      active: activeSseConnections,
      maximum: container.settings.sseMaxConnections,
      maximum_per_run: container.settings.sseMaxConnectionsPerRun,
    },
  }));
  app.get("/openapi.json", async () => OPENAPI_DOCUMENT);
  app.get("/v1/capabilities", async () => ({
    api_versions: [API_VERSION],
    event_schema_versions: [EVENT_SCHEMA_VERSION],
    run_state_format_versions: [RUN_STATE_FORMAT_VERSION],
    agent_definition_versions: [AGENT_DEFINITION_VERSION],
    compaction_checkpoint_versions: [3, COMPACTION_CHECKPOINT_VERSION],
    features: {
      durable_runs: true,
      durable_execution_checkpoints: true,
      external_conversation_state: true,
      sse: true,
      approvals: true,
      input_output_guardrails: true,
      pluggable_guardrails: true,
      buffered_output_guardrails: true,
      function_tools: true,
      mcp: true,
      runtime_managed_mcp_tools: true,
      mcp_streamable_http: true,
      mcp_sse_compatibility: true,
      mcp_oauth_auto_scopes: true,
      mcp_oauth_confidential_clients: true,
      mcp_oauth_url_client_metadata: true,
      mcp_resources: false,
      provider_hosted_mcp: false,
      structured_output: true,
      skill_bundles: true,
      skill_workspaces: false,
      skill_requirement_validation: false,
      context_compaction: true,
      native_context_compaction: true,
      temporary_run_artifacts: true,
      artifact_listing: true,
      artifact_integrity_verification: true,
      artifact_lifecycle_recovery: true,
      durable_execution_storage: true,
      multi_agent: true,
      sandbox: false,
      tracing: true,
      metadata_only_tracing: true,
      explicit_trace_exporters: true,
      runtime_status: true,
      run_listing: true,
      cursor_pagination: true,
      bounded_sse: true,
      post_commit_event_wakeup: true,
      run_usage: true,
      resource_limits: true,
      audio_transcription: true,
      speech_synthesis: true,
      assembled_input_token_counting: true,
    },
  }));

  app.get("/v1/provider-definitions", async () => ({
    data: container.providers.catalog(),
  }));
  app.post("/v1/provider-connections", async (request, reply) => {
    const data = requestBody(request, "createProvider");
    const q = requestQuery(request, "createProvider");
    let record = await container.providers.create(data);
    let sync: unknown = null;
    if (q.sync_models !== "false") {
      sync = await container.providers.validate(record.id);
      record = await container.providers.get(record.id);
    }
    return reply
      .code(201)
      .send({ ...publicConnection(record), model_sync: sync });
  });
  app.get("/v1/provider-connections", async (request) => {
    const q = requestQuery(request, "listProviders");
    const page = await container.providers.page({
      ...pagination(q),
      status: q.status,
    });
    return { ...page, data: page.data.map(publicConnection) };
  });
  app.get("/v1/provider-connections/:connectionId", async (request) => {
    const { connectionId } = requestParams(request, "getProvider");
    return publicConnection(await container.providers.get(connectionId));
  });
  app.patch("/v1/provider-connections/:connectionId", async (request) => {
    const { connectionId } = requestParams(request, "updateProvider");
    return publicConnection(
      await container.providers.update(
        connectionId,
        requestBody(request, "updateProvider"),
      ),
    );
  });
  app.delete(
    "/v1/provider-connections/:connectionId",
    async (request, reply) => {
      const { connectionId } = requestParams(request, "deleteProvider");
      await container.providers.delete(connectionId);
      return reply.code(204).send();
    },
  );
  app.post(
    "/v1/provider-connections/:connectionId/validate",
    async (request) => {
      const { connectionId } = requestParams(request, "validateProvider");
      requestBody(request, "validateProvider");
      return container.providers.validate(connectionId);
    },
  );
  app.get("/v1/provider-connections/:connectionId/models", async (request) => {
    const { connectionId } = requestParams(request, "listProviderModels");
    const q = requestQuery(request, "listProviderModels");
    return container.providers.pageModels(connectionId, pagination(q));
  });
  app.post(
    "/v1/provider-connections/:connectionId/models",
    async (request, reply) => {
      const { connectionId } = requestParams(request, "createProviderModel");
      return reply
        .code(201)
        .send(
          await container.providers.addModel(
            connectionId,
            requestBody(request, "createProviderModel"),
          ),
        );
    },
  );
  app.post(
    "/v1/provider-connections/:connectionId/audio/transcriptions",
    async (request) => {
      const { connectionId } = requestParams(request, "transcribeAudio");
      return container.providers.transcribeAudio(
        connectionId,
        requestBody(request, "transcribeAudio"),
      );
    },
  );
  app.post(
    "/v1/provider-connections/:connectionId/audio/speech",
    async (request) => {
      const { connectionId } = requestParams(request, "createSpeech");
      return container.providers.synthesizeSpeech(
        connectionId,
        requestBody(request, "createSpeech"),
      );
    },
  );

  app.post("/v1/agent-definitions/validate", async (request) => {
    const data = requestBody(request, "validateAgentDefinition");
    const document = parseAgentMarkdown(data.document);
    return container.definitions.compile(
      document,
      data.overrides ?? {},
      data.compilation_settings ?? {},
    );
  });
  app.post("/v1/deployments", async (request, reply) => {
    const data = requestBody(request, "createDeployment");
    return reply.code(201).send(
      await container.definitions.deploy({
        ...(data.document
          ? {
              document: parseAgentMarkdown(data.document),
              source: data.document,
            }
          : { config: data.config ?? {} }),
        overrides: data.overrides ?? {},
        compilationSettings: data.compilation_settings ?? {},
      }),
    );
  });
  app.get("/v1/deployments", async (request) => {
    const q = requestQuery(request, "listDeployments");
    return container.definitions.pageDeployments({
      ...pagination(q),
      status: q.status,
    });
  });
  app.get("/v1/deployments/:deploymentId", async (request) => {
    const { deploymentId } = requestParams(request, "getDeployment");
    return container.definitions.deployment(deploymentId);
  });
  app.post(
    "/v1/deployments/:deploymentId/input-token-count",
    async (request) => {
      const { deploymentId } = requestParams(
        request,
        "countDeploymentInputTokens",
      );
      return container.inputTokenCounting.count(
        deploymentId,
        requestBody(request, "countDeploymentInputTokens") as never,
      );
    },
  );
  app.get("/v1/input-token-counting/models", async () => ({
    data: container.providers.inputTokenCountingModels(),
  }));
  app.post("/v1/context/compact", async (request) => {
    const data = requestBody(request, "compactContext");
    const deployment = await container.definitions.deployment(
      data.deployment_id,
    );
    const config = await container.providers.resolveConfig({
      ...((deployment.config ?? {}) as Dict),
    });
    const projection = data.projection as Record<string, unknown> | undefined;
    if (projection) container.compaction.validateProjection(projection, config);
    const items = (data.items ?? projection?.items ?? []) as never[];
    return container.compaction.compact(items, config, {
      strategy: data.strategy ?? "auto",
      focus: data.focus,
      dryRun: data.dry_run ?? false,
      force: data.force ?? false,
      currentInput: data.current_input,
      trigger: "external",
      sourceProjection: projection,
    });
  });

  app.get("/v1/runs", async (request) => {
    const q = requestQuery(request, "listRuns");
    return container.runner.list({
      ...pagination(q),
      status: q.status,
      deploymentId: q.deployment_id,
      externalSessionId: q.external_session_id,
      parentRunId: q.parent_run_id,
    });
  });
  app.post("/v1/runs", async (request, reply) => {
    const data = requestBody(request, "createRun");
    const headers = requestHeaders(request, "createRun");
    return reply.code(202).send(
      await container.runner.create({
        deploymentId: data.deployment_id,
        input: data.input as never,
        conversation: (data.conversation ?? []) as never[],
        projection: data.projection,
        externalSessionId: data.external_session_id,
        context: data.context ?? {},
        limits: data.limits ?? {},
        idempotencyKey: headers["idempotency-key"],
        parentRunId: data.parent_run_id,
      }),
    );
  });
  app.get("/v1/runs/:runId", async (request) => {
    const { runId } = requestParams(request, "getRun");
    return container.runner.publicRun(runId);
  });
  app.get("/v1/runs/:runId/reasoning-metadata", async (request) => {
    const { runId } = requestParams(request, "getRunReasoningMetadata");
    return container.runner.reasoningMetadata(runId);
  });
  app.post("/v1/runs/:runId/cancel", async (request) => {
    const { runId } = requestParams(request, "cancelRun");
    requestBody(request, "cancelRun");
    await container.runner.cancel(runId);
    return container.runner.publicRun(runId);
  });
  app.get("/v1/runs/:runId/events", async (request) => {
    const { runId } = requestParams(request, "listRunEvents");
    const q = requestQuery(request, "listRunEvents");
    await container.runner.get(runId);
    return {
      data: (
        await container.events.list(
          runId,
          Number(q.after ?? 0),
          Math.min(Number(q.limit ?? 500), 10_000),
        )
      ).map(publicEvent),
    };
  });
  app.get("/v1/runs/:runId/tool-executions", async (request) => {
    const { runId } = requestParams(request, "listToolExecutions");
    await container.runner.get(runId);
    return {
      data: await container.tools.executions(runId),
    };
  });
  app.get("/v1/runs/:runId/usage", async (request) => {
    const { runId } = requestParams(request, "runUsage");
    await container.runner.get(runId);
    return {
      data: await container.usage.forRun(runId),
    };
  });
  app.post("/v1/tool-executions/:executionId/resolve", async (request) => {
    const { executionId } = requestParams(request, "resolveToolExecution");
    return container.tools.resolveExecution(
      executionId,
      requestBody(request, "resolveToolExecution"),
    );
  });
  app.get("/v1/runs/:runId/stream", async (request, reply) => {
    const { runId } = requestParams(request, "streamRun");
    const headers = requestHeaders(request, "streamRun");
    await container.runner.get(runId);
    const release = acquireSse(runId);
    if (!release) {
      reply.header("Retry-After", "1");
      throw new SseCapacityError();
    }
    let cursor = Number(headers["last-event-id"] ?? 0);
    const disconnected = new AbortController();
    const onClose = () => disconnected.abort();
    try {
      reply.hijack();
      const streamHeaders: Record<string, string> = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      };
      const origin = request.headers.origin;
      if (origin && container.settings.corsOrigins.includes(origin)) {
        streamHeaders["Access-Control-Allow-Origin"] = origin;
        streamHeaders.Vary = "Origin";
      }
      reply.raw.once("close", onClose);
      reply.raw.writeHead(200, streamHeaders);
      let lastWrite = Date.now();
      while (!reply.raw.destroyed && !disconnected.signal.aborted) {
        const revision = container.events.revision(runId);
        const events = await container.events.list(runId, cursor, 1000);
        for (const event of events) {
          try {
            await container.faults.hit("sse.before_event", {
              run_id: runId,
              seq: Number(event.seq),
            });
          } catch {
            reply.raw.destroy();
            return;
          }
          if (!(await writeSseChunk(reply.raw, encodeSse(publicEvent(event)))))
            return;
          cursor = Number(event.seq);
          lastWrite = Date.now();
        }
        if (events.length >= 1000) continue;
        const run = await container.runner.get(runId);
        const closing = [
          "completed",
          "failed",
          "cancelled",
          "waiting_approval",
          "waiting_reconciliation",
        ].includes(run.status);
        if (closing) {
          // The terminal/interruption status and its matching Event commit
          // atomically, but they can commit between the list above and this
          // status read. Drain once more before ending so SSE never reports a
          // terminal cursor that omits the corresponding Event.
          if ((await container.events.list(runId, cursor, 1)).length) continue;

          // Sandbox cleanup is intentionally post-terminal because destroying
          // the external process/container cannot join the database
          // transaction. Keep this stream open long enough to include the
          // durable cleanup Event when a handle is still attached.
          const cleanupPending =
            ["completed", "failed", "cancelled"].includes(run.status) &&
            Boolean(run.context_json?.sandbox);
          if (cleanupPending) {
            const changed = await container.events.waitForChange(
              runId,
              revision,
              container.settings.ssePollFallbackMs,
              disconnected.signal,
            );
            if (changed) continue;
          }
          await writeSseChunk(
            reply.raw,
            `event: stream.end\ndata: ${JSON.stringify({ status: run.status, cursor })}\n\n`,
          );
          break;
        }
        if (
          Date.now() - lastWrite >=
          container.settings.sseHeartbeatSeconds * 1000
        ) {
          if (!(await writeSseChunk(reply.raw, ": heartbeat\n\n"))) return;
          lastWrite = Date.now();
        }
        await container.events.waitForChange(
          runId,
          revision,
          container.settings.ssePollFallbackMs,
          disconnected.signal,
        );
      }
    } finally {
      reply.raw.removeListener("close", onClose);
      release();
      if (!reply.raw.destroyed) reply.raw.end();
    }
  });

  app.get("/v1/approvals", async (request) => {
    const q = requestQuery(request, "listApprovals");
    return container.runner.listApprovals({
      ...pagination(q),
      status: q.status,
    });
  });
  app.get("/v1/approvals/:approvalId", async (request) => {
    const { approvalId } = requestParams(request, "getApproval");
    return required(
      container.db,
      "SELECT * FROM approvals WHERE id=$1",
      [approvalId],
      "approval not found",
    );
  });
  app.post("/v1/approvals/:approvalId/approve", async (request) => {
    const { approvalId } = requestParams(request, "approve");
    const data = requestBody(request, "approve");
    return container.runner.decideApproval(approvalId, "approved", data.reason);
  });
  app.post("/v1/approvals/:approvalId/reject", async (request) => {
    const { approvalId } = requestParams(request, "reject");
    const data = requestBody(request, "reject");
    return container.runner.decideApproval(approvalId, "rejected", data.reason);
  });

  app.post("/v1/tools", async (request, reply) =>
    reply
      .code(201)
      .send(await container.tools.create(requestBody(request, "createTool"))),
  );
  app.get("/v1/tools", async (request) => {
    const q = requestQuery(request, "listTools");
    return container.tools.page({ ...pagination(q), status: q.status });
  });
  app.post("/v1/mcp-servers", async (request, reply) =>
    reply
      .code(201)
      .send(
        await container.mcp.create(requestBody(request, "createMcpServer")),
      ),
  );
  app.get("/v1/mcp-servers", async (request) => {
    const q = requestQuery(request, "listMcpServers");
    return container.mcp.page({ ...pagination(q), status: q.status });
  });
  app.get("/v1/mcp-servers/:serverId", async (request) => {
    const { serverId } = requestParams(request, "getMcpServer");
    return container.mcp.get(serverId);
  });
  app.patch("/v1/mcp-servers/:serverId", async (request) => {
    const { serverId } = requestParams(request, "updateMcpServer");
    return container.mcp.update(
      serverId,
      requestBody(request, "updateMcpServer"),
    );
  });
  app.delete("/v1/mcp-servers/:serverId", async (request, reply) => {
    const { serverId } = requestParams(request, "deleteMcpServer");
    await container.mcp.delete(serverId);
    return reply.code(204).send();
  });
  app.get("/v1/mcp-servers/:serverId/oauth/status", async (request, reply) => {
    const { serverId } = requestParams(request, "mcpOAuthStatus");
    reply.header("Cache-Control", "no-store");
    return container.mcp.oauthStatus(serverId);
  });
  app.get(
    "/v1/mcp-servers/:serverId/oauth/client-metadata",
    async (request, reply) => {
      const { serverId } = requestParams(request, "mcpOAuthClientMetadata");
      reply.header("Cache-Control", "public, max-age=300");
      return container.mcp.oauthClientMetadata(serverId);
    },
  );
  app.post("/v1/mcp-servers/:serverId/oauth/start", async (request, reply) => {
    const { serverId } = requestParams(request, "startMcpOAuth");
    requestBody(request, "startMcpOAuth");
    reply.header("Cache-Control", "no-store");
    return container.mcp.startOAuth(serverId);
  });
  app.post(
    "/v1/mcp-servers/:serverId/oauth/callback",
    async (request, reply) => {
      const { serverId } = requestParams(request, "completeMcpOAuth");
      const callback = requestBody(request, "completeMcpOAuth");
      reply.header("Cache-Control", "no-store");
      reply.header("Referrer-Policy", "no-referrer");
      return container.mcp.completeOAuth(serverId, callback);
    },
  );
  app.get(
    "/v1/mcp-servers/:serverId/oauth/callback",
    async (request, reply) => {
      const { serverId } = requestParams(request, "completeMcpOAuthRedirect");
      const callback = requestQuery(request, "completeMcpOAuthRedirect");
      reply.header("Cache-Control", "no-store");
      reply.header("Referrer-Policy", "no-referrer");
      const status = await container.mcp.completeOAuth(serverId, callback);
      if (request.headers.accept?.includes("text/html")) {
        reply.header(
          "Content-Security-Policy",
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        );
        return reply
          .type("text/html; charset=utf-8")
          .send(mcpOAuthCompletionHtml());
      }
      return status;
    },
  );
  app.delete("/v1/mcp-servers/:serverId/oauth", async (request, reply) => {
    const { serverId } = requestParams(request, "disconnectMcpOAuth");
    await container.mcp.disconnectOAuth(serverId);
    return reply.code(204).send();
  });
  app.post("/v1/mcp-servers/:serverId/health", async (request) => {
    const { serverId } = requestParams(request, "mcpHealth");
    requestBody(request, "mcpHealth");
    return container.mcp.health(serverId);
  });
  app.get("/v1/mcp-servers/:serverId/tools", async (request) => {
    const { serverId } = requestParams(request, "mcpTools");
    return container.mcp.inspectTools(serverId);
  });
  app.post(
    "/v1/mcp-servers/:serverId/tools/:toolName/call",
    async (request) => {
      const { serverId, toolName } = requestParams(request, "callMcpTool");
      const data = requestBody(request, "callMcpTool");
      return container.mcp.testCall(serverId, toolName, data.arguments ?? {});
    },
  );
  app.post(
    "/v1/mcp-servers/:serverId/tools/:toolName/invoke",
    async (request) => {
      const { serverId, toolName } = requestParams(request, "invokeMcpTool");
      const data = requestBody(request, "invokeMcpTool");
      return container.mcp.invokeReadOnly(serverId, toolName, data);
    },
  );
  app.post("/v1/skills/import", async (request, reply) =>
    reply
      .code(201)
      .send(
        await container.skills.importPath(
          requestBody(request, "importSkill").path,
        ),
      ),
  );
  app.post("/v1/skills/bundles", async (request, reply) =>
    reply
      .code(201)
      .send(
        await container.skills.importBundle(
          requestBody(request, "importSkillBundle").files,
        ),
      ),
  );
  app.get("/v1/skills", async (request) => {
    const q = requestQuery(request, "listSkills");
    return container.skills.page({ ...pagination(q), status: q.status });
  });
  app.get("/v1/skills/:skillId/versions", async (request) => {
    const { skillId } = requestParams(request, "listSkillVersions");
    const q = requestQuery(request, "listSkillVersions");
    return container.skills.versionsPage(skillId, pagination(q));
  });

  app.get("/v1/artifacts", async (request) => {
    const q = requestQuery(request, "listArtifacts");
    return container.artifacts.page({
      ...pagination(q),
      runId: q.run_id,
      status: q.status,
    });
  });

  app.post("/v1/artifacts", async (request, reply) => {
    const { run_id: runId } = requestQuery(request, "createArtifact");
    const part = await request.file();
    if (!part) throw new ValidationError("multipart file is required");
    return reply.code(201).send(
      await container.artifacts.createStream(part.filename, part.file, {
        runId,
        mimeType: part.mimetype,
      }),
    );
  });
  app.get("/v1/artifacts/:artifactId", async (request) => {
    const { artifactId } = requestParams(request, "getArtifact");
    return container.artifacts.get(artifactId);
  });
  app.get("/v1/artifacts/:artifactId/download", async (request, reply) => {
    const { artifactId } = requestParams(request, "downloadArtifact");
    const row = await container.artifacts.get(artifactId);
    reply
      .type(row.mime_type)
      .header(
        "Content-Disposition",
        `attachment; filename="${row.filename.replace(/["\r\n]/g, "")}"`,
      );
    return reply.send(Buffer.from(await container.artifacts.bytes(row.id)));
  });
  app.delete("/v1/artifacts/:artifactId", async (request, reply) => {
    const { artifactId } = requestParams(request, "deleteArtifact");
    await container.artifacts.remove(artifactId);
    return reply.code(204).send();
  });
  return app;
}
