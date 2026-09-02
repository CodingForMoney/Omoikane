import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import {
  McpServerCreateSchema,
  ToolCreateSchema,
  type McpServerInput,
  type McpServerUpdate,
  type ProviderConnection,
  type ProviderConnectionCreate,
  type ResourceRecord,
  type ToolCreate,
} from "./contracts.js";
import { OmoikaneClient, OmoikaneError } from "./client/index.js";

const alias = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/);
const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const providerManifestSchema = z
  .object({
    name: z.string().trim().min(1).max(512),
    provider: z.string().trim().min(1).max(256),
    endpoint_profile: z.string().trim().min(1).max(256).optional(),
    custom_base_url: z.string().url().optional(),
    custom_protocol: z
      .enum(["responses", "chat_completions", "anthropic", "google_gemini"])
      .optional(),
    api_key_env: environmentName,
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const fileReferenceSchema = z.string().trim().min(1).max(16_384);
const agentManifestSchema = z.union([
  fileReferenceSchema,
  z
    .object({
      path: fileReferenceSchema,
      provider: alias.optional(),
      tools: z.array(alias).max(10_000).optional(),
      skills: z.array(alias).max(10_000).optional(),
      mcpServers: z.array(alias).max(10_000).optional(),
      overrides: z.record(z.string(), z.unknown()).optional(),
      compilation_settings: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
]);
export const RuntimeDeploymentManifestSchema = z
  .object({
    apiVersion: z.literal("omoikane.io/v1"),
    kind: z.literal("RuntimeDeployment"),
    project: z.string().trim().min(1).max(256),
    providers: z.record(alias, providerManifestSchema).optional(),
    resources: z
      .object({
        tools: z.record(alias, fileReferenceSchema).optional(),
        mcpServers: z.record(alias, fileReferenceSchema).optional(),
        skills: z.record(alias, fileReferenceSchema).optional(),
        agents: z.record(alias, agentManifestSchema),
      })
      .strict(),
  })
  .strict();

export type RuntimeDeploymentManifest = z.infer<
  typeof RuntimeDeploymentManifestSchema
>;
export type ApplyAction = "created" | "updated" | "reused";
export interface AppliedResource {
  id: string;
  action: ApplyAction;
}
export interface ApplyRuntimeDeploymentResult {
  project: string;
  providers: Record<string, AppliedResource>;
  tools: Record<string, AppliedResource>;
  mcpServers: Record<string, AppliedResource>;
  skills: Record<string, AppliedResource>;
  agents: Record<string, AppliedResource & { config_hash: string }>;
}

export interface ApplyRuntimeDeploymentOptions {
  /** Defaults to true. Tests and disconnected preparation may opt out. */
  syncProviderModels?: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current &&
      typeof current === "object" &&
      !Array.isArray(current)
        ? deepMerge(
            current as Record<string, unknown>,
            value as Record<string, unknown>,
          )
        : value;
  }
  return result;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

async function readStructuredFile<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const source = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = YAML.parse(source);
  } catch (error) {
    throw new Error(`cannot parse ${path}: ${String(error)}`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success)
    throw new Error(
      `invalid resource file ${path}: ${z.prettifyError(result.error)}`,
    );
  return result.data;
}

async function allPages<T>(
  read: (cursor?: string) => Promise<{ data: T[]; next_cursor: string | null }>,
): Promise<T[]> {
  const data: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    data.push(...page.data);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return data;
}

function assertProviderMatches(
  current: ProviderConnection,
  desired: z.infer<typeof providerManifestSchema>,
) {
  const mismatches: string[] = [];
  if (current.provider !== desired.provider) mismatches.push("provider");
  if (
    desired.endpoint_profile !== undefined &&
    current.endpoint_profile !== desired.endpoint_profile
  )
    mismatches.push("endpoint_profile");
  if (
    desired.custom_base_url !== undefined &&
    current.base_url.replace(/\/$/, "") !==
      desired.custom_base_url.replace(/\/$/, "")
  )
    mismatches.push("custom_base_url");
  if (
    desired.custom_protocol !== undefined &&
    current.protocol !== desired.custom_protocol
  )
    mismatches.push("custom_protocol");
  if (String(current.api_key_env ?? "") !== desired.api_key_env)
    mismatches.push("api_key_env");
  if (
    desired.settings !== undefined &&
    canonical(current.settings) !== canonical(desired.settings)
  )
    mismatches.push("settings");
  if (mismatches.length)
    throw new Error(
      `Provider Connection ${desired.name} already exists but differs in ${mismatches.join(", ")}; change its manifest name or update it deliberately`,
    );
}

function assertReferences(
  resource: string,
  names: string[] | undefined,
  records: Record<string, unknown>,
) {
  for (const name of names ?? [])
    if (!records[name])
      throw new Error(`${resource} references unknown manifest alias: ${name}`);
}

/** Load and strictly validate a local declarative Runtime deployment. */
export async function loadRuntimeDeploymentManifest(
  path = "omoikane.yaml",
): Promise<{
  path: string;
  root: string;
  manifest: RuntimeDeploymentManifest;
}> {
  const absolutePath = resolve(path);
  const raw = await readFile(absolutePath, "utf8");
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    throw new Error(`cannot parse ${absolutePath}: ${String(error)}`);
  }
  const result = RuntimeDeploymentManifestSchema.safeParse(parsed);
  if (!result.success)
    throw new Error(
      `invalid RuntimeDeployment ${absolutePath}: ${z.prettifyError(result.error)}`,
    );
  return {
    path: absolutePath,
    root: dirname(absolutePath),
    manifest: result.data,
  };
}

/**
 * Apply one local project to a running Runtime. Immutable Tools and Providers
 * are reused only when their execution-relevant configuration matches.
 */
export async function applyRuntimeDeployment(
  client: OmoikaneClient,
  manifestPath = "omoikane.yaml",
  options: ApplyRuntimeDeploymentOptions = {},
): Promise<ApplyRuntimeDeploymentResult> {
  const { root, manifest } = await loadRuntimeDeploymentManifest(manifestPath);
  await client.handshake();
  const output: ApplyRuntimeDeploymentResult = {
    project: manifest.project,
    providers: {},
    tools: {},
    mcpServers: {},
    skills: {},
    agents: {},
  };

  const providers = await allPages<ProviderConnection>((cursor) =>
    client.listProviders({ limit: 1000, cursor }),
  );
  for (const [name, desired] of Object.entries(manifest.providers ?? {})) {
    const matchingName = providers.filter((item) => item.name === desired.name);
    if (matchingName.length > 1)
      throw new Error(
        `multiple Provider Connections are named ${desired.name}`,
      );
    let record = matchingName[0];
    let action: ApplyAction = "reused";
    if (record) assertProviderMatches(record, desired);
    else {
      record = await client.createProvider(
        desired as ProviderConnectionCreate,
        { syncModels: options.syncProviderModels !== false },
      );
      providers.push(record);
      action = "created";
    }
    output.providers[name] = { id: record.id, action };
  }

  const tools = await allPages<ResourceRecord>((cursor) =>
    client.listTools({ limit: 1000, cursor }),
  );
  for (const [name, relativePath] of Object.entries(
    manifest.resources.tools ?? {},
  )) {
    const desired = await readStructuredFile<ToolCreate>(
      resolve(root, relativePath),
      ToolCreateSchema,
    );
    let record = tools.find((item) => item.slug === desired.slug);
    let action: ApplyAction = "reused";
    if (record) {
      const current = asRecord(record);
      const fields = {
        slug: current.slug,
        name: current.name,
        description: current.description,
        kind: current.kind,
        implementation_key: current.implementation_key,
        schema: current.schema,
        policy: current.policy,
      };
      const expected = {
        ...desired,
        kind: desired.kind ?? "function",
        schema: desired.schema ?? {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        policy: {
          ...(desired.policy ?? {}),
          requires_approval: Boolean(
            desired.policy?.requires_approval || desired.policy?.side_effecting,
          ),
          side_effecting: Boolean(desired.policy?.side_effecting),
        },
      };
      if (canonical(fields) !== canonical(expected))
        throw new Error(
          `Function Tool ${desired.slug} already exists with a different immutable definition`,
        );
    } else {
      record = await client.createTool(desired);
      tools.push(record);
      action = "created";
    }
    output.tools[name] = { id: record.id, action };
  }

  for (const [name, relativePath] of Object.entries(
    manifest.resources.mcpServers ?? {},
  )) {
    const desired = await readStructuredFile<McpServerInput>(
      resolve(root, relativePath),
      McpServerCreateSchema,
    );
    const raw = desired as Record<string, unknown>;
    const slug = String(raw.slug ?? asRecord(raw.metadata).slug ?? "");
    let record: ResourceRecord;
    let action: ApplyAction;
    try {
      const existing = await client.getMcpServer(slug);
      const update = (
        raw.metadata ? { ...raw, kind: "McpServer" } : desired
      ) as McpServerUpdate;
      record = await client.updateMcpServer(existing.id, update);
      action = "updated";
    } catch (error) {
      if (!(error instanceof OmoikaneError) || error.status !== 404)
        throw error;
      record = await client.createMcpServer(desired);
      action = "created";
    }
    output.mcpServers[name] = { id: record.id, action };
  }

  for (const [name, relativePath] of Object.entries(
    manifest.resources.skills ?? {},
  )) {
    const imported = await client.importSkill({
      path: resolve(root, relativePath),
    });
    output.skills[name] = {
      id: imported.version.id,
      action: imported.reused === true ? "reused" : "created",
    };
  }

  const deployments = await allPages<ResourceRecord>((cursor) =>
    client.listDeployments({ limit: 1000, cursor }),
  );
  for (const [name, value] of Object.entries(manifest.resources.agents)) {
    const entry = typeof value === "string" ? { path: value } : value;
    assertReferences(`Agent ${name}`, entry.tools, output.tools);
    assertReferences(`Agent ${name}`, entry.skills, output.skills);
    assertReferences(`Agent ${name}`, entry.mcpServers, output.mcpServers);
    if (entry.provider && !output.providers[entry.provider])
      throw new Error(
        `Agent ${name} references unknown manifest alias: ${entry.provider}`,
      );
    const bindings: Record<string, unknown> = {
      ...(entry.provider
        ? { provider: { connection_id: output.providers[entry.provider]!.id } }
        : {}),
      ...(entry.tools
        ? { tools: entry.tools.map((item) => output.tools[item]!.id) }
        : {}),
      ...(entry.skills
        ? { skills: entry.skills.map((item) => output.skills[item]!.id) }
        : {}),
      ...(entry.mcpServers
        ? {
            mcp_servers: entry.mcpServers.map(
              (item) => output.mcpServers[item]!.id,
            ),
          }
        : {}),
    };
    const overrides = deepMerge(entry.overrides ?? {}, bindings);
    const document = await readFile(resolve(root, entry.path), "utf8");
    const compiled = await client.validateAgentDefinition({
      document,
      overrides,
      compilation_settings: entry.compilation_settings ?? {},
    });
    const existing = deployments.find(
      (item) => String(item.config_hash) === compiled.config_hash,
    );
    const deployment =
      existing ??
      (await client.deployDefinition(document, {
        overrides,
        compilation_settings: entry.compilation_settings ?? {},
      }));
    if (!existing) deployments.push(deployment);
    output.agents[name] = {
      id: deployment.id,
      config_hash: compiled.config_hash,
      action: existing ? "reused" : "created",
    };
  }
  return output;
}
