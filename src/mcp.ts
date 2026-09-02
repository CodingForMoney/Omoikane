import { createHash } from "node:crypto";
import {
  MCPServerSSE,
  MCPServerStdio,
  MCPServerStreamableHttp,
  mcpToFunctionTool,
  type FunctionTool,
  type MCPServer,
  type RunContext,
} from "@openai/agents";
import type { Database } from "./database.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  required,
} from "./database.js";
import { ResourceStore, type Resource } from "./resources.js";
import { canonicalJson, hashJson, newId } from "./serialization.js";
import type { RuntimeContext } from "./tools.js";
import type { FaultInjector } from "./recovery.js";
import type { PageOptions } from "./pagination.js";
import {
  McpAuthorizationRequiredError,
  McpOAuthService,
  type McpAuthConfig,
  type McpOAuthCallback,
  type McpOAuthConfig,
} from "./mcp-oauth.js";

type McpTool = Awaited<ReturnType<MCPServer["listTools"]>>[number];
type McpToolCallDetails = Parameters<
  FunctionTool<RuntimeContext, any, any>["invoke"]
>[2];

export type McpTransport = "stdio" | "streamable_http" | "sse";
export type McpApprovalMode = "never" | "selected" | "always";

export interface McpApprovalPolicy {
  mode: McpApprovalMode;
  tools: string[];
}

export interface McpPolicy extends Record<string, unknown> {
  allowed_tools?: string[];
  approval: McpApprovalPolicy;
  side_effecting_tools: string[];
  connect_timeout_ms: number;
  call_timeout_ms: number;
  max_output_bytes: number;
}

export interface McpServerData extends Record<string, unknown> {
  transport: McpTransport;
  endpoint_config: Record<string, unknown>;
  secret_refs: Record<string, string>;
  policy: McpPolicy;
  auth: McpAuthConfig;
}

export interface McpReference extends Record<string, unknown> {
  server_id?: string;
  id?: string;
  slug?: string;
  policy_override?: Record<string, unknown>;
}

export interface McpBuiltTools {
  tools: FunctionTool<RuntimeContext, any, any>[];
  close(): Promise<void>;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 262_144;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationError(`${label} must be an object`);
  return value as Record<string, unknown>;
};

const assertKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
) => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length)
    throw new ValidationError(
      `${label} contains unsupported fields: ${unknown.join(", ")}`,
    );
};

const stringList = (value: unknown, label: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new ValidationError(`${label} must be an array of strings`);
  return [...new Set(value as string[])];
};

const positiveInteger = (value: unknown, fallback: number, label: string) => {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0)
    throw new ValidationError(`${label} must be a positive integer`);
  return result;
};

const stringRecord = (
  value: unknown,
  label: string,
): Record<string, string> => {
  if (value === undefined) return {};
  const record = asRecord(value, label);
  if (Object.values(record).some((item) => typeof item !== "string"))
    throw new ValidationError(`${label} values must be strings`);
  return record as Record<string, string>;
};

