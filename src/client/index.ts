import type {
  ApprovalRecord,
  AgentDefinitionValidate,
  ArtifactRecord,
  AudioTranscriptionCreate,
  AudioTranscriptionResponse,
  CapabilitiesResponse,
  CompactionResponse,
  ContextCompact,
  DeploymentCreate,
  DeploymentRecord,
  HealthResponse,
  InputTokenCount,
  InputTokenCountResponse,
  InputTokenCountingModel,
  JsonObject,
  McpCallResponse,
  McpHealth,
  McpInvocationResponse,
  McpOAuthClientMetadata,
  McpOAuthCallbackInput,
  McpOAuthStatus,
  McpServerInput,
  McpServerRecord,
  McpServerUpdate,
  McpToolsResponse,
  ModelReasoningMetadataCompletedData,
  ModelReasoningMetadataCompletedEvent,
  ModelReasoningMetadataEvent,
  ModelReasoningMetadataProgressData,
  ModelReasoningMetadataProgressEvent,
  ModelReasoningMetadataStartedData,
  ModelReasoningMetadataStartedEvent,
  ModelReasoningSummaryCompletedData,
  ModelReasoningSummaryCompletedEvent,
  ModelReasoningSummaryCoordinates,
  ModelReasoningSummaryDeltaData,
  ModelReasoningSummaryDeltaEvent,
  ProviderConnection,
  ProviderConnectionCreate,
  ProviderConnectionUpdate,
  ProviderModel,
  ProviderModelCreate,
  ProviderValidation,
  PageResponse,
  ResourceRecord,
  ReasoningMetadataAttempt,
  ReasoningMetadataResponse,
  RunCreate,
  RunLimits,
  RunRecord,
  RunSummary,
  SpeechCreate,
  SpeechResponse,
  RuntimeStatusResponse,
  RuntimeEvent,
  SkillBundle,
  SkillImport,
  SkillImportResponse,
  ToolCreate,
  VersionResponse,
} from "../contracts.js";
import type { ProviderDefinition } from "../providers.js";

export type {
  ApprovalRecord,
  AgentDefinitionValidate,
  ArtifactRecord,
  AudioTranscriptionCreate,
  AudioTranscriptionResponse,
  CapabilitiesResponse,
  CompactionResponse,
  ContextCompact,
  DeploymentCreate,
  DeploymentRecord,
  HealthResponse,
  InputTokenCount,
  InputTokenCountResponse,
  InputTokenCountingModel,
  JsonObject,
  McpCallResponse,
  McpHealth,
  McpInvocationResponse,
  McpOAuthClientMetadata,
  McpOAuthCallbackInput,
  McpOAuthStatus,
  McpServerInput,
  McpServerRecord,
  McpServerUpdate,
  McpToolsResponse,
  ModelReasoningMetadataCompletedData,
  ModelReasoningMetadataCompletedEvent,
  ModelReasoningMetadataEvent,
  ModelReasoningMetadataProgressData,
  ModelReasoningMetadataProgressEvent,
  ModelReasoningMetadataStartedData,
  ModelReasoningMetadataStartedEvent,
  ModelReasoningSummaryCompletedData,
  ModelReasoningSummaryCompletedEvent,
  ModelReasoningSummaryCoordinates,
  ModelReasoningSummaryDeltaData,
  ModelReasoningSummaryDeltaEvent,
  ProviderConnection,
  ProviderConnectionCreate,
  ProviderConnectionUpdate,
  ProviderModel,
  ProviderModelCreate,
  ProviderValidation,
  PageResponse,
  ResourceRecord,
  ReasoningMetadataAttempt,
  ReasoningMetadataResponse,
  RunCreate,
  RunLimits,
  RunRecord,
  RunSummary,
  SpeechCreate,
  SpeechResponse,
  RuntimeStatusResponse,
  RuntimeEvent,
  SkillBundle,
  SkillImport,
  SkillImportResponse,
  ToolCreate,
  VersionResponse,
} from "../contracts.js";

export { collectReasoningMetadata } from "../reasoning-metadata.js";

export type UsageReportingStatus = "reported" | "partial" | "missing";

export const isModelReasoningSummaryDeltaEvent = (
  event: RuntimeEvent,
): event is ModelReasoningSummaryDeltaEvent =>
  event.type === "model.reasoning_summary_delta";

export const isModelReasoningSummaryCompletedEvent = (
  event: RuntimeEvent,
): event is ModelReasoningSummaryCompletedEvent =>
  event.type === "model.reasoning_summary_completed";

