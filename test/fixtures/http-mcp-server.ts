import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const mode = process.env.MCP_HTTP_MODE ?? "streamable_http";
const port = Number(process.env.MCP_HTTP_PORT ?? 0);

const makeServer = () => {
  const server = new McpServer({ name: "http-test-mcp", version: "1.0.0" });
  server.registerTool(
    "http_echo",
    { description: "Echo over HTTP MCP", inputSchema: { value: z.string() } },
    async ({ value }) => ({
      content: [{ type: "text", text: `HTTP_ECHO:${value}` }],
    }),
  );
  return server;
};

const readJson = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
};

const streamable = new Map<string, StreamableHTTPServerTransport>();
const sse = new Map<string, SSEServerTransport>();
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (mode === "streamable_http" && url.pathname === "/mcp") {
      const body = request.method === "POST" ? await readJson(request) : undefined;
      const sessionId = request.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? streamable.get(sessionId) : undefined;
      if (!transport && request.method === "POST" && isInitializeRequest(body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            streamable.set(id, transport!);
          },
        });
        transport.onclose = () => {
          if (transport?.sessionId) streamable.delete(transport.sessionId);
        };
        await makeServer().connect(transport);
      }
      if (!transport) {
        response.writeHead(400).end("missing MCP session");
        return;
      }
      await transport.handleRequest(request, response, body);
      return;
    }
    if (mode === "sse" && request.method === "GET" && url.pathname === "/sse") {
      const transport = new SSEServerTransport("/messages", response);
      sse.set(transport.sessionId, transport);
      transport.onclose = () => sse.delete(transport.sessionId);
      await makeServer().connect(transport);
      return;
    }
    if (mode === "sse" && request.method === "POST" && url.pathname === "/messages") {
      const transport = sse.get(String(url.searchParams.get("sessionId") ?? ""));
      if (!transport) {
        response.writeHead(404).end("unknown MCP session");
        return;
      }
      await transport.handlePostMessage(request, response, await readJson(request));
      return;
    }
    response.writeHead(404).end("not found");
  } catch (error) {
    response.writeHead(500).end(error instanceof Error ? error.message : String(error));
  }
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  process.stdout.write(`${address.port}\n`);
});

const shutdown = async () => {
  for (const transport of [...streamable.values(), ...sse.values()])
    await transport.close().catch(() => undefined);
  server.close(() => process.exit(0));
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
