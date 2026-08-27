import { readFile } from "node:fs/promises";
import YAML from "yaml";
import type { Database } from "./database.js";
import { ConflictError, ValidationError } from "./database.js";
import { ResourceStore } from "./resources.js";
import { hashJson } from "./serialization.js";

export interface AgentDocument extends Record<string, unknown> {
  apiVersion?: string;
  kind?: string;
  metadata?: { slug?: string; name?: string; description?: string };
  spec?: Record<string, unknown>;
  instructions?: string;
}

const defaultSettings = {
  global_instructions: "",
  defaults: {
    model_settings: {},
    runtime_policy: { max_turns: 20, max_tool_calls: 50, max_handoffs: 20 },
    memory: {
      enabled: true,
      read_scopes: ["agent", "global"],
      max_retrieved_items: 8,
      write_mode: "candidates",
    },
    compaction: {
      enabled: true,
      high_watermark_ratio: 0.82,
      low_watermark_ratio: 0.55,
      preserve_recent_tokens: 16_000,
    },
    tracing: { enabled: true },
    sandbox: { enabled: false },
  },
  policy: {
    max_turns: 100,
    max_tool_calls: 200,
    max_handoffs: 50,
    max_duration_seconds: 7200,
    allow_provider_override: false,
  },
  revision: 1,
  defaults_revision: 1,
  policy_revision: 1,
  updated_by: "system",
};

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
  constructor(private readonly db: Database) {
    this.store = new ResourceStore(db);
  }

  async settings(tenantId: string) {
    const existing = await this.store.findBySlug<Record<string, unknown>>(
      tenantId,
      "agent_settings",
      "global",
    );
    if (existing) return existing;
    return this.store.create({
      tenantId,
      kind: "agent_settings",
      slug: "global",
      name: "Global agent settings",
      data: defaultSettings,
    });
  }

  async updateSettings(
    tenantId: string,
    input: Record<string, unknown>,
    actorId: string,
  ) {
    const current = await this.settings(tenantId);
    const revision = Number(current.revision ?? 1) + 1;
    return this.store.update(tenantId, "agent_settings", current.id, {
      data: {
        ...(input.global_instructions !== undefined
          ? { global_instructions: String(input.global_instructions) }
          : {}),
        ...(input.defaults
          ? {
              defaults: deepMerge(
                current.defaults as Record<string, unknown>,
                input.defaults as Record<string, unknown>,
              ),
              defaults_revision: Number(current.defaults_revision) + 1,
            }
          : {}),
        ...(input.policy
          ? {
              policy: deepMerge(
                current.policy as Record<string, unknown>,
                input.policy as Record<string, unknown>,
              ),
              policy_revision: Number(current.policy_revision) + 1,
            }
          : {}),
        revision,
        updated_by: actorId,
      },
    });
  }

  validate(document: AgentDocument): AgentDocument {
    const spec = (document.spec ?? {}) as Record<string, unknown>;
    const metadata = document.metadata ?? {};
    if ((document.apiVersion ?? "agentsdk/v1") !== "agentsdk/v1")
      throw new ValidationError("unsupported agent apiVersion");
    if ((document.kind ?? "Agent") !== "Agent")
      throw new ValidationError("kind must be Agent");
    if (!document.instructions?.trim())
      throw new ValidationError("agent instructions are required");
    if (metadata.slug && !/^[a-z0-9][a-z0-9_-]{1,127}$/.test(metadata.slug))
      throw new ValidationError("invalid agent slug");
    if (spec.reasoning_effort !== undefined)
      throw new ValidationError("reasoning_effort belongs in model_settings");
    return {
      apiVersion: "agentsdk/v1",
      kind: "Agent",
      metadata,
      spec,
      instructions: document.instructions.trim(),
    };
  }

  async compile(
    tenantId: string,
    document: AgentDocument,
    overrides: Record<string, unknown> = {},
  ) {
    const validated = this.validate(document);
    const settings = await this.settings(tenantId);
    const spec = validated.spec ?? {};
    const instructions = [settings.global_instructions, validated.instructions]
      .filter(Boolean)
      .join("\n\n");
    let config = deepMerge(settings.defaults as Record<string, unknown>, spec);
    config = deepMerge(config, overrides);
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
      global_defaults_revision: Number(settings.defaults_revision),
      platform_policy_revision: Number(settings.policy_revision),
    };
  }

  async createAgent(
    tenantId: string,
    input: { slug: string; name: string; description?: string },
  ) {
    if (!/^[a-z0-9][a-z0-9_-]{1,127}$/.test(input.slug))
      throw new ValidationError("invalid agent slug");
    return this.store.create({
      tenantId,
      kind: "agent",
      slug: input.slug,
      name: input.name,
      data: { description: input.description ?? "" },
    });
  }

  async listAgents(tenantId: string) {
    return this.store.list(tenantId, "agent");
  }
  async getAgent(tenantId: string, id: string) {
    return this.store.get(tenantId, "agent", id);
  }

  async createVersion(
    tenantId: string,
    agentId: string,
    config: Record<string, unknown>,
    definition?: AgentDocument,
    overrides: Record<string, unknown> = {},
  ) {
    await this.getAgent(tenantId, agentId);
    const versions = await this.store.list<Record<string, unknown>>(
      tenantId,
      "agent_version",
      { parentId: agentId },
    );
    const version =
      Math.max(0, ...versions.map((item) => Number(item.version))) + 1;
    const compiled = definition
      ? await this.compile(tenantId, definition, overrides)
      : {
          config,
          config_hash: hashJson(config),
          document: {},
          global_defaults_revision: 0,
          platform_policy_revision: 0,
        };
    return this.store.create({
      tenantId,
      kind: "agent_version",
      parentId: agentId,
      name: `v${version}`,
      status: "draft",
      data: {
        version,
        config: compiled.config,
        config_hash: compiled.config_hash,
        definition_format: definition ? "agent_markdown" : "legacy_json",
        definition_source: definition?.instructions ?? null,
        definition_json: compiled.document,
        overrides,
        global_defaults_revision: compiled.global_defaults_revision,
        platform_policy_revision: compiled.platform_policy_revision,
        published_at: null,
      },
    });
  }

  async createFromDefinition(
    tenantId: string,
    document: AgentDocument,
    overrides: Record<string, unknown> = {},
  ) {
    const validated = this.validate(document);
    const metadata = validated.metadata ?? {};
    if (!metadata.slug || !metadata.name)
      throw new ValidationError("metadata.slug and metadata.name are required");
    let agent = await this.store.findBySlug(tenantId, "agent", metadata.slug);
    if (!agent)
      agent = await this.createAgent(tenantId, {
        slug: metadata.slug,
        name: metadata.name,
        description: metadata.description,
      });
    const version = await this.createVersion(
      tenantId,
      agent.id,
      {},
      validated,
      overrides,
    );
    return { agent, version };
  }

  async version(tenantId: string, id: string) {
    return this.store.get<Record<string, unknown>>(
      tenantId,
      "agent_version",
      id,
    );
  }
  async versions(tenantId: string, agentId: string) {
    await this.getAgent(tenantId, agentId);
    return this.store.list(tenantId, "agent_version", { parentId: agentId });
  }
  async publish(tenantId: string, agentId: string, versionNumber: number) {
    const version = (await this.versions(tenantId, agentId)).find(
      (item) => Number(item.version) === versionNumber,
    );
    if (!version) throw new ValidationError("agent version not found");
    return this.store.update(tenantId, "agent_version", version.id, {
      status: "published",
      data: { published_at: new Date().toISOString() },
    });
  }

  async readDocument(path: string) {
    return this.validate(parseAgentMarkdown(await readFile(path, "utf8")));
  }
}