export const isModelReasoningMetadataStartedEvent = (
  event: RuntimeEvent,
): event is ModelReasoningMetadataStartedEvent =>
  event.type === "model.reasoning_metadata_started";

export const isModelReasoningMetadataProgressEvent = (
  event: RuntimeEvent,
): event is ModelReasoningMetadataProgressEvent =>
  event.type === "model.reasoning_metadata_progress";

export const isModelReasoningMetadataCompletedEvent = (
  event: RuntimeEvent,
): event is ModelReasoningMetadataCompletedEvent =>
  event.type === "model.reasoning_metadata_completed";

export const isModelReasoningMetadataEvent = (
  event: RuntimeEvent,
): event is ModelReasoningMetadataEvent =>
  isModelReasoningMetadataStartedEvent(event) ||
  isModelReasoningMetadataProgressEvent(event) ||
  isModelReasoningMetadataCompletedEvent(event);

export interface UsageRecord {
  id: string;
  run_id: string;
  provider: string;
  model: string;
  reporting_status: UsageReportingStatus;
  requests: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  raw_json: {
    sdk?: Record<string, unknown>;
    provider?: Record<string, unknown>[];
  };
  created_at: string;
  updated_at: string;
}

export type McpTransport = "stdio" | "streamable_http" | "sse";
export type McpApprovalMode = "never" | "selected" | "always";

export interface ClientRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  requestId?: string;
}

export interface ClientOptions extends ClientRequestOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

export interface CreateRunOptions extends ClientRequestOptions {
  idempotencyKey: string;
}

export interface StreamRunOptions extends ClientRequestOptions {
  after?: number;
}

export interface AgentDefinitionCompilation {
  config: JsonObject;
  config_hash: string;
  document: JsonObject;
}

export interface ListPageOptions {
  limit?: number;
  cursor?: string;
  status?: string;
}

export interface RunListOptions extends ListPageOptions {
  deploymentId?: string;
  externalSessionId?: string;
  parentRunId?: string;
}

export interface ArtifactListOptions {
  runId: string;
  limit?: number;
  cursor?: string;
  status?: ArtifactRecord["status"];
}

const query = <T extends object>(values: T) => {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(values as Record<string, unknown>))
    if (value !== undefined) parameters.set(key, String(value));
  const encoded = parameters.toString();
  return encoded ? `?${encoded}` : "";
};

export const sseRetryDelay = (
  attempt: number,
  random: () => number = Math.random,
) => {
  const base = Math.min(500 * 2 ** Math.min(Math.max(attempt, 0), 4), 5_000);
  return Math.min(5_000, Math.round(base * (0.8 + random() * 0.4)));
};

