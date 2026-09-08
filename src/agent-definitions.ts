import { readFile } from "node:fs/promises";
import YAML from "yaml";
import type { Database } from "./database.js";
import { ValidationError } from "./database.js";
import { ResourceStore } from "./resources.js";
import { hashJson } from "./serialization.js";
import type { SkillService } from "./skills.js";
import type { ToolService } from "./tools.js";
import { validateOutputSchemaDefinition } from "./structured-output.js";
import { normalizeGuardrailConfiguration } from "./guardrails.js";
import type { PageOptions } from "./pagination.js";

export interface AgentDocument extends Record<string, unknown> {
  apiVersion?: string;
  kind?: string;
  metadata?: { slug?: string; name?: string; description?: string };
  spec?: Record<string, unknown>;
  instructions?: string;
}

const defaultCompilationSettings = {
  global_instructions: "",
  defaults: {
    model_settings: {},
    runtime_policy: { max_turns: 20, max_tool_calls: 50, max_handoffs: 20 },
    compaction: {
      enabled: true,
      strategy: "auto",
      high_watermark_ratio: 0.82,
      low_watermark_ratio: 0.55,
      preserve_recent_tokens: 16_000,
    },
    sandbox: { enabled: false },
  },
  policy: {
    max_turns: 100,
    max_tool_calls: 200,
    max_handoffs: 50,
    max_duration_seconds: 7200,
    allow_provider_override: false,
  },
};

function assertUsageOnlyConfiguration(
  value: Record<string, unknown>,
  location: string,
) {
  if (Object.hasOwn(value, "pricing"))
    throw new ValidationError(
      `${location}.pricing is not supported; Provider billing belongs to the Provider or business system`,
    );
  if (Object.hasOwn(value, "max_cost_usd"))
    throw new ValidationError(
      `${location}.max_cost_usd is not supported; use token Usage and Provider-side financial limits`,
    );
  const runtimePolicy = value.runtime_policy as
    Record<string, unknown> | undefined;
  if (runtimePolicy && Object.hasOwn(runtimePolicy, "max_cost_usd"))
    throw new ValidationError(
      `${location}.runtime_policy.max_cost_usd is not supported; use token Usage and Provider-side financial limits`,
    );
}

function assertNoAgentTracing(
  value: Record<string, unknown>,
  location: string,
) {
  if (Object.hasOwn(value, "tracing"))
    throw new ValidationError(
      `${location}.tracing is not supported; tracing is configured once for the Runtime with OMOIKANE_TRACING_EXPORTER`,
    );
}

function assertMcpReferences(value: unknown) {
  if (value === undefined) return;
  if (!Array.isArray(value))
    throw new ValidationError("spec.mcp_servers must be an array");
  for (const [index, reference] of value.entries()) {
    if (typeof reference === "string") {
      if (!reference.trim())
        throw new ValidationError(`spec.mcp_servers[${index}] is empty`);
      continue;
    }
    if (!reference || typeof reference !== "object" || Array.isArray(reference))
      throw new ValidationError(
        `spec.mcp_servers[${index}] must be a server ID or reference object`,
      );
    const record = reference as Record<string, unknown>;
    const unknown = Object.keys(record).filter(
      (key) => !["server_id", "id", "slug", "policy_override"].includes(key),
    );
    if (unknown.length)
      throw new ValidationError(
        `spec.mcp_servers[${index}] contains unsupported fields: ${unknown.join(", ")}`,
      );
    if (!record.server_id && !record.id && !record.slug)
      throw new ValidationError(
        `spec.mcp_servers[${index}] requires server_id`,
      );
  }
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else result[key] = value;
  }
  return result;
}

export function parseAgentMarkdown(source: string): AgentDocument {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return {
      apiVersion: "agentsdk/v1",
      kind: "Agent",
      instructions: normalized.trim(),
      spec: {},
    };
  }
  const boundary = normalized.indexOf("\n---\n", 4);
  if (boundary < 0)
    throw new ValidationError("AGENT.md front matter is not closed");
  const frontMatter = YAML.parse(
    normalized.slice(4, boundary),
  ) as AgentDocument;
  return {
    ...frontMatter,
    instructions: normalized.slice(boundary + 5).trim(),
  };
}

export class AgentDefinitionService {
  private readonly store: ResourceStore;
  constructor(
    private readonly db: Database,
    private readonly skills: SkillService,
    private readonly tools: ToolService,
  ) {
    this.store = new ResourceStore(db);
  }

  private async validateSkillBindings(config: Record<string, unknown>) {
    if (config.skills === undefined) return;
    if (!Array.isArray(config.tools ?? []))
      throw new ValidationError("tools must be an array");
    const tools = await this.tools.resolve((config.tools ?? []) as unknown[]);
    await this.skills.validateBindings(config.skills, {
      toolNames: new Set(tools.map((tool) => String(tool.name))),
      sandboxConfig: (config.sandbox ?? {}) as Record<string, unknown>,
    });
  }