function normalizeAuth(
  value: unknown,
  current: McpAuthConfig | undefined,
  transport: McpTransport,
): McpAuthConfig {
  if (value === undefined) return current ?? { type: "none" };
  const auth = asRecord(value, "MCP auth");
  const type = String(auth.type ?? "none");
  if (type === "none") {
    assertKeys(auth, ["type"], "MCP auth");
    return { type: "none" };
  }
  if (type !== "oauth")
    throw new ValidationError("MCP auth.type must be none or oauth");
  if (transport === "stdio")
    throw new ValidationError("MCP OAuth requires streamable_http or sse");
  assertKeys(
    auth,
    [
      "type",
      "scope_mode",
      "scopes",
      "write_scopes",
      "client_name",
      "client_registration",
      "token_endpoint_auth_method",
      "client_metadata_url",
      "client_id_env",
      "client_secret_env",
    ],
    "MCP auth",
  );
  const scopes = stringList(auth.scopes, "MCP auth.scopes")
    .map((scope) => scope.trim())
    .filter(Boolean);
  const scopeMode = String(
    auth.scope_mode ?? (scopes.length ? "explicit" : "auto"),
  ) as "explicit" | "auto";
  if (!["explicit", "auto"].includes(scopeMode))
    throw new ValidationError("MCP auth.scope_mode must be explicit or auto");
  if (scopeMode === "explicit" && !scopes.length)
    throw new ValidationError(
      "MCP auth.scopes must list at least one scope in explicit mode",
    );
  if (scopeMode === "auto" && scopes.length)
    throw new ValidationError(
      "MCP auth.scopes must be omitted in automatic scope mode",
    );
  if (scopes.some((scope) => scope.length > 256 || /\s/.test(scope)))
    throw new ValidationError(
      "MCP auth.scopes entries must be non-empty scope tokens",
    );
  const clientName = String(auth.client_name ?? "Omoikane MCP Client").trim();
  if (!clientName || clientName.length > 512)
    throw new ValidationError("MCP auth.client_name is invalid");
  const writeScopes = stringList(
    auth.write_scopes ?? ["mcp.write"],
    "MCP auth.write_scopes",
  )
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (writeScopes.some((scope) => scope.length > 256 || /\s/.test(scope)))
    throw new ValidationError(
      "MCP auth.write_scopes entries must be non-empty scope tokens",
    );
  const clientRegistration = String(
    auth.client_registration ?? "dynamic",
  ) as McpOAuthConfig["client_registration"];
  if (
    !["dynamic", "metadata_url", "pre_registered"].includes(clientRegistration)
  )
    throw new ValidationError(
      "MCP auth.client_registration must be dynamic, metadata_url, or pre_registered",
    );
  const tokenEndpointAuthMethod = String(
    auth.token_endpoint_auth_method ?? "none",
  ) as McpOAuthConfig["token_endpoint_auth_method"];
  if (
    !["none", "client_secret_basic", "client_secret_post"].includes(
      tokenEndpointAuthMethod,
    )
  )
    throw new ValidationError(
      "MCP auth.token_endpoint_auth_method is unsupported",
    );
  const clientMetadataUrl = auth.client_metadata_url
    ? String(auth.client_metadata_url).trim()
    : undefined;
  if (clientMetadataUrl) {
    let url: URL;
    try {
      url = new URL(clientMetadataUrl);
    } catch {
      throw new ValidationError("MCP auth.client_metadata_url is invalid");
    }
    if (url.protocol !== "https:" || url.pathname === "/")
      throw new ValidationError(
        "MCP auth.client_metadata_url must be HTTPS with a non-root path",
      );
  }
  const clientIdEnvironment = auth.client_id_env
    ? String(auth.client_id_env).trim()
    : undefined;
  const clientSecretEnvironment = auth.client_secret_env
    ? String(auth.client_secret_env).trim()
    : undefined;
  for (const [label, environmentName] of [
    ["client_id_env", clientIdEnvironment],
    ["client_secret_env", clientSecretEnvironment],
  ] as const)
    if (environmentName && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentName))
      throw new ValidationError(
        `MCP auth.${label} must name an environment variable`,
      );
  if (clientRegistration === "dynamic") {
    if (clientMetadataUrl || clientIdEnvironment || clientSecretEnvironment)
      throw new ValidationError(
        "dynamic MCP OAuth registration cannot use client metadata or pre-registered client environment variables",
      );
  } else if (clientRegistration === "metadata_url") {
    if (
      clientIdEnvironment ||
      clientSecretEnvironment ||
      tokenEndpointAuthMethod !== "none"
    )
      throw new ValidationError(
        "URL-based MCP OAuth clients cannot use client credentials",
      );
  } else {
    if (!clientIdEnvironment)
      throw new ValidationError(
        "pre-registered MCP OAuth requires client_id_env",
      );
    if (tokenEndpointAuthMethod !== "none" && !clientSecretEnvironment)
      throw new ValidationError(
        "confidential pre-registered MCP OAuth requires client_secret_env",
      );
    if (clientMetadataUrl)
      throw new ValidationError(
        "pre-registered MCP OAuth cannot use client_metadata_url",
      );
  }
  return {
    type: "oauth",
    scope_mode: scopeMode,
    scopes: [...new Set(scopes)],
    write_scopes: [...new Set(writeScopes)],
    client_name: clientName,
    client_registration: clientRegistration,
    token_endpoint_auth_method: tokenEndpointAuthMethod,
    ...(clientMetadataUrl ? { client_metadata_url: clientMetadataUrl } : {}),
    ...(clientIdEnvironment ? { client_id_env: clientIdEnvironment } : {}),
    ...(clientSecretEnvironment
      ? { client_secret_env: clientSecretEnvironment }
      : {}),
  };
}

function normalizeApproval(
  value: unknown,
  legacySelected: unknown,
  label: string,
): McpApprovalPolicy {
  if (value === undefined && legacySelected !== undefined) {
    const tools = stringList(legacySelected, `${label}.approval_required`);
    return { mode: tools.length ? "selected" : "never", tools };
  }
  if (value === undefined) return { mode: "never", tools: [] };
  const approval = asRecord(value, `${label}.approval`);
  assertKeys(approval, ["mode", "tools"], `${label}.approval`);
  const mode = String(approval.mode ?? "never") as McpApprovalMode;
  if (!["never", "selected", "always"].includes(mode))
    throw new ValidationError(
      `${label}.approval.mode must be never, selected, or always`,
    );
  const tools = stringList(approval.tools, `${label}.approval.tools`);
  if (mode === "selected" && !tools.length)
    throw new ValidationError(
      `${label}.approval.tools is required when mode is selected`,
    );
  return { mode, tools: mode === "selected" ? tools : [] };
}

