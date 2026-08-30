import { Agent, type JsonSchemaDefinition, type Model } from "@openai/agents";
import type { Database } from "./database.js";
import { ValidationError } from "./database.js";
import type { ProviderService } from "./providers.js";
import { ResourceStore } from "./resources.js";
import type { SkillRuntimeBinding, SkillService } from "./skills.js";
import type { RuntimeContext, ToolService } from "./tools.js";
import type { McpService } from "./mcp.js";
import type { SandboxService } from "./sandbox.js";
import {
  promptStructuredOutputInstruction,
  type StructuredOutputContract,
  validateOutputSchemaDefinition,
} from "./structured-output.js";
import { withRuntimeModelRetry } from "./recovery.js";
import type { GuardrailService } from "./guardrails.js";

export interface BuiltAgent {
  agent: Agent<RuntimeContext, any>;
  config: Record<string, unknown>;
  skillBindings: SkillRuntimeBinding[];
  structuredOutput?: StructuredOutputContract;
  outputGuardrailsBuffered: boolean;
  close(): Promise<void>;
}

export interface AgentBuildOptions {
  modelDecorator?: (model: Model, config: Record<string, unknown>) => Model;
  persistMcpBindings?: boolean;
  includeGuardrails?: boolean;
}

export class AgentFactory {
  private readonly store: ResourceStore;

  constructor(
    private readonly db: Database,
    private readonly providers: ProviderService,
    private readonly tools: ToolService,
    private readonly skills: SkillService,
    private readonly mcp: McpService,
    private readonly sandbox: SandboxService,
    private readonly guardrails: GuardrailService,
  ) {
    this.store = new ResourceStore(db);
  }

  async build(
    deploymentId: string,
    context: RuntimeContext,
    seen = new Set<string>(),
    options: AgentBuildOptions = {},
  ): Promise<BuiltAgent> {
    if (seen.has(deploymentId))
      throw new ValidationError("agent handoff cycle detected");
    seen.add(deploymentId);
    const deployment = await this.store.get<Record<string, unknown>>(
      "agent_deployment",
      deploymentId,
    );
    if (deployment.status !== "active")
      throw new ValidationError("run requires an active Agent deployment");
    const config = await this.providers.resolveConfig({
      ...((deployment.config ?? {}) as Record<string, unknown>),
    });
    const providerModel = await this.providers.modelFor(
      config._connection,
      config.model,
    );
    const model = options.modelDecorator
      ? options.modelDecorator(providerModel, config)
      : providerModel;

    if (!Array.isArray(config.tools ?? []))
      throw new ValidationError("tools must be an array");
    const toolRecords = await this.tools.resolve(
      (config.tools ?? []) as unknown[],
    );
    const skillBindings = await this.skills.prepareForRun(config.skills ?? [], {
      toolNames: new Set(toolRecords.map((record) => String(record.name))),
      sandboxConfig: (config.sandbox ?? {}) as Record<string, unknown>,
      sandbox: context.sandbox,
      sandboxService: this.sandbox,
    });
    const skillInstructions = skillBindings.map((binding) => {
      const runtime = [
        binding.workspace
          ? `Workspace: ${binding.workspace}`
          : "Workspace: not materialized for this Run",
        Object.keys(binding.entrypoints).length
          ? `Declared entrypoints: ${JSON.stringify(binding.entrypoints)}`
          : "Declared entrypoints: none",
        "A Skill declares requirements but never grants Tool, Sandbox, or network privileges. Use only explicitly available Tools.",
      ].join("\n");
      return `<skill slug="${binding.slug}" version_id="${binding.version_id}">\n${runtime}\n\n${binding.instruction}\n</skill>`;
    });
    const toolNames = new Set<string>();
    for (const record of toolRecords) {
      const name = String(record.name);
      if (toolNames.has(name))
        throw new ValidationError(`duplicate Function Tool name: ${name}`);
      toolNames.add(name);
    }
    const mcp = await this.mcp.toolsForRun(
      (config.mcp_servers ?? []) as unknown[],
      context,
      toolNames,
      { persistBindings: options.persistMcpBindings ?? true },
    );
    const handoffs: Agent<any, any>[] = [];
    const handoffClosers: Array<() => Promise<void>> = [];
    const childSkillBindings: SkillRuntimeBinding[] = [];
    let childOutputGuardrailsBuffered = false;
    try {
      for (const reference of (config.handoffs ?? []) as unknown[]) {
        const id =
          typeof reference === "string"
            ? reference
            : String(
                (reference as Record<string, unknown>).deployment_id ??
                  (reference as Record<string, unknown>).id,
              );
        const child = await this.build(id, context, new Set(seen), options);
        handoffs.push(child.agent);
        handoffClosers.push(child.close);
        childSkillBindings.push(...child.skillBindings);
        childOutputGuardrailsBuffered ||= child.outputGuardrailsBuffered;
      }
    } catch (error) {
      await Promise.allSettled([
        mcp.close(),
        ...handoffClosers.map((close) => close()),
      ]);
      throw error;
    }

    const outputSchema = validateOutputSchemaDefinition(config.output_schema);
    const structuredOutput = outputSchema
      ? {
          mode:
            config._capabilities?.structured_output === "native"
              ? ("native" as const)
              : ("prompt" as const),
          schema: outputSchema,
        }
      : undefined;
    const instructions = [
      String(config.instructions ?? ""),
      skillInstructions.length
        ? `<available_skills>\n${skillInstructions.join("\n\n")}\n</available_skills>`
        : "",
      structuredOutput?.mode === "prompt"
        ? promptStructuredOutputInstruction(structuredOutput.schema)
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const outputType =
      structuredOutput?.mode === "native"
        ? ({
            type: "json_schema",
            name: "agent_output",
            strict: true,
            schema: structuredOutput.schema,
          } as JsonSchemaDefinition)
        : undefined;
    const guardrails =
      options.includeGuardrails === false
        ? {
            inputGuardrails: [],
            outputGuardrails: [],
            buffersOutput: false,
          }
        : this.guardrails.build(config.guardrails);
    const agent = new Agent<RuntimeContext, any>({
      name: String(config.name ?? deployment.name ?? "Agent"),
      handoffDescription: String(config.description ?? ""),
      instructions,
      model,
      modelSettings: withRuntimeModelRetry({
        ...((config.model_settings ?? {}) as Record<string, unknown>),
        preserveRawUsage: true,
      }) as never,
      tools: [
        ...toolRecords.map((record) => this.tools.build(record)),
        ...mcp.tools,
      ],
      handoffs,
      outputType,
      inputGuardrails: guardrails.inputGuardrails,
      outputGuardrails: guardrails.outputGuardrails,
    });
    return {
      agent,
      config,
      structuredOutput,
      outputGuardrailsBuffered:
        guardrails.buffersOutput || childOutputGuardrailsBuffered,
      skillBindings: [...skillBindings, ...childSkillBindings].filter(
        (binding, index, all) =>
          all.findIndex(
            (candidate) => candidate.version_id === binding.version_id,
          ) === index,
      ),
      close: async () => {
        await Promise.allSettled([
          mcp.close(),
          ...handoffClosers.map((close) => close()),
        ]);
      },
    };
  }
}
