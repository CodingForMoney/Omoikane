export interface RuntimeEvent<T = unknown> {
  schema_version: number;
  id: string;
  run_id: string;
  seq: number;
  type: string;
  time: string;
  data: T;
}

export interface RunCreate {
  agent_version_id: string;
  input: string | Record<string, unknown>[];
  session_id?: string;
  context?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  parent_run_id?: string;
}

export interface ClientOptions {
  baseUrl: string;
  tenantId?: string;
  actorId?: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}

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
  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.headers = {
      Accept: "application/json",
      "X-Tenant-ID": options.tenantId ?? "default",
      "X-Actor-ID": options.actorId ?? "omoikane-client",
      ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
    };
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
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
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(this.headers);
    headers.set("X-Request-ID", crypto.randomUUID());
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if (init.body && !(init.body instanceof FormData))
      headers.set("Content-Type", "application/json");
    return this.checked<T>(
      await this.fetcher(`${this.baseUrl}${path}`, { ...init, headers }),
    );
  }
  async handshake() {
    const version = await this.request<Record<string, unknown>>("/version");
    const capabilities = await this.request<{
      api_versions: number[];
      event_schema_versions: number[];
    }>("/v1/capabilities");
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
  providerDefinitions() {
    return this.request<{ data: Record<string, unknown>[] }>(
      "/v1/provider-definitions",
    );
  }
  createProvider(input: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("/v1/provider-connections", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  createAgent(input: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("/v1/agents", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  createAgentFromDefinition(document: string, publish = true) {
    return this.request<Record<string, unknown>>("/v1/agents/from-definition", {
      method: "POST",
      body: JSON.stringify({ document, publish }),
    });
  }
  createSession(scope: Record<string, unknown> = {}) {
    return this.request<Record<string, unknown>>("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ scope }),
    });
  }
  listSessions() {
    return this.request<{ data: Record<string, unknown>[] }>("/v1/sessions");
  }
  sessionMessages(sessionId: string) {
    return this.request<{ data: Record<string, unknown>[] }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/chat-messages`,
    );
  }
  createRun(input: RunCreate, idempotencyKey = crypto.randomUUID()) {
    return this.request<Record<string, unknown>>("/v1/runs", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ context: {}, limits: {}, ...input }),
    });
  }
  getRun(runId: string) {
    return this.request<Record<string, unknown>>(
      `/v1/runs/${encodeURIComponent(runId)}`,
    );
  }
  cancelRun(runId: string) {
    return this.request<Record<string, unknown>>(
      `/v1/runs/${encodeURIComponent(runId)}/cancel`,
      { method: "POST" },
    );
  }
  decideApproval(approvalId: string, approve: boolean, reason?: string) {
    return this.request<Record<string, unknown>>(
      `/v1/approvals/${encodeURIComponent(approvalId)}/${approve ? "approve" : "reject"}`,
      { method: "POST", body: JSON.stringify({ reason }) },
    );
  }
  compactSession(sessionId: string, input: Record<string, unknown> = {}) {
    return this.request<Record<string, unknown>>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/compact`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }
  async *streamRun(
    runId: string,
    after = 0,
    signal?: AbortSignal,
  ): AsyncGenerator<RuntimeEvent> {
    let cursor = after;
    while (!signal?.aborted) {
      try {
        const response = await this.fetcher(
          `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/stream`,
          {
            headers: {
              ...this.headers,
              "X-Request-ID": crypto.randomUUID(),
              "Last-Event-ID": String(cursor),
            },
            signal,
          },
        );
        if (!response.ok) await this.checked(response);
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
            const data = block
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            const event = JSON.parse(data) as RuntimeEvent;
            if (event.seq <= cursor) continue;
            cursor = event.seq;
            yield event;
          }
        }
        return;
      } catch (error) {
        if (signal?.aborted) return;
        if (error instanceof OmoikaneError) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
  async uploadArtifact(file: Blob, filename: string, runId?: string) {
    const form = new FormData();
    form.append("file", file, filename);
    return this.request<Record<string, unknown>>(
      `/v1/artifacts${runId ? `?run_id=${encodeURIComponent(runId)}` : ""}`,
      { method: "POST", body: form },
    );
  }
  async downloadArtifact(artifactId: string) {
    const response = await this.fetcher(
      `${this.baseUrl}/v1/artifacts/${encodeURIComponent(artifactId)}/download`,
      { headers: this.headers },
    );
    if (!response.ok) await this.checked(response);
    return response.blob();
  }
}