function normalizePolicy(
  value: unknown,
  label = "policy",
  defaults?: McpPolicy,
): McpPolicy {
  const policy = value === undefined ? {} : asRecord(value, label);
  assertKeys(
    policy,
    [
      "allowed_tools",
      "approval",
      "approval_required",
      "side_effecting_tools",
      "connect_timeout_ms",
      "call_timeout_ms",
      "max_output_bytes",
    ],
    label,
  );
  const allowed =
    policy.allowed_tools === undefined
      ? defaults?.allowed_tools
      : stringList(policy.allowed_tools, `${label}.allowed_tools`);
  return {
    ...(allowed === undefined ? {} : { allowed_tools: allowed }),
    approval:
      policy.approval === undefined && policy.approval_required === undefined
        ? (defaults?.approval ?? { mode: "never", tools: [] })
        : normalizeApproval(policy.approval, policy.approval_required, label),
    side_effecting_tools:
      policy.side_effecting_tools === undefined
        ? (defaults?.side_effecting_tools ?? [])
        : stringList(
            policy.side_effecting_tools,
            `${label}.side_effecting_tools`,
          ),
    connect_timeout_ms: positiveInteger(
      policy.connect_timeout_ms,
      defaults?.connect_timeout_ms ?? DEFAULT_CONNECT_TIMEOUT_MS,
      `${label}.connect_timeout_ms`,
    ),
    call_timeout_ms: positiveInteger(
      policy.call_timeout_ms,
      defaults?.call_timeout_ms ?? DEFAULT_CALL_TIMEOUT_MS,
      `${label}.call_timeout_ms`,
    ),
    max_output_bytes: positiveInteger(
      policy.max_output_bytes,
      defaults?.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      `${label}.max_output_bytes`,
    ),
  };
}

function normalizeInput(
  input: Record<string, unknown>,
  current?: Resource<McpServerData> & McpServerData,
) {
  const isDocument = input.spec !== undefined || input.kind === "McpServer";
  if (isDocument) {
    assertKeys(
      input,
      ["apiVersion", "kind", "metadata", "spec"],
      "MCP document",
    );
    if ((input.apiVersion ?? "omoikane/v1") !== "omoikane/v1")
      throw new ValidationError("unsupported MCP apiVersion");
    if ((input.kind ?? "McpServer") !== "McpServer")
      throw new ValidationError("MCP kind must be McpServer");
  } else {
    assertKeys(
      input,
      [
        "slug",
        "name",
        "transport",
        "endpoint",
        "endpoint_config",
        "secret_refs",
        "auth",
        "policy",
        "execution_mode",
        "status",
      ],
      "MCP server",
    );
  }
  const metadata = isDocument
    ? asRecord(input.metadata ?? {}, "metadata")
    : input;
  if (isDocument) assertKeys(metadata, ["slug", "name"], "metadata");
  const spec = isDocument ? asRecord(input.spec ?? {}, "spec") : input;
  if (isDocument)
    assertKeys(
      spec,
      [
        "transport",
        "endpoint",
        "secret_refs",
        "auth",
        "policy",
        "execution_mode",
      ],
      "spec",
    );
  if (spec.execution_mode !== undefined && spec.execution_mode !== "runtime")
    throw new ValidationError(
      "only Runtime-managed MCP execution_mode is supported",
    );
  const slug = String(metadata.slug ?? current?.slug ?? "").trim();
  const name = String(metadata.name ?? current?.name ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,127}$/.test(slug))
    throw new ValidationError("invalid MCP server slug");
  if (!name) throw new ValidationError("MCP server name is required");
  const status = String(input.status ?? current?.status ?? "active");
  if (!["active", "disabled"].includes(status))
    throw new ValidationError("MCP server status must be active or disabled");
  const transport = String(
    spec.transport ?? current?.transport ?? "",
  ) as McpTransport;
  if (!["stdio", "streamable_http", "sse"].includes(transport))
    throw new ValidationError(
      "MCP transport must be stdio, streamable_http, or sse",
    );
  const rawEndpoint =
    spec.endpoint ?? spec.endpoint_config ?? current?.endpoint_config ?? {};
  const endpoint = asRecord(rawEndpoint, "MCP endpoint");
  if (transport === "stdio") {
    assertKeys(endpoint, ["command", "args", "cwd", "env"], "MCP endpoint");
    if (!String(endpoint.command ?? "").trim())
      throw new ValidationError("stdio MCP endpoint.command is required");
    if (
      endpoint.args !== undefined &&
      (!Array.isArray(endpoint.args) ||
        endpoint.args.some((item) => typeof item !== "string"))
    )
      throw new ValidationError("stdio MCP endpoint.args must be strings");
    stringRecord(endpoint.env, "MCP endpoint.env");
  } else {
    assertKeys(endpoint, ["url", "headers"], "MCP endpoint");
    let url: URL;
    try {
      url = new URL(String(endpoint.url ?? ""));
    } catch {
      throw new ValidationError("HTTP MCP endpoint.url must be a valid URL");
    }
    if (!["http:", "https:"].includes(url.protocol))
      throw new ValidationError("HTTP MCP endpoint.url must use http or https");
    stringRecord(endpoint.headers, "MCP endpoint.headers");
  }
  const secretRefs = stringRecord(
    spec.secret_refs ?? current?.secret_refs,
    "MCP secret_refs",
  );
  for (const [target, environmentName] of Object.entries(secretRefs)) {
    const validTarget =
      transport === "stdio"
        ? target.startsWith("env.") || !target.includes(".")
        : target.startsWith("headers.") || !target.includes(".");
    if (!validTarget)
      throw new ValidationError(
        `invalid MCP secret target ${target} for ${transport}`,
      );
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentName))
      throw new ValidationError(
        `MCP secret ref ${target} must name an environment variable`,
      );
  }
  const auth = normalizeAuth(spec.auth, current?.auth, transport);
  if (auth.type === "oauth" && transport !== "stdio") {
    const headers = stringRecord(endpoint.headers, "MCP endpoint.headers");
    const configuredAuthorization = Object.keys(headers).some(
      (name) => name.toLowerCase() === "authorization",
    );
    const secretAuthorization = Object.keys(secretRefs).some((target) => {
      const name = target.startsWith("headers.") ? target.slice(8) : target;
      return name.toLowerCase() === "authorization";
    });
    if (configuredAuthorization || secretAuthorization)
      throw new ValidationError(
        "MCP OAuth cannot be combined with an Authorization header",
      );
  }
  const policy = normalizePolicy(spec.policy, "MCP policy", current?.policy);
  if (auth.type === "oauth" && policy.approval.mode !== "always") {
    const frozenReadOnlyTools =
      Boolean(policy.allowed_tools?.length) &&
      policy.side_effecting_tools.length === 0;
    if ((auth.scope_mode ?? "explicit") === "auto" && !frozenReadOnlyTools)
      throw new ValidationError(
        "automatic MCP OAuth scopes require policy.approval.mode=always until a non-empty read-only allowed_tools list is frozen",
      );
    const requestedWriteScopes = auth.scopes.filter((scope) =>
      (auth.write_scopes ?? ["mcp.write"]).includes(scope),
    );
    if (requestedWriteScopes.length)
      throw new ValidationError(
        `MCP OAuth write scope ${requestedWriteScopes.join(", ")} requires policy.approval.mode=always`,
      );
  }
  return {
    slug,
    name,
    status,
    data: {
      transport,
      endpoint_config: endpoint,
      secret_refs: secretRefs,
      auth,
      policy,
    } satisfies McpServerData,
  };
}

