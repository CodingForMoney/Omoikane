import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "omoikane-live-e2e",
  version: "1.0.0",
});

server.registerTool(
  "mcp_echo",
  {
    description: "Return a deterministic marker for the supplied value",
    inputSchema: { value: z.string() },
  },
  async ({ value }) => ({
    content: [{ type: "text", text: `MCP_ECHO_OK:${value}` }],
  }),
);

server.registerTool(
  "mcp_approval_action",
  {
    description: "Return a value after Runtime approval",
    inputSchema: { value: z.string() },
  },
  async ({ value }) => ({
    content: [{ type: "text", text: `MCP_APPROVED:${value}` }],
  }),
);

server.registerTool(
  "mcp_slow",
  {
    description: "Wait before returning",
    inputSchema: { delay_ms: z.number().int().nonnegative() },
  },
  async ({ delay_ms }) => {
    await new Promise((resolve) => setTimeout(resolve, delay_ms));
    return { content: [{ type: "text", text: "MCP_SLOW_OK" }] };
  },
);

server.registerTool(
  "mcp_large",
  {
    description: "Return a string with the requested byte length",
    inputSchema: { bytes: z.number().int().positive() },
  },
  async ({ bytes }) => ({
    content: [{ type: "text", text: "x".repeat(bytes) }],
  }),
);

server.registerTool(
  "mcp_secret_probe",
  {
    description: "Confirm a secret was injected without returning it",
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: "text",
        text: process.env.MCP_TEST_SECRET ? "SECRET_PRESENT" : "SECRET_MISSING",
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
