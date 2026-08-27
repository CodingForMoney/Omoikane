import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const databasePath = fileURLToPath(new URL("business.db", import.meta.url));
const database = new DatabaseSync(databasePath);
database.exec(`CREATE TABLE IF NOT EXISTS operations (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  result TEXT NOT NULL
)`);

const server = new McpServer({
  name: "example-business-tools",
  version: "1.0.0",
});

server.registerTool(
  "get_account_summary",
  {
    description: "Read a bounded business account summary",
    inputSchema: { account_id: z.string() },
  },
  async ({ account_id }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          account_id,
          status: "active",
          open_items: 0,
        }),
      },
    ],
  }),
);

server.registerTool(
  "create_review_request",
  {
    description: "Create a review request exactly once",
    inputSchema: {
      account_id: z.string(),
      reason: z.string(),
      idempotency_key: z.string().min(8),
    },
  },
  async ({ account_id, reason, idempotency_key }) => {
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ account_id, reason }))
      .digest("hex");
    const existing = database
      .prepare(
        "SELECT request_hash, result FROM operations WHERE idempotency_key = ?",
      )
      .get(idempotency_key) as
      { request_hash: string; result: string } | undefined;
    if (existing && existing.request_hash !== requestHash) {
      throw new Error("idempotency key was reused with different arguments");
    }
    const result = existing
      ? JSON.parse(existing.result)
      : {
          review_id: `review-${idempotency_key.slice(0, 12)}`,
          status: "created",
        };
    if (!existing) {
      database
        .prepare(
          "INSERT INTO operations(idempotency_key, request_hash, result) VALUES (?, ?, ?)",
        )
        .run(idempotency_key, requestHash, JSON.stringify(result));
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  },
);

await server.connect(new StdioServerTransport());