export class OmoikaneError extends Error {
  constructor(
    message: string,
    readonly code = "runtime_error",
    readonly status?: number,
    readonly requestId?: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
  get retryable(): boolean {
    return (
      this.status !== undefined &&
      [408, 409, 425, 429, 500, 502, 503, 504].includes(this.status)
    );
  }
}

export class OmoikaneClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly defaultRequestOptions: ClientRequestOptions;
  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.headers = {
      Accept: "application/json",
    };
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultRequestOptions = {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      requestId: options.requestId,
    };
  }
  withOptions(options: ClientRequestOptions): OmoikaneClient {
    return new OmoikaneClient({
      baseUrl: this.baseUrl,
      fetch: this.fetcher,
      ...this.defaultRequestOptions,
      ...options,
    });
  }
  private async checked<T>(response: Response): Promise<T> {
    if (!response.ok) {
      let body: { error?: Record<string, unknown> } = {};
      try {
        body = (await response.json()) as typeof body;
      } catch {}
      const error = body.error ?? {};
      throw new OmoikaneError(
        String(error.message ?? `Omoikane returned HTTP ${response.status}`),
        String(error.code ?? "http_error"),
        response.status,
        String(
          error.request_id ?? response.headers.get("x-request-id") ?? "",
        ) || undefined,
        (error.details as Record<string, unknown>) ?? {},
      );
    }
    if (response.status === 204) return {} as T;
    return response.json() as Promise<T>;
  }
  async request<T>(
    path: string,
    init: RequestInit = {},
    options: ClientRequestOptions = {},
  ): Promise<T> {
    const effective = { ...this.defaultRequestOptions, ...options };
    if (
      effective.timeoutMs !== undefined &&
      (!Number.isFinite(effective.timeoutMs) || effective.timeoutMs <= 0)
    )
      throw new OmoikaneError(
        "timeoutMs must be a positive number",
        "invalid_client_options",
      );
    const headers = new Headers(this.headers);
    headers.set("X-Request-ID", effective.requestId ?? crypto.randomUUID());
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if (init.body && !(init.body instanceof FormData))
      headers.set("Content-Type", "application/json");
    const timeoutController = new AbortController();
    const signals = [init.signal, effective.signal].filter(
      (signal): signal is AbortSignal => Boolean(signal),
    );
    if (effective.timeoutMs !== undefined)
      signals.push(timeoutController.signal);
    const signal =
      signals.length === 0
        ? undefined
        : signals.length === 1
          ? signals[0]
          : AbortSignal.any(signals);
    let timedOut = false;
    const timeout =
      effective.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            timeoutController.abort();
          }, effective.timeoutMs);
    try {
      return await this.checked<T>(
        await this.fetcher(`${this.baseUrl}${path}`, {
          ...init,
          headers,
          signal,
        }),
      );
    } catch (error) {
      if (timedOut)
        throw new OmoikaneError(
          `Omoikane request timed out after ${effective.timeoutMs}ms`,
          "client_timeout",
          408,
          headers.get("X-Request-ID") ?? undefined,
        );
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
  async handshake() {
    const version = await this.request<VersionResponse>("/version");
    const capabilities =
      await this.request<CapabilitiesResponse>("/v1/capabilities");
    if (
      !capabilities.api_versions.includes(1) ||
      !capabilities.event_schema_versions.includes(1)
    )
      throw new OmoikaneError(
        "Runtime is incompatible with this client",
        "incompatible_runtime",
      );
    return { version, capabilities };
  }
  health() {
    return this.request<HealthResponse>("/healthz");
  }
  runtimeStatus() {
    return this.request<RuntimeStatusResponse>("/v1/runtime/status");
  }
  openApi() {
    return this.request<JsonObject>("/openapi.json");
  }
  providerDefinitions() {
    return this.request<{ data: ProviderDefinition[] }>(
      "/v1/provider-definitions",
    );
  }
  createProvider(
    input: ProviderConnectionCreate,
    options: { syncModels?: boolean } = {},
  ) {
    const query = options.syncModels === false ? "?sync_models=false" : "";
    return this.request<ProviderConnection>(
      `/v1/provider-connections${query}`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  }
  listProviders(options: ListPageOptions = {}) {
    return this.request<PageResponse<ProviderConnection>>(
      `/v1/provider-connections${query(options)}`,
    );
  }
  getProvider(connectionId: string) {
    return this.request<ProviderConnection>(
      `/v1/provider-connections/${encodeURIComponent(connectionId)}`,
    );
  }
  updateProvider(connectionId: string, input: ProviderConnectionUpdate) {
    return this.request<ProviderConnection>(
      `/v1/provider-connections/${encodeURIComponent(connectionId)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
  }
  deleteProvider(connectionId: string) {
    return this.request<void>(
      `/v1/provider-connections/${encodeURIComponent(connectionId)}`,
      { method: "DELETE" },
    );
  }
  validateProvider(connectionId: string) {
    return this.request<ProviderValidation>(
      `/v1/provider-connections/${encodeURIComponent(connectionId)}/validate`,
      { method: "POST", body: "{}" },
    );
  }
  listProviderModels(connectionId: string, options: ListPageOptions = {}) {
    return this.request<PageResponse<ProviderModel>>(
      `/v1/provider-connections/${encodeURIComponent(connectionId)}/models${query({ limit: options.limit, cursor: options.cursor })}`,
    );
  }
  addProviderModel(connectionId: string, input: ProviderModelCreate) {
    return this.request<ProviderModel>(
      `/v1/provider-connections/${encodeURIComponent(connectionId)}/models`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }
  transcribeAudio(connectionId: string, input: AudioTranscriptionCreate) {
    return this.request<AudioTranscriptionResponse>(
      `/v1/provider-connections/${encodeURIComponent(connectionId)}/audio/transcriptions`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }
  createSpeech(connectionId: string, input: SpeechCreate) {
    return this.request<SpeechResponse>(
      `/v1/provider-connections/${encodeURIComponent(connectionId)}/audio/speech`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }
  createDeployment(input: DeploymentCreate) {
    return this.request<DeploymentRecord>("/v1/deployments", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  validateAgentDefinition(input: AgentDefinitionValidate) {
    return this.request<AgentDefinitionCompilation>(
      "/v1/agent-definitions/validate",
      { method: "POST", body: JSON.stringify(input) },
    );
  }
  createMcpServer(input: McpServerInput) {
    return this.request<McpServerRecord>("/v1/mcp-servers", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  listMcpServers(options: ListPageOptions = {}) {
    return this.request<PageResponse<McpServerRecord>>(
      `/v1/mcp-servers${query(options)}`,
    );
  }
  getMcpServer(serverId: string) {
    return this.request<McpServerRecord>(
      `/v1/mcp-servers/${encodeURIComponent(serverId)}`,
    );
  }
  updateMcpServer(serverId: string, input: McpServerUpdate) {
    return this.request<McpServerRecord>(
      `/v1/mcp-servers/${encodeURIComponent(serverId)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
  }
  deleteMcpServer(serverId: string) {
    return this.request<void>(
      `/v1/mcp-servers/${encodeURIComponent(serverId)}`,
      { method: "DELETE" },
    );
  }
  mcpOAuthStatus(serverId: string) {
    return this.request<McpOAuthStatus>(
      `/v1/mcp-servers/${encodeURIComponent(serverId)}/oauth/status`,
    );
  }
  mcpOAuthClientMetadata(serverId: string) {
    return this.request<McpOAuthClientMetadata>(
      `/v1/mcp-servers/${encodeURIComponent(serverId)}/oauth/client-metadata`,
    );
  }
  startMcpOAuth(serverId: string) {
    return this.request<McpOAuthStatus>(
      `/v1/mcp-servers/${encodeURIComponent(serverId)}/oauth/start`,
      { method: "POST" },
    );
  }
  completeMcpOAuth(serverId: string, input: McpOAuthCallbackInput) {
    return this.request<McpOAuthStatus>(
      `/v1/mcp-servers/${encodeURIComponent(serverId)}/oauth/callback`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }
  disconnectMcpOAuth(serverId: string) {
    return this.request<void>(
      `/v1/mcp-servers/${encodeURIComponent(serverId)}/oauth`,
      { method: "DELETE" },
    );
  }
  mcpHealth(serverId: string) {
    return this.request<McpHealth>(
      `/v1/mcp-servers/${encodeURIComponent(serverId)}/health`,
      { method: "POST" },
    );
  }
  mcpTools(serverId: string) {
    return this.request<McpToolsResponse>(
      `/v1/mcp-servers/${encodeURIComponent(serverId)}/tools`,
    );
  }
  callMcpTool(
    serverId: string,
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ) {
    return this.request<McpCallResponse>(
      `/v1/mcp-servers/${encodeURIComponent(serverId)}/tools/${encodeURIComponent(toolName)}/call`,
      { method: "POST", body: JSON.stringify({ arguments: argumentsValue }) },
    );
  }
  invokeMcpTool(
    serverId: string,
    toolName: string,
    input: {
      arguments?: Record<string, unknown>;
      operationId?: string;
      expectedFingerprint?: string;
    } = {},
  ) {
    return this.request<McpInvocationResponse>(
      `/v1/mcp-servers/${encodeURIComponent(serverId)}/tools/${encodeURIComponent(toolName)}/invoke`,
      {
        method: "POST",
        body: JSON.stringify({
          ...(input.arguments === undefined
            ? {}
            : { arguments: input.arguments }),
          ...(input.operationId === undefined
            ? {}
            : { operation_id: input.operationId }),
          ...(input.expectedFingerprint === undefined
            ? {}
            : { expected_fingerprint: input.expectedFingerprint }),
        }),
      },
    );
  }
  deployDefinition(
    document: string,
    options: {
      overrides?: Record<string, unknown>;
      compilation_settings?: Record<string, unknown>;
    } = {},
  ) {
    return this.request<DeploymentRecord>("/v1/deployments", {
      method: "POST",
      body: JSON.stringify({ document, ...options }),
    });
  }
  listDeployments(options: ListPageOptions = {}) {
    return this.request<PageResponse<DeploymentRecord>>(
      `/v1/deployments${query(options)}`,
    );
  }
  importSkill(input: SkillImport) {
    return this.request<SkillImportResponse>("/v1/skills/import", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  importSkillBundle(input: SkillBundle) {
    return this.request<SkillImportResponse>("/v1/skills/bundles", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  listSkills(options: ListPageOptions = {}) {
    return this.request<PageResponse<ResourceRecord>>(
      `/v1/skills${query(options)}`,
    );
  }
  listSkillVersions(skillId: string, options: ListPageOptions = {}) {
    return this.request<PageResponse<ResourceRecord>>(
      `/v1/skills/${encodeURIComponent(skillId)}/versions${query({ limit: options.limit, cursor: options.cursor })}`,
    );
  }
  listTools(options: ListPageOptions = {}) {
    return this.request<PageResponse<ResourceRecord>>(
      `/v1/tools${query(options)}`,
    );
  }
  createTool(input: ToolCreate) {
    return this.request<ResourceRecord>("/v1/tools", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  createRun(input: RunCreate, options: CreateRunOptions) {
    const idempotencyKey = options?.idempotencyKey?.trim();
    if (!idempotencyKey || idempotencyKey.length > 512)
      throw new OmoikaneError(
        "createRun requires an idempotencyKey between 1 and 512 characters",
        "invalid_client_options",
      );
    return this.request<RunRecord>(
      "/v1/runs",
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ context: {}, limits: {}, ...input }),
      },
      options,
    );
  }
  listRuns(options: RunListOptions = {}) {
    return this.request<PageResponse<RunSummary>>(
      `/v1/runs${query({
        limit: options.limit,
        cursor: options.cursor,
        status: options.status,
        deployment_id: options.deploymentId,
        external_session_id: options.externalSessionId,
        parent_run_id: options.parentRunId,
      })}`,
    );
  }
  getRun(runId: string) {
    return this.request<RunRecord>(`/v1/runs/${encodeURIComponent(runId)}`);
  }
  getReasoningMetadata(runId: string) {
    return this.request<ReasoningMetadataResponse>(
      `/v1/runs/${encodeURIComponent(runId)}/reasoning-metadata`,
    );
  }
  countInputTokens(deploymentId: string, input: InputTokenCount) {
    return this.request<InputTokenCountResponse>(
      `/v1/deployments/${encodeURIComponent(deploymentId)}/input-token-count`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }
  inputTokenCountingModels() {
    return this.request<{ data: InputTokenCountingModel[] }>(
      "/v1/input-token-counting/models",
    );
  }
  cancelRun(runId: string) {
    return this.request<RunRecord>(
      `/v1/runs/${encodeURIComponent(runId)}/cancel`,
      { method: "POST" },
    );
  }
  listApprovals(options: ListPageOptions = {}) {
    return this.request<PageResponse<ApprovalRecord>>(
      `/v1/approvals${query(options)}`,
    );
  }
  decideApproval(approvalId: string, approve: boolean, reason?: string) {
    return this.request<ApprovalRecord>(
      `/v1/approvals/${encodeURIComponent(approvalId)}/${approve ? "approve" : "reject"}`,
      { method: "POST", body: JSON.stringify({ reason }) },
    );
  }
  compactContext(input: ContextCompact) {
    return this.request<CompactionResponse>("/v1/context/compact", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  runUsage(runId: string) {
    return this.request<{ data: UsageRecord[] }>(
      `/v1/runs/${encodeURIComponent(runId)}/usage`,
    );
  }
  async *streamRun(
    runId: string,
    options: StreamRunOptions | number = {},
    legacySignal?: AbortSignal,
  ): AsyncGenerator<RuntimeEvent> {
    const normalizedOptions: StreamRunOptions =
      typeof options === "number"
        ? { after: options, signal: legacySignal }
        : options;
    const effective = {
      ...this.defaultRequestOptions,
      ...normalizedOptions,
    };
    if (
      effective.timeoutMs !== undefined &&
      (!Number.isFinite(effective.timeoutMs) || effective.timeoutMs <= 0)
    )
      throw new OmoikaneError(
        "timeoutMs must be a positive number",
        "invalid_client_options",
      );
    const timeoutController = new AbortController();
    let timedOut = false;
    const timeout =
      effective.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            timeoutController.abort();
          }, effective.timeoutMs);
    const signal = effective.timeoutMs
      ? effective.signal
        ? AbortSignal.any([effective.signal, timeoutController.signal])
        : timeoutController.signal
      : effective.signal;
    const after = normalizedOptions.after ?? 0;
    let cursor = after;
    let retryAttempt = 0;
    const closesStream = new Set([
      "run.completed",
      "run.failed",
      "run.cancelled",
      "approval.required",
      "tool.reconciliation_required",
    ]);
    try {
      while (!signal?.aborted) {
        let terminalEventObserved = false;
        try {
          const response = await this.fetcher(
            `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/stream`,
            {
              headers: {
                ...this.headers,
                "X-Request-ID": effective.requestId ?? crypto.randomUUID(),
                "Last-Event-ID": String(cursor),
              },
              signal,
            },
          );
          if (!response.ok) await this.checked(response);
          retryAttempt = 0;
          if (!response.body)
            throw new OmoikaneError("SSE response has no body", "invalid_sse");
          const reader = response.body
            .pipeThrough(new TextDecoderStream())
            .getReader();
          let buffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += value.replace(/\r\n/g, "\n");
            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const block = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const eventName = block
                .split("\n")
                .find((line) => line.startsWith("event:"))
                ?.slice(6)
                .trim();
              const data = block
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              if (!data) continue;
              if (eventName === "stream.end") {
                terminalEventObserved = true;
                continue;
              }
              const event = JSON.parse(data) as RuntimeEvent;
              if (event.seq <= cursor) continue;
              if (event.seq !== cursor + 1)
                throw new OmoikaneError(
                  `SSE event sequence gap: expected ${cursor + 1}, received ${event.seq}`,
                  "sse_sequence_gap",
                );
              cursor = event.seq;
              retryAttempt = 0;
              terminalEventObserved ||= closesStream.has(event.type);
              yield event;
            }
          }
          if (terminalEventObserved) return;
        } catch (error) {
          if (timedOut)
            throw new OmoikaneError(
              `Omoikane stream timed out after ${effective.timeoutMs}ms`,
              "client_timeout",
              408,
              effective.requestId,
            );
          if (signal?.aborted) return;
          if (error instanceof OmoikaneError && !error.retryable) throw error;
        }
        if (!signal?.aborted) {
          const delay = sseRetryDelay(retryAttempt);
          retryAttempt += 1;
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timeout);
              signal?.removeEventListener("abort", finish);
              resolve();
            };
            const timeout = setTimeout(finish, delay);
            signal?.addEventListener("abort", finish, { once: true });
          });
        }
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
  async uploadArtifact(file: Blob, filename: string, runId: string) {
    const form = new FormData();
    form.append("file", file, filename);
    return this.request<ArtifactRecord>(
      `/v1/artifacts?run_id=${encodeURIComponent(runId)}`,
      { method: "POST", body: form },
    );
  }
  listArtifacts(options: ArtifactListOptions) {
    return this.request<PageResponse<ArtifactRecord>>(
      `/v1/artifacts${query({
        run_id: options.runId,
        limit: options.limit,
        cursor: options.cursor,
        status: options.status,
      })}`,
    );
  }
  getArtifact(artifactId: string) {
    return this.request<ArtifactRecord>(
      `/v1/artifacts/${encodeURIComponent(artifactId)}`,
    );
  }
  async downloadArtifact(
    artifactId: string,
    options: ClientRequestOptions = {},
  ) {
    const effective = { ...this.defaultRequestOptions, ...options };
    if (
      effective.timeoutMs !== undefined &&
      (!Number.isFinite(effective.timeoutMs) || effective.timeoutMs <= 0)
    )
      throw new OmoikaneError(
        "timeoutMs must be a positive number",
        "invalid_client_options",
      );
    const headers = new Headers(this.headers);
    headers.set("X-Request-ID", effective.requestId ?? crypto.randomUUID());
    const timeoutController = new AbortController();
    const signal = effective.timeoutMs
      ? effective.signal
        ? AbortSignal.any([effective.signal, timeoutController.signal])
        : timeoutController.signal
      : effective.signal;
    let timedOut = false;
    const timeout =
      effective.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            timeoutController.abort();
          }, effective.timeoutMs);
    try {
      const response = await this.fetcher(
        `${this.baseUrl}/v1/artifacts/${encodeURIComponent(artifactId)}/download`,
        { headers, signal },
      );
      if (!response.ok) await this.checked(response);
      return await response.blob();
    } catch (error) {
      if (timedOut)
        throw new OmoikaneError(
          `Omoikane request timed out after ${effective.timeoutMs}ms`,
          "client_timeout",
          408,
          headers.get("X-Request-ID") ?? undefined,
        );
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
  deleteArtifact(artifactId: string) {
    return this.request<void>(
      `/v1/artifacts/${encodeURIComponent(artifactId)}`,
      { method: "DELETE" },
    );
  }
}
