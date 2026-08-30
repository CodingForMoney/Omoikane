import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Container } from "../src/container.js";
import { createApp } from "../src/api.js";
import { McpOAuthService } from "../src/mcp-oauth.js";
import { testContainer } from "./helpers.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const oauthFixture = fileURLToPath(
  new URL("./fixtures/oauth-mcp-server.ts", import.meta.url),
);

let container: Container | undefined;
let cleanup: (() => Promise<void>) | undefined;
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGTERM");
  await cleanup?.();
  container = undefined;
  cleanup = undefined;
});

async function startOAuthFixture(
  mode: "dynamic" | "confidential" | "metadata_url" = "dynamic",
) {
  const child = spawn(process.execPath, ["--import", "tsx", oauthFixture], {
    cwd: repositoryRoot,
    env: { ...process.env, MCP_OAUTH_PORT: "0", MCP_OAUTH_MODE: mode },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return new Promise<number>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(
      () => reject(new Error(`OAuth MCP fixture did not start: ${stderr}`)),
      5_000,
    );
    child.stdout!.on("data", (chunk) => {
      stdout += String(chunk);
      const line = stdout.split("\n")[0];
      if (/^\d+$/.test(line ?? "")) {
        clearTimeout(timeout);
        resolve(Number(line));
      }
    });
    child.stderr!.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`OAuth MCP fixture exited ${code}: ${stderr}`));
    });
  });
}

