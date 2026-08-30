import { randomBytes } from "node:crypto";
import {
  auth,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { Database, SqlExecutor } from "./database.js";
import { ConflictError, ValidationError } from "./database.js";
import { CredentialCipher } from "./crypto.js";

export interface McpOAuthConfig extends Record<string, unknown> {
  type: "oauth";
  scope_mode: "explicit" | "auto";
  scopes: string[];
  write_scopes: string[];
  client_name: string;
  client_registration: "dynamic" | "metadata_url" | "pre_registered";
  token_endpoint_auth_method:
    "none" | "client_secret_basic" | "client_secret_post";
  client_metadata_url?: string;
  client_id_env?: string;
  client_secret_env?: string;
}

export interface McpNoAuthConfig extends Record<string, unknown> {
  type: "none";
}

export type McpAuthConfig = McpOAuthConfig | McpNoAuthConfig;

export interface McpOAuthCallback {
  code?: string;
  state?: string;
  iss?: string;
  error?: string;
  error_description?: string;
}

export interface McpOAuthStatus {
  type: "oauth";
  status: "disconnected" | "authorization_pending" | "connected";
  server_id: string;
  scope_mode: "explicit" | "auto";
  scopes_requested: string[];
  scopes_granted: string[];
  authorization_server: string | null;
  authorization_url: string | null;
  token_expires_at: string | null;
}

interface PersistedOAuthState {
  version: 1;
  clients: Record<string, StoredOAuthClientInformation>;
  tokens: Record<string, StoredOAuthTokens>;
  token_expires_at: Record<string, string>;
  last_issuer?: string;
  code_verifier?: string;
  oauth_state?: string;
  pending_started_at?: string;
  authorization_url?: string;
  discovery?: OAuthDiscoveryState;
}

interface OAuthStateRow extends Record<string, unknown> {
  encrypted_state: Uint8Array;
  checksum: string;
}

const emptyState = (): PersistedOAuthState => ({
  version: 1,
  clients: {},
  tokens: {},
  token_expires_at: {},
});

const issuerFor = (
  state: PersistedOAuthState,
  context?: OAuthClientInformationContext,
) => context?.issuer ?? state.last_issuer;

const onlyValue = <T>(record: Record<string, T>): T | undefined => {
  const values = Object.values(record);
  return values.length === 1 ? values[0] : undefined;
};

class McpOAuthStateStore {
  private readonly cipher: CredentialCipher;

  constructor(
    private readonly db: Database,
    credentialSecret: string,
  ) {
    this.cipher = new CredentialCipher(credentialSecret);
  }

  private encode(state: PersistedOAuthState) {
    return this.cipher.encrypt(JSON.stringify(state));
  }

  private decode(row: OAuthStateRow): PersistedOAuthState {
    const parsed = JSON.parse(
      this.cipher.decrypt(row.encrypted_state, row.checksum).toString(),
    ) as PersistedOAuthState;
    if (
      parsed.version !== 1 ||
      !parsed.clients ||
      !parsed.tokens ||
      !parsed.token_expires_at
    )
      throw new Error("unsupported MCP OAuth state format");
    return parsed;
  }

  private async ensure(serverId: string, executor: SqlExecutor = this.db) {
    const encoded = this.encode(emptyState());
    await executor.query(
      `INSERT INTO mcp_oauth_states(server_id,encrypted_state,checksum)
       VALUES ($1,$2,$3) ON CONFLICT(server_id) DO NOTHING`,
      [serverId, encoded.ciphertext, encoded.checksum],
    );
  }

  async read(serverId: string): Promise<PersistedOAuthState> {
    const row = (
      await this.db.query<OAuthStateRow>(
        "SELECT encrypted_state,checksum FROM mcp_oauth_states WHERE server_id=$1",
        [serverId],
      )
    ).rows[0];
    return row ? this.decode(row) : emptyState();
  }

  async mutate(
    serverId: string,
    callback: (state: PersistedOAuthState) => void | Promise<void>,
  ) {
    await this.ensure(serverId);
    return this.db.transaction(async (tx) => {
      const row = (
        await tx.query<OAuthStateRow>(
          `SELECT encrypted_state,checksum FROM mcp_oauth_states
           WHERE server_id=$1 FOR UPDATE`,
          [serverId],
        )
      ).rows[0];
      if (!row) throw new Error("MCP OAuth state disappeared during update");
      const state = this.decode(row);
      await callback(state);
      const encoded = this.encode(state);
      await tx.query(
        `UPDATE mcp_oauth_states
         SET encrypted_state=$2,checksum=$3,updated_at=now()
         WHERE server_id=$1`,
        [serverId, encoded.ciphertext, encoded.checksum],
      );
      return state;
    });
  }

  async delete(serverId: string) {
    await this.db.query("DELETE FROM mcp_oauth_states WHERE server_id=$1", [
      serverId,
    ]);
  }

  async verifyEncryption() {
    const table = await this.db.query<{ relation: string | null }>(
      "SELECT to_regclass('public.mcp_oauth_states')::text AS relation",
    );
    if (!table.rows[0]?.relation) return 0;
    const rows = await this.db.query<OAuthStateRow>(
      "SELECT encrypted_state,checksum FROM mcp_oauth_states",
    );
    for (const row of rows.rows) this.decode(row);
    return rows.rows.length;
  }
}

class PersistentMcpOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  readonly clientMetadataUrl?: string;
  readonly clientMetadata: OAuthClientMetadata;
  private readonly allowedScopes?: Set<string>;

  constructor(
    private readonly serverId: string,
    private readonly store: McpOAuthStateStore,
    redirectUrl: string,
    private readonly config: McpOAuthConfig,
    clientMetadataUrl?: string,
  ) {
    this.redirectUrl = redirectUrl;
    this.clientMetadataUrl = clientMetadataUrl;
    const scopeMode = config.scope_mode ?? "explicit";
    this.allowedScopes =
      scopeMode === "explicit"
        ? new Set([...config.scopes, "offline_access"])
        : undefined;
    this.clientMetadata = {
      redirect_uris: [redirectUrl],
      token_endpoint_auth_method: config.token_endpoint_auth_method ?? "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: config.client_name,
      ...(scopeMode === "explicit" ? { scope: config.scopes.join(" ") } : {}),
    };
  }

  private assertScopes(scope: string | undefined) {
    const allowedScopes = this.allowedScopes;
    if (!scope || !allowedScopes) return;
    const unapproved = scope
      .split(/\s+/)
      .filter(Boolean)
      .filter((item) => !allowedScopes.has(item));
    if (unapproved.length)
      throw new ValidationError(
        `MCP OAuth server requested scopes not approved by configuration: ${[
          ...new Set(unapproved),
        ].join(", ")}`,
      );
  }

  async state() {
    const current = await this.store.read(this.serverId);
    if (current.oauth_state) return current.oauth_state;
    const value = randomBytes(32).toString("base64url");
    await this.store.mutate(this.serverId, (state) => {
      state.oauth_state = value;
      state.pending_started_at = new Date().toISOString();
    });
    return value;
  }

  async clientInformation(context?: OAuthClientInformationContext) {
    if (this.config.client_registration === "pre_registered") {
      const clientId = process.env[this.config.client_id_env!];
      if (!clientId)
        throw new ValidationError(
          `MCP OAuth client environment variable is missing: ${this.config.client_id_env}`,
        );
      const secretEnvironment = this.config.client_secret_env;
      const clientSecret = secretEnvironment
        ? process.env[secretEnvironment]
        : undefined;
      if (secretEnvironment && !clientSecret)
        throw new ValidationError(
          `MCP OAuth client environment variable is missing: ${secretEnvironment}`,
        );
      return {
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        token_endpoint_auth_method: this.config.token_endpoint_auth_method,
        ...(context?.issuer ? { issuer: context.issuer } : {}),
      } satisfies StoredOAuthClientInformation;
    }
    const state = await this.store.read(this.serverId);
    const issuer = issuerFor(state, context);
    return issuer ? state.clients[issuer] : onlyValue(state.clients);
  }

  async saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
    context?: OAuthClientInformationContext,
  ) {
    await this.store.mutate(this.serverId, (state) => {
      const issuer =
        context?.issuer ?? clientInformation.issuer ?? state.last_issuer;
      if (!issuer)
        throw new Error("OAuth client information is missing its issuer");
      state.clients[issuer] = clientInformation;
      state.last_issuer = issuer;
    });
  }

  async tokens(context?: OAuthClientInformationContext) {
    const state = await this.store.read(this.serverId);
    const issuer = issuerFor(state, context);
    return issuer ? state.tokens[issuer] : onlyValue(state.tokens);
  }

  async saveTokens(
    tokens: StoredOAuthTokens,
    context?: OAuthClientInformationContext,
  ) {
    this.assertScopes(tokens.scope);
    await this.store.mutate(this.serverId, (state) => {
      const issuer = context?.issuer ?? tokens.issuer ?? state.last_issuer;
      if (!issuer) throw new Error("OAuth tokens are missing their issuer");
      state.tokens[issuer] = tokens;
      state.last_issuer = issuer;
      if (tokens.expires_in !== undefined) {
        state.token_expires_at[issuer] = new Date(
          Date.now() + Number(tokens.expires_in) * 1_000,
        ).toISOString();
      } else delete state.token_expires_at[issuer];
    });
  }

  async redirectToAuthorization(authorizationUrl: URL) {
    this.assertScopes(authorizationUrl.searchParams.get("scope") ?? undefined);
    await this.store.mutate(this.serverId, (state) => {
      state.authorization_url = authorizationUrl.toString();
      state.pending_started_at ??= new Date().toISOString();
    });
  }

  async saveCodeVerifier(codeVerifier: string) {
    await this.store.mutate(this.serverId, (state) => {
      state.code_verifier = codeVerifier;
    });
  }

  async codeVerifier() {
    const verifier = (await this.store.read(this.serverId)).code_verifier;
    if (!verifier) throw new Error("MCP OAuth PKCE verifier is missing");
    return verifier;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ) {
    await this.store.mutate(this.serverId, (state) => {
      if (scope === "all" || scope === "client") state.clients = {};
      if (scope === "all" || scope === "tokens") {
        state.tokens = {};
        state.token_expires_at = {};
      }
      if (scope === "all" || scope === "verifier") {
        delete state.code_verifier;
        delete state.oauth_state;
        delete state.pending_started_at;
        delete state.authorization_url;
      }
      if (scope === "all" || scope === "discovery") delete state.discovery;
      if (scope === "all") delete state.last_issuer;
    });
  }

  async saveAuthorizationServerUrl(authorizationServerUrl: string) {
    await this.store.mutate(this.serverId, (state) => {
      state.last_issuer = authorizationServerUrl;
    });
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState) {
    await this.store.mutate(this.serverId, (state) => {
      state.discovery = discovery;
    });
  }

  async discoveryState() {
    return (await this.store.read(this.serverId)).discovery;
  }
}