function mergePolicy(base: McpPolicy, override: unknown): McpPolicy {
  if (override === undefined) return base;
  const narrowed = normalizePolicy(override, "MCP policy_override", base);
  const allowed =
    base.allowed_tools === undefined
      ? narrowed.allowed_tools
      : narrowed.allowed_tools === undefined
        ? base.allowed_tools
        : base.allowed_tools.filter((name) =>
            narrowed.allowed_tools!.includes(name),
          );
  const rank = { never: 0, selected: 1, always: 2 } as const;
  let approval: McpApprovalPolicy;
  if (base.approval.mode === "always" || narrowed.approval.mode === "always")
    approval = { mode: "always", tools: [] };
  else {
    const tools = [
      ...(base.approval.mode === "selected" ? base.approval.tools : []),
      ...(narrowed.approval.mode === "selected" ? narrowed.approval.tools : []),
    ];
    approval = tools.length
      ? { mode: "selected", tools: [...new Set(tools)] }
      : { mode: "never", tools: [] };
    if (rank[narrowed.approval.mode] < rank[base.approval.mode])
      approval = base.approval;
  }
  return {
    ...(allowed === undefined ? {} : { allowed_tools: allowed }),
    approval,
    side_effecting_tools: [
      ...new Set([
        ...base.side_effecting_tools,
        ...narrowed.side_effecting_tools,
      ]),
    ],
    connect_timeout_ms: Math.min(
      base.connect_timeout_ms,
      narrowed.connect_timeout_ms,
    ),
    call_timeout_ms: Math.min(base.call_timeout_ms, narrowed.call_timeout_ms),
    max_output_bytes: Math.min(
      base.max_output_bytes,
      narrowed.max_output_bytes,
    ),
  };
}

function approvalRequired(policy: McpPolicy, toolName: string): boolean {
  return (
    policy.side_effecting_tools.includes(toolName) ||
    policy.approval.mode === "always" ||
    (policy.approval.mode === "selected" &&
      policy.approval.tools.includes(toolName))
  );
}

function validateTool(raw: McpTool): McpTool {
  if (!TOOL_NAME.test(String(raw.name)))
    throw new ValidationError(
      `MCP tool name is not OpenAI-compatible: ${String(raw.name)}`,
    );
  const schema = asRecord(raw.inputSchema ?? {}, `MCP tool ${raw.name} schema`);
  if (schema.type !== undefined && schema.type !== "object")
    throw new ValidationError(`MCP tool ${raw.name} schema must be an object`);
  if (
    schema.properties !== undefined &&
    (!schema.properties ||
      typeof schema.properties !== "object" ||
      Array.isArray(schema.properties))
  )
    throw new ValidationError(
      `MCP tool ${raw.name} schema.properties must be an object`,
    );
  return {
    name: String(raw.name),
    ...(raw.description ? { description: String(raw.description) } : {}),
    inputSchema: {
      ...schema,
      type: "object",
      properties: (schema.properties ?? {}) as Record<string, unknown>,
      required: Array.isArray(schema.required)
        ? schema.required.map(String)
        : [],
      ...(typeof schema.additionalProperties === "boolean"
        ? { additionalProperties: schema.additionalProperties }
        : {}),
    },
  } as McpTool;
}

const referenceId = (reference: unknown): string =>
  typeof reference === "string"
    ? reference
    : String(
        (reference as McpReference).server_id ??
          (reference as McpReference).id ??
          (reference as McpReference).slug ??
          "",
      );

const referenceOverride = (reference: unknown): unknown =>
  typeof reference === "string"
    ? undefined
    : (reference as McpReference).policy_override;

class McpCallTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`MCP tool call timed out after ${timeoutMs}ms`);
    this.name = "McpCallTimeoutError";
  }
}

class McpOutputTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly limit: number,
    readonly sha256: string,
  ) {
    super(`MCP tool output is ${size} bytes; limit is ${limit} bytes`);
    this.name = "McpOutputTooLargeError";
  }
}

function serializedOutput(output: unknown) {
  const serialized = canonicalJson(output ?? null);
  return {
    serialized,
    size: Buffer.byteLength(serialized, "utf8"),
    sha256: createHash("sha256").update(serialized).digest("hex"),
  };
}

function redact(value: unknown, secrets: string[]) {
  let message = value instanceof Error ? value.message : String(value);
  for (const secret of secrets)
    if (secret) message = message.split(secret).join("[REDACTED]");
  return message.slice(0, 4_000);
}

async function timed<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new McpCallTimeoutError(timeoutMs)),
    timeoutMs,
  );
  const signal = parent
    ? AbortSignal.any([parent, controller.signal])
    : controller.signal;
  try {
    return await operation(signal);
  } catch (error) {
    if (controller.signal.aborted)
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new McpCallTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export class McpService {
  private readonly store: ResourceStore;
  constructor(
    private readonly db: Database,
    private readonly faults: FaultInjector,
    private readonly oauth: McpOAuthService,
  ) {
    this.store = new ResourceStore(db);
  }

  async create(input: Record<string, unknown>) {
    const normalized = normalizeInput(input);
    return this.store.create<McpServerData>({
      kind: "mcp_server",
      slug: normalized.slug,
      name: normalized.name,
      status: normalized.status,
      data: normalized.data,
    });
  }

  async list() {
    return this.store.list<McpServerData>("mcp_server");
  }

  async page(options: PageOptions & { status?: string } = {}) {
    return this.store.page<McpServerData>("mcp_server", options);
  }

  async get(id: string) {
    let direct;
    try {
      direct = await this.store.get<McpServerData>("mcp_server", id);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      direct = await this.store.findBySlug<McpServerData>("mcp_server", id);
    }
    if (!direct) throw new ValidationError(`MCP server not found: ${id}`);
    return direct;
  }

  async update(id: string, input: Record<string, unknown>) {
    const current = await this.get(id);
    const normalized = normalizeInput(input, current);
    const previousCredentialBoundary = hashJson({
      endpoint: current.endpoint_config,
      auth: current.auth ?? { type: "none" },
    });
    const nextCredentialBoundary = hashJson({
      endpoint: normalized.data.endpoint_config,
      auth: normalized.data.auth,
    });
    const updated = await this.store.update<McpServerData>(
      "mcp_server",
      current.id,
      {
        slug: normalized.slug,
        name: normalized.name,
        status: normalized.status,
        data: normalized.data,
      },
    );
    if (previousCredentialBoundary !== nextCredentialBoundary)
      await this.oauth.disconnect(current.id);
    return updated;
  }

  async delete(id: string) {
    const current = await this.get(id);
    await this.store.delete("mcp_server", current.id);
  }

  private async server(record: Resource<McpServerData> & McpServerData) {
    const endpoint = record.endpoint_config;
    const resolved: Record<string, string> = {};
    const secretValues: string[] = [];
    for (const [target, environmentName] of Object.entries(
      record.secret_refs,
    )) {
      const value = process.env[environmentName];
      if (!value)
        throw new ValidationError(
          `MCP secret environment variable is missing: ${environmentName}`,
        );
      resolved[target] = value;
      secretValues.push(value);
    }
    if (record.transport === "stdio") {
      const secrets = Object.fromEntries(
        Object.entries(resolved).map(([target, value]) => [
          target.startsWith("env.") ? target.slice(4) : target,
          value,
        ]),
      );
      return {
        server: new MCPServerStdio({
          name: String(record.name),
          command: String(endpoint.command),
          args: Array.isArray(endpoint.args) ? endpoint.args.map(String) : [],
          cwd: endpoint.cwd ? String(endpoint.cwd) : undefined,
          env: {
            PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            LANG: process.env.LANG ?? "C.UTF-8",
            ...stringRecord(endpoint.env, "MCP endpoint.env"),
            ...secrets,
          },
          cacheToolsList: true,
          clientSessionTimeoutSeconds: Math.ceil(
            record.policy.call_timeout_ms / 1000,
          ),
          errorFunction: null,
        }),
        secretValues,
      };
    }
    const secrets = Object.fromEntries(
      Object.entries(resolved).map(([target, value]) => [
        target.startsWith("headers.") ? target.slice(8) : target,
        value,
      ]),
    );
    if (record.auth?.type === "oauth") {
      const status = await this.oauth.status(record.id, record.auth);
      if (status.status === "disconnected")
        throw new McpAuthorizationRequiredError(record.id);
    }
    const options = {
      name: String(record.name),
      url: String(endpoint.url),
      requestInit: {
        headers: {
          ...stringRecord(endpoint.headers, "MCP endpoint.headers"),
          ...secrets,
        },
      },
      cacheToolsList: true,
      clientSessionTimeoutSeconds: Math.ceil(
        record.policy.call_timeout_ms / 1000,
      ),
      errorFunction: null,
      ...(record.auth?.type === "oauth"
        ? { authProvider: this.oauth.provider(record.id, record.auth) }
        : {}),
    };
    return {
      server:
        record.transport === "sse"
          ? new MCPServerSSE(options)
          : new MCPServerStreamableHttp(options),
      secretValues,
    };
  }

  private async connected(record: Resource<McpServerData> & McpServerData) {
    const built = await this.server(record);
    try {
      await timed(async () => {
        await built.server.connect();
      }, record.policy.connect_timeout_ms);
      return built;
    } catch (error) {
      await built.server.close().catch(() => undefined);
      if (record.auth?.type === "oauth") {
        const status = await this.oauth.status(record.id, record.auth);
        if (status.status === "authorization_pending")
          throw new McpAuthorizationRequiredError(record.id);
      }
      throw new ValidationError(redact(error, built.secretValues));
    }
  }

  private async oauthRecord(id: string) {
    const record = await this.get(id);
    if (record.transport === "stdio" || record.auth?.type !== "oauth")
      throw new ValidationError("MCP server is not configured for HTTP OAuth");
    return record as typeof record & { auth: McpOAuthConfig };
  }

  async oauthStatus(id: string) {
    const record = await this.get(id);
    if (record.auth?.type !== "oauth")
      return {
        type: "none" as const,
        status: "not_configured" as const,
        server_id: record.id,
        scope_mode: "explicit" as const,
        scopes_requested: [],
        scopes_granted: [],
        authorization_server: null,
        authorization_url: null,
        token_expires_at: null,
      };
    return this.oauth.status(record.id, record.auth);
  }

  async oauthClientMetadata(id: string) {
    const record = await this.oauthRecord(id);
    return this.oauth.clientMetadata(record.id, record.auth);
  }

  async startOAuth(id: string) {
    const record = await this.oauthRecord(id);
    return this.oauth.start(
      record.id,
      String(record.endpoint_config.url),
      record.auth,
    );
  }

  async completeOAuth(id: string, callback: McpOAuthCallback) {
    const record = await this.oauthRecord(id);
    return this.oauth.complete(
      record.id,
      String(record.endpoint_config.url),
      record.auth,
      callback,
    );
  }

  async disconnectOAuth(id: string) {
    const record = await this.get(id);
    await this.oauth.disconnect(record.id);
  }

  private effectiveTools(tools: McpTool[], policy: McpPolicy) {
    const discovered: McpTool[] = [];
    const blocked: Array<{ name: string; reason: string }> = [];
    const names = new Set<string>();
    for (const raw of tools) {
      try {
        const tool = validateTool(raw);
        if (names.has(tool.name))
          throw new ValidationError(`duplicate MCP tool name: ${tool.name}`);
        names.add(tool.name);
        discovered.push(tool);
      } catch (error) {
        blocked.push({ name: String(raw.name), reason: String(error) });
      }
    }
    const effective = discovered.filter((tool) => {
      const allowed =
        policy.allowed_tools === undefined ||
        policy.allowed_tools.includes(tool.name);
      if (!allowed) blocked.push({ name: tool.name, reason: "not allowed" });
      return allowed;
    });
    return { discovered, effective, blocked };
  }

  async health(id: string) {
    const record = await this.get(id);
    const built = await this.connected(record);
    try {
      const listed = await timed(
        () => built.server.listTools(),
        record.policy.connect_timeout_ms,
      );
      const tools = this.effectiveTools(listed, record.policy);
      return {
        status: tools.blocked.some((item) => item.reason !== "not allowed")
          ? "degraded"
          : "ok",
        server_id: record.id,
        server_slug: record.slug,
        transport: record.transport,
        fingerprint: hashJson({
          tools: tools.effective,
          policy: record.policy,
        }),
        discovered_tool_count: tools.discovered.length,
        effective_tool_count: tools.effective.length,
        tools: tools.effective.map((tool) => tool.name),
        discovered_tools: tools.discovered,
        effective_tools: tools.effective,
        blocked_tools: tools.blocked,
      };
    } catch (error) {
      throw new ValidationError(redact(error, built.secretValues));
    } finally {
      await built.server.close().catch(() => undefined);
    }
  }

  async inspectTools(id: string) {
    const health = await this.health(id);
    return {
      server_id: health.server_id,
      fingerprint: health.fingerprint,
      data: health.effective_tools,
      blocked: health.blocked_tools,
    };
  }

  private async binding(
    runId: string,
    record: Resource<McpServerData> & McpServerData,
    server: MCPServer,
    policy: McpPolicy,
    persist: boolean,
  ): Promise<{ tools: McpTool[]; policy: McpPolicy; fingerprint: string }> {
    if (!persist) {
      const listed = await timed(
        () => server.listTools(),
        policy.connect_timeout_ms,
      );
      const effective = this.effectiveTools(listed, policy);
      if (effective.blocked.some((item) => item.reason !== "not allowed"))
        throw new ValidationError(
          `MCP server ${record.slug} exposes invalid tools: ${effective.blocked
            .filter((item) => item.reason !== "not allowed")
            .map((item) => `${item.name}: ${item.reason}`)
            .join("; ")}`,
        );
      return {
        tools: effective.effective,
        policy,
        fingerprint: hashJson({ tools: effective.effective, policy }),
      };
    }
    const existing = (
      await this.db.query<{
        tools_json: McpTool[];
        policy_json: McpPolicy;
        fingerprint: string;
      }>(
        "SELECT tools_json,policy_json,fingerprint FROM mcp_run_bindings WHERE run_id=$1 AND server_id=$2",
        [runId, record.id],
      )
    ).rows[0];
    if (existing)
      return {
        tools: existing.tools_json.map(validateTool),
        policy: normalizePolicy(existing.policy_json),
        fingerprint: existing.fingerprint,
      };
    const listed = await timed(
      () => server.listTools(),
      policy.connect_timeout_ms,
    );
    const effective = this.effectiveTools(listed, policy);
    if (effective.blocked.some((item) => item.reason !== "not allowed"))
      throw new ValidationError(
        `MCP server ${record.slug} exposes invalid tools: ${effective.blocked
          .filter((item) => item.reason !== "not allowed")
          .map((item) => `${item.name}: ${item.reason}`)
          .join("; ")}`,
      );
    const fingerprint = hashJson({ tools: effective.effective, policy });
    await this.db.query(
      `INSERT INTO mcp_run_bindings(run_id,server_id,server_slug,fingerprint,tools_json,policy_json)
       VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)
       ON CONFLICT(run_id,server_id) DO NOTHING`,
      [
        runId,
        record.id,
        record.slug,
        fingerprint,
        JSON.stringify(effective.effective),
        JSON.stringify(policy),
      ],
    );
    const persisted = await required<{
      tools_json: McpTool[];
      policy_json: McpPolicy;
      fingerprint: string;
    }>(
      this.db,
      "SELECT tools_json,policy_json,fingerprint FROM mcp_run_bindings WHERE run_id=$1 AND server_id=$2",
      [runId, record.id],
    );
    return {
      tools: persisted.tools_json.map(validateTool),
      policy: normalizePolicy(persisted.policy_json),
      fingerprint: persisted.fingerprint,
    };
  }

  private wrappedTool(
    record: Resource<McpServerData> & McpServerData,
    server: MCPServer,
    secrets: string[],
    definition: McpTool,
    policy: McpPolicy,
  ): FunctionTool<RuntimeContext, any, any> {
    const base = mcpToFunctionTool(definition, server, false, {
      errorFunction: null,
    }) as FunctionTool<RuntimeContext, any, any>;
    const sideEffecting = policy.side_effecting_tools.includes(definition.name);
    const invoke = async (
      runContext: RunContext<RuntimeContext>,
      input: string,
      details?: McpToolCallDetails,
    ) => {
      if (
        policy.allowed_tools !== undefined &&
        !policy.allowed_tools.includes(definition.name)
      )
        throw new ValidationError(
          `MCP tool is blocked by policy: ${definition.name}`,
        );
      let args: unknown = input;
      try {
        args = JSON.parse(input);
      } catch {
        // The SDK performs input validation; preserve the exact raw input for hashing.
      }
      const call = details?.toolCall as Record<string, unknown> | undefined;
      const callId = String(call?.callId ?? call?.call_id ?? newId());
      const idempotencyKey = hashJson({
        run_id: runContext.context.run_id,
        call_id: callId,
        server_id: record.id,
        tool: definition.name,
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
          (sideEffecting &&
            existing.status === "failed" &&
            !existing.resolution_reason))
      )
        throw new ConflictError("MCP tool execution outcome is unresolved");
      const executionId = String(existing?.id ?? newId());
      if (existing) {
        await this.db.query(
          "UPDATE tool_executions SET status='running',attempt_count=attempt_count+1,error_json=NULL,lease_expires_at=now()+($2 || ' milliseconds')::interval,updated_at=now() WHERE id=$1",
          [executionId, policy.call_timeout_ms + 5_000],
        );
      } else {
        await this.db.query(
          `INSERT INTO tool_executions(
             id,run_id,tool_call_id,tool_name,implementation_key,idempotency_key,arguments_hash,
             lease_expires_at,source_type,source_id,side_effecting)
           VALUES($1,$2,$3,$4,$5,$6,$7,now()+($8 || ' milliseconds')::interval,'mcp',$9,$10)`,
          [
            executionId,
            runContext.context.run_id,
            callId,
            definition.name,
            `mcp.${record.slug}.${definition.name}`,
            idempotencyKey,
            hashJson(args),
            policy.call_timeout_ms + 5_000,
            record.id,
            sideEffecting,
          ],
        );
      }
      let returned = false;
      try {
        const output = await timed(
          (signal) =>
            base.invoke(runContext, input, {
              ...details,
              signal,
            } as NonNullable<McpToolCallDetails>),
          policy.call_timeout_ms,
          details?.signal,
        );
        returned = true;
        const measured = serializedOutput(output);
        if (measured.size > policy.max_output_bytes)
          throw new McpOutputTooLargeError(
            measured.size,
            policy.max_output_bytes,
            measured.sha256,
          );
        await this.faults.hit("tool.after_effect_before_commit", {
          run_id: runContext.context.run_id,
          execution_id: executionId,
          tool_name: definition.name,
          side_effecting: sideEffecting,
          source: "mcp",
        });
        await this.db.query(
          `UPDATE tool_executions SET status='completed',output_json=$2::jsonb,
           output_size=$3,output_sha256=$4,completed_at=now(),lease_expires_at=NULL,updated_at=now()
           WHERE id=$1`,
          [
            executionId,
            JSON.stringify(output ?? null),
            measured.size,
            measured.sha256,
          ],
        );
        return output;
      } catch (error) {
        const oversized = error instanceof McpOutputTooLargeError;
        const status = sideEffecting ? "unknown" : "failed";
        await this.db
          .query(
            `UPDATE tool_executions SET status=$2,error_json=$3::jsonb,
             output_size=$4,output_sha256=$5,completed_at=now(),lease_expires_at=NULL,updated_at=now()
             WHERE id=$1`,
            [
              executionId,
              status,
              JSON.stringify({
                code: error instanceof Error ? error.name : "Error",
                message: redact(error, secrets),
                ...(oversized
                  ? { limit: error.limit, actual: error.size }
                  : {}),
                ...(returned ? { provider_returned: true } : {}),
              }),
              oversized ? error.size : null,
              oversized ? error.sha256 : null,
            ],
          )
          .catch(() => undefined);
        throw error;
      }
    };
    return {
      ...base,
      invoke,
      needsApproval: async () => approvalRequired(policy, definition.name),
      timeoutMs: policy.call_timeout_ms + 1_000,
      timeoutBehavior: "raise_exception",
      isEnabled: async () => true,
    };
  }

  async toolsForRun(
    references: unknown[],
    context: RuntimeContext,
    reservedNames: Set<string>,
    options: { persistBindings?: boolean } = {},
  ): Promise<McpBuiltTools> {
    const opened: MCPServer[] = [];
    const tools: FunctionTool<RuntimeContext, any, any>[] = [];
    const names = new Set(reservedNames);
    try {
      for (const reference of references) {
        const id = referenceId(reference);
        if (!id) throw new ValidationError("MCP server reference is required");
        const record = await this.get(id);
        if (record.status !== "active")
          throw new ValidationError(`MCP server is not active: ${id}`);
        const policy = mergePolicy(
          normalizePolicy(record.policy),
          referenceOverride(reference),
        );
        const built = await this.connected({ ...record, policy });
        opened.push(built.server);
        const binding = await this.binding(
          context.run_id,
          record,
          built.server,
          policy,
          options.persistBindings ?? true,
        );
        for (const definition of binding.tools) {
          if (names.has(definition.name))
            throw new ValidationError(
              `tool name collision while attaching MCP server ${record.slug}: ${definition.name}`,
            );
          names.add(definition.name);
          tools.push(
            this.wrappedTool(
              record,
              built.server,
              built.secretValues,
              definition,
              binding.policy,
            ),
          );
        }
      }
      return {
        tools,
        close: async () => {
          await Promise.allSettled(opened.map((server) => server.close()));
        },
      };
    } catch (error) {
      await Promise.allSettled(opened.map((server) => server.close()));
      throw error;
    }
  }

  async testCall(id: string, toolName: string, args: Record<string, unknown>) {
    const invoked = await this.invokeReadOnly(id, toolName, {
      arguments: args,
    });
    return {
      output: invoked.output,
      output_size: invoked.output_size,
      output_sha256: invoked.output_sha256,
    };
  }

  async invokeReadOnly(
    id: string,
    toolName: string,
    input: {
      arguments?: Record<string, unknown>;
      operation_id?: string;
      expected_fingerprint?: string;
    },
  ) {
    const startedAt = new Date().toISOString();
    const record = await this.get(id);
    const policy = normalizePolicy(record.policy);
    if (
      policy.allowed_tools !== undefined &&
      !policy.allowed_tools.includes(toolName)
    )
      throw new ValidationError(`MCP tool is blocked by policy: ${toolName}`);
    if (
      approvalRequired(policy, toolName) ||
      policy.side_effecting_tools.includes(toolName)
    )
      throw new ValidationError(
        "approval-required or side-effecting MCP tools must be invoked through an Agent Run",
      );
    const built = await this.connected(record);
    try {
      const listed = this.effectiveTools(
        await timed(() => built.server.listTools(), policy.connect_timeout_ms),
        policy,
      );
      const fingerprint = hashJson({ tools: listed.effective, policy });
      if (
        input.expected_fingerprint !== undefined &&
        input.expected_fingerprint !== fingerprint
      )
        throw new ConflictError("MCP Tool fingerprint changed");
      const definition = listed.effective.find(
        (tool) => tool.name === toolName,
      );
      if (!definition)
        throw new ValidationError(
          `MCP tool not found or not allowed: ${toolName}`,
        );
      const output = await timed(
        (signal) =>
          built.server.callTool(toolName, input.arguments ?? {}, null, {
            signal,
          }),
        policy.call_timeout_ms,
      );
      const measured = serializedOutput(output);
      if (measured.size > policy.max_output_bytes)
        throw new McpOutputTooLargeError(
          measured.size,
          policy.max_output_bytes,
          measured.sha256,
        );
      return {
        invocation_id: newId(),
        operation_id: input.operation_id ?? null,
        server_id: record.id,
        tool_name: toolName,
        fingerprint,
        output,
        output_size: measured.size,
        output_sha256: measured.sha256,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof ConflictError) throw error;
      throw new ValidationError(redact(error, built.secretValues));
    } finally {
      await built.server.close().catch(() => undefined);
    }
  }
}

export const MCP_DEFAULTS = {
  connect_timeout_ms: DEFAULT_CONNECT_TIMEOUT_MS,
  call_timeout_ms: DEFAULT_CALL_TIMEOUT_MS,
  max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
} as const;
