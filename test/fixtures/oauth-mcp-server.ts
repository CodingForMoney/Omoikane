import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const port = Number(process.env.MCP_OAUTH_PORT ?? 0);
const oauthMode = String(process.env.MCP_OAUTH_MODE ?? "dynamic") as
  "dynamic" | "confidential" | "metadata_url";
const metadataClientId = "https://runtime.example/oauth/client-metadata.json";
const transports = new Map<string, StreamableHTTPServerTransport>();
const authorizationCodes = new Map<
  string,
  { challenge: string; redirectUri: string; scope: string }
>();
let registeredRedirectUri: string | undefined;
let accessToken = "fixture-access-0";
let accessCounter = 0;
let refreshCounter = 0;
let requireWrite = false;
const refreshToken = "fixture-refresh-token";

const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
};

const json = (
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
) => {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
};

const makeMcpServer = () => {
  const server = new McpServer({ name: "oauth-test-mcp", version: "1.0.0" });
  server.registerTool(
    "oauth_echo",
    {
      description: "Echo through an OAuth-protected MCP server",
      inputSchema: { value: z.string() },
    },
    async ({ value }) => ({
      content: [{ type: "text", text: `OAUTH_ECHO:${value}` }],
    }),
  );
  return server;
};

const server = createServer(async (request, response) => {
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("fixture address is unavailable");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const url = new URL(request.url ?? "/", baseUrl);

    if (
      request.method === "GET" &&
      [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
        "/mcp/.well-known/oauth-protected-resource",
      ].includes(url.pathname)
    ) {
      json(response, 200, {
        resource: `${baseUrl}/mcp`,
        authorization_servers: [baseUrl],
        scopes_supported: ["mcp.read", "mcp.write"],
      });
      return;
    }

    if (
      request.method === "GET" &&
      [
        "/.well-known/oauth-authorization-server",
        "/.well-known/openid-configuration",
      ].includes(url.pathname)
    ) {
      json(response, 200, {
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        ...(oauthMode === "metadata_url"
          ? { client_id_metadata_document_supported: true }
          : { registration_endpoint: `${baseUrl}/register` }),
        scopes_supported: ["mcp.read", "mcp.write"],
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: [
          oauthMode === "confidential" ? "client_secret_basic" : "none",
        ],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/register") {
      const metadata = JSON.parse(await readBody(request)) as {
        redirect_uris?: string[];
      };
      registeredRedirectUri = metadata.redirect_uris?.[0];
      if (!registeredRedirectUri) {
        json(response, 400, { error: "invalid_redirect_uri" });
        return;
      }
      json(response, 201, {
        ...metadata,
        client_id: "fixture-client",
        ...(oauthMode === "confidential"
          ? {
              client_secret: "fixture-client-secret",
              token_endpoint_auth_method: "client_secret_basic",
            }
          : { token_endpoint_auth_method: "none" }),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const challenge = url.searchParams.get("code_challenge") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const scope = url.searchParams.get("scope") ?? "";
      if (oauthMode === "metadata_url" && !registeredRedirectUri)
        registeredRedirectUri = redirectUri;
      if (
        url.searchParams.get("client_id") !==
          (oauthMode === "metadata_url"
            ? metadataClientId
            : "fixture-client") ||
        redirectUri !== registeredRedirectUri ||
        !challenge ||
        !state
      ) {
        json(response, 400, { error: "invalid_request" });
        return;
      }
      const code = randomUUID();
      authorizationCodes.set(code, { challenge, redirectUri, scope });
      const redirect = new URL(redirectUri);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", state);
      redirect.searchParams.set("iss", baseUrl);
      response.writeHead(302, { Location: redirect.toString() }).end();
      return;
    }

    if (request.method === "POST" && url.pathname === "/token") {
      const form = new URLSearchParams(await readBody(request));
      const authenticated =
        oauthMode === "confidential"
          ? request.headers.authorization ===
            `Basic ${Buffer.from("fixture-client:fixture-client-secret").toString("base64")}`
          : form.get("client_id") ===
            (oauthMode === "metadata_url"
              ? metadataClientId
              : "fixture-client");
      const grantType = form.get("grant_type");
      let scope = "mcp.read";
      if (grantType === "authorization_code") {
        const code = form.get("code") ?? "";
        const pending = authorizationCodes.get(code);
        const verifier = form.get("code_verifier") ?? "";
        const actualChallenge = createHash("sha256")
          .update(verifier)
          .digest("base64url");
        if (
          !pending ||
          pending.challenge !== actualChallenge ||
          pending.redirectUri !== form.get("redirect_uri") ||
          !authenticated
        ) {
          json(response, 400, { error: "invalid_grant" });
          return;
        }
        authorizationCodes.delete(code);
        scope = pending.scope;
      } else if (grantType === "refresh_token") {
        if (form.get("refresh_token") !== refreshToken || !authenticated) {
          json(response, 400, { error: "invalid_grant" });
          return;
        }
        refreshCounter += 1;
        scope = form.get("scope") ?? "mcp.read";
      } else {
        json(response, 400, { error: "unsupported_grant_type" });
        return;
      }
      accessCounter += 1;
      accessToken = `fixture-access-${accessCounter}`;
      json(response, 200, {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 2,
        refresh_token: refreshToken,
        scope,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/test/invalidate") {
      accessToken = `fixture-invalidated-${randomUUID()}`;
      response.writeHead(204).end();
      return;
    }

    if (request.method === "POST" && url.pathname === "/test/require-write") {
      requireWrite = true;
      response.writeHead(204).end();
      return;
    }

    if (request.method === "POST" && url.pathname === "/test/allow-read") {
      requireWrite = false;
      response.writeHead(204).end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/test/stats") {
      json(response, 200, {
        access_counter: accessCounter,
        refresh_counter: refreshCounter,
      });
      return;
    }

    if (url.pathname === "/mcp") {
      if (request.headers.authorization !== `Bearer ${accessToken}`) {
        response.writeHead(401, {
          "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", scope="mcp.read"`,
        });
        response.end("authorization required");
        return;
      }
      if (requireWrite) {
        response.writeHead(403, {
          "WWW-Authenticate": `Bearer error="insufficient_scope", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", scope="mcp.write"`,
        });
        response.end("write scope required");
        return;
      }
      const body =
        request.method === "POST"
          ? JSON.parse((await readBody(request)) || "null")
          : undefined;
      const sessionId = request.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;
      if (
        !transport &&
        request.method === "POST" &&
        isInitializeRequest(body)
      ) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            transports.set(id, transport!);
          },
        });
        transport.onclose = () => {
          if (transport?.sessionId) transports.delete(transport.sessionId);
        };
        await makeMcpServer().connect(transport);
      }
      if (!transport) {
        response.writeHead(400).end("missing MCP session");
        return;
      }
      await transport.handleRequest(request, response, body);
      return;
    }

    response.writeHead(404).end("not found");
  } catch (error) {
    response
      .writeHead(500)
      .end(error instanceof Error ? error.message : String(error));
  }
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing fixture address");
  process.stdout.write(`${address.port}\n`);
});

const shutdown = async () => {
  for (const transport of transports.values())
    await transport.close().catch(() => undefined);
  server.close(() => process.exit(0));
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
