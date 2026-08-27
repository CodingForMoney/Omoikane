import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@openai/agents";
import { Container } from "../src/container.js";
import { getSettings } from "../src/config.js";

export async function testContainer() {
  const root = await mkdtemp(join(tmpdir(), "omoikane-test-"));
  const settings = getSettings({
    AGENT_ENVIRONMENT: "test",
    AGENT_DATABASE_URL: "pglite://:memory:",
    AGENT_ARTIFACT_ROOT: join(root, "artifacts"),
    AGENT_SKILL_ROOT: join(root, "skills"),
    AGENT_SANDBOX_ROOT: join(root, "sandboxes"),
    AGENT_RUN_STATE_SECRET: "test-secret-with-sufficient-entropy",
    AGENT_TRACING_DISABLED: "true",
    AGENT_EMBEDDED_WORKER: "false",
    AGENT_AUTO_MIGRATE: "true",
  });
  const container = await Container.create(settings, { startWorker: false });
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
    outputSchema?: Record<string, unknown>;
    compaction?: Record<string, unknown>;
    modelContextWindow?: number;
  } = {},
) {
  const tenantId = "test";
  const provider = options.provider ?? "xiaomi_mimo";
  const modelId = options.modelId ?? "mimo-v2.5";
  const connection = await container.providers.create(tenantId, {
    name: "Test provider",
    provider,
    api_key: "test-only-key",
  });
  const agent = await container.definitions.createAgent(tenantId, {
    slug: `test-agent-${crypto.randomUUID().slice(0, 8)}`,
    name: "Test agent",
  });
  const version = await container.definitions.createVersion(
    tenantId,
    agent.id,
    {
      name: "Test agent",
      instructions: "Answer the user accurately.",
      provider: { connection_id: connection.id },
      model: modelId,
      ...(options.modelContextWindow
        ? { model_context_window: options.modelContextWindow }
        : {}),
      model_settings: {},
      tools: options.tools ?? [],
      output_schema: options.outputSchema,
      memory: { enabled: false, write_mode: "disabled" },
      compaction: options.compaction ?? { enabled: false },
      tracing: { enabled: false },
    },
  );
  const published = await container.definitions.publish(
    tenantId,
    agent.id,
    Number(version.version),
  );
  if (options.model) {
    container.providers.modelFor = async () => options.model!;
  }
  return { tenantId, connection, agent, version: published };
}
