import {
  Agent,
  MCPServerSSE,
  MCPServerStdio,
  MCPServerStreamableHttp,
  type JsonSchemaDefinition,
  type MCPServer,
} from "@openai/agents";
import type { Database } from "./database.js";
import { ValidationError } from "./database.js";
import type { ProviderService } from "./providers.js";
import { ResourceStore } from "./resources.js";
import type { SkillService } from "./skills.js";
import type { RuntimeContext, ToolService } from "./tools.js";

export interface BuiltAgent {
  agent: Agent<RuntimeContext, any>;
  config: Record<string, unknown>;
  close(): Promise<void>;
}

export class AgentFactory {
  private readonly store: ResourceStore;

  constructor(
    private readonly db: Database,
    private readonly providers: ProviderService,
    private readonly tools: ToolService,
    private readonly skills: SkillService,
  ) {
    this.store = new ResourceStore(db);
  }

  async mcpServer(tenantId: string, reference: unknown): Promise<MCPServer> {
    const id =
      typeof reference === "string"
        ? reference
        : String(
            (reference as Record<string, unknown>).id ??
              (reference as Record<string, unknown>).slug,
          );
    const servers = await this.store.list<Record<string, unknown>>(
      tenantId,
      "mcp_server",
    );
    const record = servers.find((item) => item.id === id || item.slug === id);
    if (!record) throw new ValidationError(`MCP server not found: ${id}`);
    const endpoint = {
      ...((record.endpoint_config ?? {}) as Record<string, unknown>),
    };
    const references = (record.secret_refs ?? {}) as Record<string, string>;
    for (const [key, environmentName] of Object.entries(references)) {
      const value = process.env[environmentName];
      if (!value)
        throw new ValidationError(
          `MCP secret environment variable is missing: ${environmentName}`,
        );
      endpoint[key] = value;
    }
    const name = String(record.name);
    if (record.transport === "stdio") {
      const inherited = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      return new MCPServerStdio({
        name,
        command: String(endpoint.command),
        args: Array.isArray(endpoint.args) ? endpoint.args.map(String) : [],
        cwd: endpoint.cwd ? String(endpoint.cwd) : undefined,
        env: {
          ...inherited,
          ...((endpoint.env ?? {}) as Record<string, string>),
        },
      });
    }
    const options = {
      name,
      url: String(endpoint.url),
      requestInit: endpoint.headers ? { headers: endpoint.headers } : undefined,
    };
    return record.transport === "sse"
      ? new MCPServerSSE(options)
      : new MCPServerStreamableHttp(options);
  }

  async build(
    tenantId: string,
    agentVersionId: string,
    context: RuntimeContext,
    seen = new Set<string>(),
  ): Promise<BuiltAgent> {
    if (seen.has(agentVersionId))
      throw new ValidationError("agent handoff cycle detected");
    seen.add(agentVersionId);
    const version = await this.store.get<Record<string, unknown>>(
      tenantId,
      "agent_version",
      agentVersionId,
    );
    if (version.status !== "published")
      throw new ValidationError("run requires a published agent version");
    const config = await this.providers.resolveConfig(tenantId, {
      ...((version.config ?? {}) as Record<string, unknown>),
    });
    const model = await this.providers.modelFor(
      config._connection,
      config.model,
    );

    const skillInstructions: string[] = [];
    for (const reference of (config.skills ?? []) as unknown[]) {
      const id =
        typeof reference === "string"
          ? reference
          : String((reference as Record<string, unknown>).id);
      skillInstructions.push(await this.skills.instruction(tenantId, id));
    }
    const memories = (context.retrieved_memories ?? []) as Array<
      Record<string, unknown>
    >;
    const instructions = [
      String(config.instructions ?? ""),
      skillInstructions.length
        ? `<available_skills>\n${skillInstructions.join("\n\n")}\n</available_skills>`
        : "",
      memories.length
        ? `<retrieved_long_term_memory>\n${memories.map((memory) => `- ${memory.content}`).join("\n")}\n</retrieved_long_term_memory>`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const toolRecords = await this.tools.resolve(
      tenantId,
      (config.tools ?? []) as unknown[],
    );
    const mcpServers: MCPServer[] = [];
    for (const reference of (config.mcp_servers ?? []) as unknown[]) {
      const server = await this.mcpServer(tenantId, reference);
      await server.connect();
      mcpServers.push(server);
    }
    const handoffs: Agent<any, any>[] = [];
    const handoffClosers: Array<() => Promise<void>> = [];
    for (const reference of (config.handoffs ?? []) as unknown[]) {
      const id =
        typeof reference === "string"
          ? reference
          : String(
              (reference as Record<string, unknown>).agent_version_id ??
                (reference as Record<string, unknown>).id,
            );
      const child = await this.build(tenantId, id, context, new Set(seen));
      handoffs.push(child.agent);
      handoffClosers.push(child.close);
    }

    const outputSchema = config.output_schema as
      Record<string, unknown> | undefined;
    const outputType = outputSchema
      ? ({
          type: "json_schema",
          name: "agent_output",
          strict: true,
          schema: {
            ...outputSchema,
            type: "object",
            additionalProperties: false,
          },
        } as JsonSchemaDefinition)
      : undefined;
    const guardrails = config.guardrails as Record<string, unknown> | undefined;
    const inputPatterns = (
      (guardrails?.input_deny_patterns ?? []) as string[]
    ).map((value) => new RegExp(value, "i"));
    const outputPatterns = (
      (guardrails?.output_deny_patterns ?? []) as string[]
    ).map((value) => new RegExp(value, "i"));
    const agent = new Agent<RuntimeContext, any>({
      name: String(config.name ?? version.name ?? "Agent"),
      handoffDescription: String(config.description ?? ""),
      instructions,
      model,
      modelSettings: (config.model_settings ?? {}) as never,
      tools: toolRecords.map((record) => this.tools.build(record)),
      mcpServers,
      handoffs,
      outputType,
      inputGuardrails: inputPatterns.length
        ? [
            {
              name: "configured-input-policy",
              runInParallel: false,
              execute: async ({ input }) => {
                const value =
                  typeof input === "string" ? input : JSON.stringify(input);
                const match = inputPatterns.find((pattern) =>
                  pattern.test(value),
                );
                return {
                  tripwireTriggered: Boolean(match),
                  outputInfo: { matched: match?.source },
                };
              },
            },
          ]
        : [],
      outputGuardrails: outputPatterns.length
        ? [
            {
              name: "configured-output-policy",
              execute: async ({ agentOutput }) => {
                const value =
                  typeof agentOutput === "string"
                    ? agentOutput
                    : JSON.stringify(agentOutput);
                const match = outputPatterns.find((pattern) =>
                  pattern.test(value),
                );
                return {
                  tripwireTriggered: Boolean(match),
                  outputInfo: { matched: match?.source },
                };
              },
            },
          ]
        : [],
    });
    return {
      agent,
      config,
      close: async () => {
        await Promise.allSettled([
          ...mcpServers.map((server) => server.close()),
          ...handoffClosers.map((close) => close()),
        ]);
      },
    };
  }
}