  validate(document: AgentDocument): AgentDocument {
    const spec = { ...((document.spec ?? {}) as Record<string, unknown>) };
    const metadata = document.metadata ?? {};
    if ((document.apiVersion ?? "agentsdk/v1") !== "agentsdk/v1")
      throw new ValidationError("unsupported agent apiVersion");
    if ((document.kind ?? "Agent") !== "Agent")
      throw new ValidationError("kind must be Agent");
    if (!document.instructions?.trim())
      throw new ValidationError("agent instructions are required");
    if (metadata.slug && !/^[a-z0-9][a-z0-9_-]{1,127}$/.test(metadata.slug))
      throw new ValidationError("invalid agent slug");
    for (const field of [
      "reasoning_effort",
      "reasoning_enabled",
      "reasoning_budget_tokens",
      "reasoning_summary",
    ])
      if (spec[field] !== undefined)
        throw new ValidationError(`${field} belongs in model_settings`);
    if (Object.hasOwn(spec, "memory"))
      throw new ValidationError(
        "memory is not supported by the Runtime; provide business context through Run context, Function Tools, or MCP",
      );
    validateOutputSchemaDefinition(spec.output_schema);
    assertMcpReferences(spec.mcp_servers);
    assertUsageOnlyConfiguration(spec, "spec");
    assertNoAgentTracing(spec, "spec");
    if (spec.guardrails !== undefined)
      spec.guardrails = normalizeGuardrailConfiguration(spec.guardrails);
    return {
      apiVersion: "agentsdk/v1",
      kind: "Agent",
      metadata,
      spec,
      instructions: document.instructions.trim(),
    };
  }

  async compile(
    document: AgentDocument,
    overrides: Record<string, unknown> = {},
    compilationSettings: Record<string, unknown> = {},
  ) {
    if (Object.hasOwn(overrides, "memory"))
      throw new ValidationError("memory cannot be supplied as an override");
    assertUsageOnlyConfiguration(overrides, "overrides");
    assertNoAgentTracing(overrides, "overrides");
    const validated = this.validate(document);
    const settings = deepMerge(
      defaultCompilationSettings as Record<string, unknown>,
      compilationSettings,
    );
    const defaults = (settings.defaults ?? {}) as Record<string, unknown>;
    if (Object.hasOwn(defaults, "memory"))
      throw new ValidationError("memory is not a Runtime setting");
    assertUsageOnlyConfiguration(defaults, "compilation_settings.defaults");
    assertNoAgentTracing(defaults, "compilation_settings.defaults");
    assertUsageOnlyConfiguration(
      (settings.policy ?? {}) as Record<string, unknown>,
      "compilation_settings.policy",
    );
    const spec = validated.spec ?? {};
    const instructions = [settings.global_instructions, validated.instructions]
      .filter(Boolean)
      .join("\n\n");
    let config = deepMerge(defaults, spec);
    config = deepMerge(config, overrides);
    assertMcpReferences(config.mcp_servers);
    validateOutputSchemaDefinition(config.output_schema);
    if (config.guardrails !== undefined)
      config.guardrails = normalizeGuardrailConfiguration(config.guardrails);
    config.instructions = instructions;
    config.name =
      validated.metadata?.name ?? validated.metadata?.slug ?? "Agent";
    config.description = validated.metadata?.description ?? "";
    config.definition = {
      format: "agent_markdown",
      api_version: "agentsdk/v1",
    };
    const runtime = (config.runtime_policy ?? {}) as Record<string, unknown>;
    const policy = settings.policy as Record<string, unknown>;
    for (const key of [
      "max_turns",
      "max_tool_calls",
      "max_handoffs",
      "max_duration_seconds",
    ] as const) {
      if (runtime[key] !== undefined && policy[key] !== undefined)
        runtime[key] = Math.min(Number(runtime[key]), Number(policy[key]));
    }
    config.runtime_policy = runtime;
    return {
      config,
      config_hash: hashJson(config),
      document: validated,
    };
  }

  async deploy(input: {
    document?: AgentDocument;
    config?: Record<string, unknown>;
    overrides?: Record<string, unknown>;
    compilationSettings?: Record<string, unknown>;
    source?: string;
  }) {
    const overrides = input.overrides ?? {};
    if (!input.document && !input.config)
      throw new ValidationError("document or config is required");
    if (input.config && Object.hasOwn(input.config, "memory"))
      throw new ValidationError("memory is not supported in Agent deployments");
    if (input.config)
      assertUsageOnlyConfiguration(input.config, "deployment.config");
    if (input.config) assertNoAgentTracing(input.config, "deployment.config");
    if (input.config) assertMcpReferences(input.config.mcp_servers);
    if (input.config)
      validateOutputSchemaDefinition(input.config.output_schema);
    const normalizedConfig = input.config
      ? {
          ...input.config,
          ...(input.config.guardrails === undefined
            ? {}
            : {
                guardrails: normalizeGuardrailConfiguration(
                  input.config.guardrails,
                ),
              }),
        }
      : undefined;
    const compiled = input.document
      ? await this.compile(input.document, overrides, input.compilationSettings)
      : {
          config: normalizedConfig!,
          config_hash: hashJson(normalizedConfig),
          document: {},
        };
    const deploymentConfig = compiled.config as Record<string, unknown>;
    await this.validateSkillBindings(deploymentConfig);
    const metadata = input.document?.metadata ?? {};
    return this.store.create({
      kind: "agent_deployment",
      name: metadata.name ?? String(deploymentConfig.name ?? "Agent"),
      status: "active",
      data: {
        config: deploymentConfig,
        config_hash: compiled.config_hash,
        definition_format: input.document ? "agent_markdown" : "json",
        definition_source: input.source ?? null,
        definition_json: compiled.document,
        overrides,
        deployed_at: new Date().toISOString(),
      },
    });
  }

  async listDeployments() {
    return this.store.list("agent_deployment");
  }

  async pageDeployments(options: PageOptions & { status?: string } = {}) {
    return this.store.page("agent_deployment", options);
  }

  async deployment(id: string) {
    return this.store.get<Record<string, unknown>>("agent_deployment", id);
  }

  async readDocument(path: string) {
    return this.validate(parseAgentMarkdown(await readFile(path, "utf8")));
  }
}
