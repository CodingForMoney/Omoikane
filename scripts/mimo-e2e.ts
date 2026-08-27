import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container } from "../src/container.js";
import { getSettings } from "../src/config.js";

if (!process.env.MIMO_API_KEY) {
  throw new Error("MIMO_API_KEY is required for this opt-in integration test");
}
const root = await mkdtemp(join(tmpdir(), "omoikane-mimo-e2e-"));
const container = await Container.create(
  getSettings({
    ...process.env,
    AGENT_ENVIRONMENT: "test",
    AGENT_DATABASE_URL: "pglite://:memory:",
    AGENT_ARTIFACT_ROOT: join(root, "artifacts"),
    AGENT_SKILL_ROOT: join(root, "skills"),
    AGENT_SANDBOX_ROOT: join(root, "sandboxes"),
    AGENT_RUN_STATE_SECRET: "mimo-e2e-local-state-secret",
    AGENT_EMBEDDED_WORKER: "false",
    AGENT_TRACING_DISABLED: "true",
  }),
  { startWorker: false },
);
try {
  const connection = await container.providers.create("e2e", {
    name: "MiMo Token Plan CN",
    provider: "xiaomi_mimo",
    endpoint_profile: "token_plan_cn",
    api_key_env: "MIMO_API_KEY",
  });
  const validation = await container.providers.validate("e2e", connection.id);
  if (!validation.valid) throw new Error(String(validation.error));
  const agent = await container.definitions.createAgent("e2e", {
    slug: "mimo-e2e",
    name: "MiMo E2E",
  });
  const draft = await container.definitions.createVersion("e2e", agent.id, {
    name: "MiMo E2E",
    instructions:
      "Answer concisely. Return one sentence confirming the runtime works.",
    provider: { connection_id: connection.id },
    model: "mimo-v2.5",
    model_settings: { max_tokens: 1024, reasoning_effort: "none" },
    memory: { enabled: false, write_mode: "disabled" },
    compaction: { enabled: false },
    tracing: { enabled: false },
  });
  const version = await container.definitions.publish("e2e", agent.id, 1);
  const session = await container.sessions.create("e2e", {
    agent_version_id: version.id,
  });
  const created = await container.runner.create({
    tenantId: "e2e",
    agentVersionId: version.id,
    sessionId: session.id,
    input: "Confirm that this Omoikane TypeScript runtime call succeeded.",
    limits: { max_turns: 3, max_duration_seconds: 180 },
  });
  await container.runner.processNext();
  const run = await container.runner.get("e2e", created.id);
  if (run.status !== "completed") {
    throw new Error(`MiMo run failed: ${JSON.stringify(run.error_json)}`);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        provider_valid: true,
        model_count: validation.model_count,
        run_status: run.status,
        output: run.output_json,
        message_count: (await container.sessions.rawItems(session.id)).length,
        events: (await container.events.list(run.id)).map(
          (event) => event.type,
        ),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await container.close();
  await rm(root, { recursive: true, force: true });
}