export class McpAuthorizationRequiredError extends ConflictError {
  readonly errorCode = "mcp_authorization_required";

  constructor(serverId: string) {
    super(
      `MCP server authorization is required; start OAuth at /v1/mcp-servers/${encodeURIComponent(serverId)}/oauth/start`,
    );
  }
}

export class McpOAuthService {
  private readonly store: McpOAuthStateStore;

  constructor(
    db: Database,
    credentialSecret: string,
    private readonly publicBaseUrl: string,
  ) {
    this.store = new McpOAuthStateStore(db, credentialSecret);
  }

  callbackUrl(serverId: string) {
    const base = new URL(this.publicBaseUrl);
    const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
    if (base.protocol !== "https:" && !localHosts.has(base.hostname))
      throw new ValidationError(
        "MCP OAuth requires an HTTPS OMOIKANE_PUBLIC_BASE_URL or a loopback callback",
      );
    return `${this.publicBaseUrl}/v1/mcp-servers/${encodeURIComponent(serverId)}/oauth/callback`;
  }

  clientMetadataUrl(serverId: string, config: McpOAuthConfig) {
    if (config.client_registration !== "metadata_url") return undefined;
    const value =
      config.client_metadata_url ??
      `${this.publicBaseUrl}/v1/mcp-servers/${encodeURIComponent(serverId)}/oauth/client-metadata`;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ValidationError("MCP OAuth client_metadata_url is invalid");
    }
    if (url.protocol !== "https:" || url.pathname === "/")
      throw new ValidationError(
        "URL-based MCP OAuth client metadata requires a public HTTPS URL with a non-root path",
      );
    return url.toString();
  }

  provider(serverId: string, config: McpOAuthConfig) {
    return new PersistentMcpOAuthProvider(
      serverId,
      this.store,
      this.callbackUrl(serverId),
      config,
      this.clientMetadataUrl(serverId, config),
    );
  }

  clientMetadata(serverId: string, config: McpOAuthConfig) {
    if (config.client_registration !== "metadata_url")
      throw new ValidationError(
        "MCP server is not configured for URL-based OAuth client metadata",
      );
    return this.provider(serverId, config).clientMetadata;
  }

  private async beginPending(serverId: string) {
    await this.store.mutate(serverId, (state) => {
      state.oauth_state = randomBytes(32).toString("base64url");
      state.pending_started_at = new Date().toISOString();
      delete state.authorization_url;
      delete state.code_verifier;
    });
  }

  private async clearPending(serverId: string) {
    await this.store.mutate(serverId, (state) => {
      delete state.oauth_state;
      delete state.pending_started_at;
      delete state.authorization_url;
      delete state.code_verifier;
    });
  }

  async start(serverId: string, serverUrl: string, config: McpOAuthConfig) {
    await this.beginPending(serverId);
    try {
      const result = await auth(this.provider(serverId, config), {
        serverUrl,
        ...((config.scope_mode ?? "explicit") === "explicit"
          ? { scope: config.scopes.join(" ") }
          : {}),
      });
      if (result === "AUTHORIZED") await this.clearPending(serverId);
      const status = await this.status(serverId, config);
      if (result === "REDIRECT" && !status.authorization_url)
        throw new Error("OAuth authorization URL was not persisted");
      return status;
    } catch (error) {
      await this.clearPending(serverId).catch(() => undefined);
      throw error;
    }
  }

  async complete(
    serverId: string,
    serverUrl: string,
    config: McpOAuthConfig,
    callback: McpOAuthCallback,
  ) {
    const state = await this.store.read(serverId);
    const started = state.pending_started_at
      ? Date.parse(state.pending_started_at)
      : Number.NaN;
    if (
      !state.oauth_state ||
      !callback.state ||
      callback.state !== state.oauth_state ||
      !Number.isFinite(started) ||
      Date.now() - started > 15 * 60 * 1_000
    )
      throw new ValidationError("invalid or expired MCP OAuth state");
    if (callback.error) {
      await this.clearPending(serverId);
      const description = callback.error_description
        ? `: ${callback.error_description.slice(0, 512)}`
        : "";
      throw new ValidationError(
        `MCP OAuth authorization failed (${callback.error})${description}`,
      );
    }
    if (!callback.code)
      throw new ValidationError("MCP OAuth callback code is required");
    try {
      const result = await auth(this.provider(serverId, config), {
        serverUrl,
        authorizationCode: callback.code,
        iss: callback.iss,
        ...((config.scope_mode ?? "explicit") === "explicit"
          ? { scope: config.scopes.join(" ") }
          : {}),
      });
      if (result !== "AUTHORIZED")
        throw new Error("MCP OAuth callback did not authorize the client");
      await this.clearPending(serverId);
      return this.status(serverId, config);
    } catch (error) {
      await this.clearPending(serverId).catch(() => undefined);
      throw error;
    }
  }

  async status(
    serverId: string,
    config: McpOAuthConfig,
  ): Promise<McpOAuthStatus> {
    const state = await this.store.read(serverId);
    const issuer = state.last_issuer;
    const tokens = issuer ? state.tokens[issuer] : onlyValue(state.tokens);
    const expiresAt = issuer
      ? state.token_expires_at[issuer]
      : onlyValue(state.token_expires_at);
    const authorizationServer =
      state.discovery?.authorizationServerMetadata?.issuer ??
      state.discovery?.authorizationServerUrl ??
      issuer ??
      null;
    return {
      type: "oauth",
      status: state.authorization_url
        ? "authorization_pending"
        : tokens
          ? "connected"
          : "disconnected",
      server_id: serverId,
      scope_mode: config.scope_mode ?? "explicit",
      scopes_requested: [...config.scopes],
      scopes_granted: tokens?.scope
        ? tokens.scope.split(/\s+/).filter(Boolean)
        : [],
      authorization_server: authorizationServer,
      authorization_url: state.authorization_url ?? null,
      token_expires_at: expiresAt ?? null,
    };
  }

  async disconnect(serverId: string) {
    await this.store.delete(serverId);
  }

  async verifyStoredCredentialEncryption() {
    return this.store.verifyEncryption();
  }
}
