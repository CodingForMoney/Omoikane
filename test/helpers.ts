import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@openai/agents";
import { Container } from "../src/container.js";
import { getSettings } from "../src/config.js";
import type { FaultInjector } from "../src/recovery.js";

export async function testContainer(
  options: {
    startWorker?: boolean;
    runConcurrency?: number;
    faultInjector?: FaultInjector;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "omoikane-test-"));
  const settings = getSettings({
    AGENT_DATABASE_URL: "pglite://:memory:",
    AGENT_ARTIFACT_ROOT: join(root, "artifacts"),
    AGENT_SKILL_ROOT: join(root, "skills"),
    AGENT_SANDBOX_ROOT: join(root, "sandboxes"),
    AGENT_CREDENTIAL_SECRET: "test-secret-with-sufficient-entropy",
    AGENT_TRACING_DISABLED: "true",
    AGENT_AUTO_MIGRATE: "true",
    OMOIKANE_RUN_CONCURRENCY: String(options.runConcurrency ?? 1),
    OMOIKANE_LOG_LEVEL: "silent",
    ...(options.env ?? {}),
  });
  const container = await Container.create(settings, {
    startWorker: options.startWorker ?? false,
    faultInjector: options.faultInjector,
  });
  return {
    container,
    async close() {
      await container.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function publishedAgent(
  container: Container,
  options: {
    model?: Model;
    provider?: string;
    modelId?: string;
    tools?: string[];
    skills?: unknown[];
    sandbox?: boolean | Record<string, unknown>;
    mcpServers?: unknown[];
    handoffs?: unknown[];
    outputSchema?: Record<string, unknown>;
    compaction?: Record<string, unknown>;
    modelContextWindow?: number;
    guardrails?: Record<string, unknown>;
  } = {},
) {
  const provider = options.provider ?? "xiaomi_mimo";
  const modelId = options.modelId ?? "mimo-v2.5";
  const connection = await container.providers.create({
    name: "Test provider",
    provider,
    api_key: "test-only-key",
  });
  const deployment = await container.definitions.deploy({
    config: {
      name: "Test agent",
      instructions: "Answer the user accurately.",
      provider: { connection_id: connection.id },
      model: modelId,
      ...(options.modelContextWindow
        ? { model_context_window: options.modelContextWindow }
        : {}),
      model_settings: {},
      tools: options.tools ?? [],
      skills: options.skills ?? [],
      mcp_servers: options.mcpServers ?? [],
      handoffs: options.handoffs ?? [],
      output_schema: options.outputSchema,
      compaction: options.compaction ?? { enabled: false },
      ...(options.guardrails ? { guardrails: options.guardrails } : {}),
      ...(options.sandbox
        ? {
            sandbox:
              options.sandbox === true
                ? { enabled: true }
                : { enabled: true, ...options.sandbox },
          }
        : {}),
    },
  });
  if (options.model) {
    container.providers.modelFor = async () => options.model!;
  }
  return { connection, agent: deployment, version: deployment };
}