describe("MCP OAuth", () => {
  it("persists an encrypted authorization, refreshes after 401, and disconnects", async () => {
    const fixturePort = await startOAuthFixture();
    const fixtureBase = `http://127.0.0.1:${fixturePort}`;
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const app = await createApp(container);

    const created = await app.inject({
      method: "POST",
      url: "/v1/mcp-servers",
      payload: {
        slug: "oauth-fixture",
        name: "OAuth fixture",
        transport: "streamable_http",
        endpoint_config: { url: `${fixtureBase}/mcp` },
        auth: { type: "oauth", scopes: ["mcp.read"] },
      },
    });
    expect(created.statusCode).toBe(201);
    const serverId = created.json().id as string;
    expect(created.json().auth).toEqual({
      type: "oauth",
      scope_mode: "explicit",
      scopes: ["mcp.read"],
      write_scopes: ["mcp.write"],
      client_name: "Omoikane MCP Client",
      client_registration: "dynamic",
      token_endpoint_auth_method: "none",
    });

    const before = await app.inject({
      method: "GET",
      url: `/v1/mcp-servers/${serverId}/oauth/status`,
    });
    expect(before.json()).toMatchObject({ status: "disconnected" });

    const started = await app.inject({
      method: "POST",
      url: `/v1/mcp-servers/${serverId}/oauth/start`,
      payload: {},
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({
      status: "authorization_pending",
      scopes_requested: ["mcp.read"],
    });
    const authorizationUrl = started.json().authorization_url as string;
    expect(authorizationUrl).toContain("code_challenge_method=S256");

    const authorize = await fetch(authorizationUrl, { redirect: "manual" });
    expect(authorize.status).toBe(302);
    const redirect = new URL(authorize.headers.get("location")!);

    const rejected = await app.inject({
      method: "GET",
      url: `${redirect.pathname}?code=${encodeURIComponent(redirect.searchParams.get("code")!)}&state=wrong-state`,
    });
    expect(rejected.statusCode).toBe(422);

    const callback = await app.inject({
      method: "GET",
      url: `${redirect.pathname}${redirect.search}`,
    });
    expect(callback.statusCode).toBe(200);
    expect(callback.headers["cache-control"]).toBe("no-store");
    expect(callback.json()).toMatchObject({
      status: "connected",
      scopes_granted: ["mcp.read"],
      authorization_url: null,
    });

    const health = await container.mcp.health(serverId);
    expect(health).toMatchObject({
      status: "ok",
      tools: ["oauth_echo"],
    });

    await fetch(`${fixtureBase}/test/invalidate`, { method: "POST" });
    const refreshedHealth = await container.mcp.health(serverId);
    expect(refreshedHealth.status).toBe("ok");
    const stats = (await (await fetch(`${fixtureBase}/test/stats`)).json()) as {
      refresh_counter: number;
    };
    expect(stats.refresh_counter).toBe(1);

    await fetch(`${fixtureBase}/test/require-write`, { method: "POST" });
    await expect(container.mcp.health(serverId)).rejects.toThrow(
      "scopes not approved by configuration: mcp.write",
    );
    expect(await container.mcp.oauthStatus(serverId)).toMatchObject({
      status: "connected",
      scopes_requested: ["mcp.read"],
      authorization_url: null,
    });
    await fetch(`${fixtureBase}/test/allow-read`, { method: "POST" });

    const oauthRows = await container.db.query<{
      encrypted_state: Uint8Array;
      checksum: string;
    }>("SELECT encrypted_state,checksum FROM mcp_oauth_states");
    expect(oauthRows.rows).toHaveLength(1);
    const serializedRows = JSON.stringify(oauthRows.rows);
    expect(serializedRows).not.toContain("fixture-access");
    expect(serializedRows).not.toContain("fixture-refresh-token");
    expect(JSON.stringify(await container.mcp.get(serverId))).not.toContain(
      "fixture-access",
    );
    await expect(
      new McpOAuthService(
        container.db,
        "wrong-oauth-credential-key",
        "http://127.0.0.1:8000",
      ).verifyStoredCredentialEncryption(),
    ).rejects.toThrow();
    await expect(
      new McpOAuthService(
        container.db,
        container.settings.credentialSecret,
        "http://127.0.0.1:8000",
      ).verifyStoredCredentialEncryption(),
    ).resolves.toBe(1);

    const disconnected = await app.inject({
      method: "DELETE",
      url: `/v1/mcp-servers/${serverId}/oauth`,
    });
    expect(disconnected.statusCode).toBe(204);
    expect(await container.mcp.oauthStatus(serverId)).toMatchObject({
      status: "disconnected",
    });
    await expect(container.mcp.health(serverId)).rejects.toMatchObject({
      errorCode: "mcp_authorization_required",
    });
    expect(await container.mcp.oauthStatus(serverId)).toMatchObject({
      status: "disconnected",
      authorization_url: null,
    });
  }, 30_000);

  it("validates OAuth scope safety and prevents mixed bearer credentials", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;

    await expect(
      container.mcp.create({
        slug: "oauth-no-scopes",
        name: "OAuth no scopes",
        transport: "streamable_http",
        endpoint_config: { url: "https://example.com/mcp" },
        auth: { type: "oauth", scope_mode: "explicit", scopes: [] },
      }),
    ).rejects.toThrow("list at least one scope in explicit mode");

    await expect(
      container.mcp.create({
        slug: "oauth-auto-no-approval",
        name: "OAuth auto scopes without approval",
        transport: "streamable_http",
        endpoint_config: { url: "https://example.com/mcp" },
        auth: { type: "oauth" },
      }),
    ).rejects.toThrow(
      "automatic MCP OAuth scopes require policy.approval.mode=always",
    );

    await expect(
      container.mcp.create({
        slug: "oauth-mixed-auth",
        name: "OAuth mixed auth",
        transport: "streamable_http",
        endpoint_config: {
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer static" },
        },
        auth: { type: "oauth", scopes: ["mcp.read"] },
      }),
    ).rejects.toThrow("cannot be combined with an Authorization header");

    await expect(
      container.mcp.create({
        slug: "oauth-write-no-approval",
        name: "OAuth write without approval",
        transport: "streamable_http",
        endpoint_config: { url: "https://example.com/mcp" },
        auth: { type: "oauth", scopes: ["mcp.read", "mcp.write"] },
      }),
    ).rejects.toThrow(
      "write scope mcp.write requires policy.approval.mode=always",
    );

    await expect(
      container.mcp.create({
        slug: "oauth-provider-write-no-approval",
        name: "OAuth provider write without approval",
        transport: "streamable_http",
        endpoint_config: { url: "https://example.com/mcp" },
        auth: {
          type: "oauth",
          scopes: ["read", "order:write"],
          write_scopes: ["order:write"],
        },
      }),
    ).rejects.toThrow(
      "write scope order:write requires policy.approval.mode=always",
    );

    await expect(
      container.mcp.create({
        slug: "oauth-preregistered-no-secret",
        name: "OAuth confidential pre-registered without secret",
        transport: "streamable_http",
        endpoint_config: { url: "https://example.com/mcp" },
        auth: {
          type: "oauth",
          scopes: ["read"],
          client_registration: "pre_registered",
          token_endpoint_auth_method: "client_secret_basic",
          client_id_env: "MCP_CLIENT_ID",
        },
      }),
    ).rejects.toThrow(
      "confidential pre-registered MCP OAuth requires client_secret_env",
    );

    const preRegistered = await container.mcp.create({
      slug: "oauth-preregistered",
      name: "OAuth pre-registered",
      transport: "streamable_http",
      endpoint_config: { url: "https://example.com/mcp" },
      auth: {
        type: "oauth",
        scopes: ["read"],
        client_registration: "pre_registered",
        token_endpoint_auth_method: "client_secret_post",
        client_id_env: "MCP_CLIENT_ID",
        client_secret_env: "MCP_CLIENT_SECRET",
      },
    });
    expect(preRegistered.auth).toMatchObject({
      client_registration: "pre_registered",
      token_endpoint_auth_method: "client_secret_post",
      client_id_env: "MCP_CLIENT_ID",
      client_secret_env: "MCP_CLIENT_SECRET",
    });
  });

  it("discovers scopes automatically and supports confidential dynamic clients", async () => {
    const fixturePort = await startOAuthFixture("confidential");
    const fixtureBase = `http://127.0.0.1:${fixturePort}`;
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const app = await createApp(container);

    const created = await app.inject({
      method: "POST",
      url: "/v1/mcp-servers",
      payload: {
        slug: "oauth-confidential",
        name: "OAuth confidential fixture",
        transport: "streamable_http",
        endpoint_config: { url: `${fixtureBase}/mcp` },
        auth: {
          type: "oauth",
          token_endpoint_auth_method: "client_secret_basic",
        },
        policy: { approval: { mode: "always" } },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().auth).toMatchObject({
      scope_mode: "auto",
      scopes: [],
      client_registration: "dynamic",
      token_endpoint_auth_method: "client_secret_basic",
    });
    const serverId = created.json().id as string;

    const started = await app.inject({
      method: "POST",
      url: `/v1/mcp-servers/${serverId}/oauth/start`,
      payload: {},
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({
      scope_mode: "auto",
      scopes_requested: [],
      status: "authorization_pending",
    });
    const authorize = await fetch(started.json().authorization_url, {
      redirect: "manual",
    });
    const redirect = new URL(authorize.headers.get("location")!);
    const callback = await app.inject({
      method: "GET",
      url: `${redirect.pathname}${redirect.search}`,
    });
    expect(callback.statusCode).toBe(200);
    expect(callback.json()).toMatchObject({
      status: "connected",
      scope_mode: "auto",
      scopes_granted: ["mcp.read", "mcp.write"],
    });
    expect(await container.mcp.health(serverId)).toMatchObject({
      status: "ok",
      tools: ["oauth_echo"],
    });

    const oauthRows = await container.db.query<{
      encrypted_state: Uint8Array;
    }>("SELECT encrypted_state FROM mcp_oauth_states");
    expect(JSON.stringify(oauthRows.rows)).not.toContain(
      "fixture-client-secret",
    );
  }, 20_000);

  it("supports URL-based OAuth client metadata without dynamic registration", async () => {
    const fixturePort = await startOAuthFixture("metadata_url");
    const fixtureBase = `http://127.0.0.1:${fixturePort}`;
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const app = await createApp(container);

    const created = await app.inject({
      method: "POST",
      url: "/v1/mcp-servers",
      payload: {
        slug: "oauth-metadata-url",
        name: "OAuth URL metadata fixture",
        transport: "streamable_http",
        endpoint_config: { url: `${fixtureBase}/mcp` },
        auth: {
          type: "oauth",
          scopes: ["mcp.read"],
          client_registration: "metadata_url",
          client_metadata_url:
            "https://runtime.example/oauth/client-metadata.json",
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const serverId = created.json().id as string;

    const metadata = await app.inject({
      method: "GET",
      url: `/v1/mcp-servers/${serverId}/oauth/client-metadata`,
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toMatchObject({
      client_name: "Omoikane MCP Client",
      token_endpoint_auth_method: "none",
      scope: "mcp.read",
    });
    expect(metadata.json().redirect_uris[0]).toContain(
      `/v1/mcp-servers/${serverId}/oauth/callback`,
    );

    const started = await app.inject({
      method: "POST",
      url: `/v1/mcp-servers/${serverId}/oauth/start`,
      payload: {},
    });
    expect(started.statusCode).toBe(200);
    const authorizationUrl = new URL(started.json().authorization_url);
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "https://runtime.example/oauth/client-metadata.json",
    );
    const authorize = await fetch(authorizationUrl, { redirect: "manual" });
    const redirect = new URL(authorize.headers.get("location")!);
    const callback = await app.inject({
      method: "GET",
      url: `${redirect.pathname}${redirect.search}`,
    });
    expect(callback.statusCode).toBe(200);
    expect(callback.json()).toMatchObject({ status: "connected" });
  }, 20_000);
});
