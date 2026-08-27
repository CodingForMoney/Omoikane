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

await server.connect(new StdioServerTransport());
