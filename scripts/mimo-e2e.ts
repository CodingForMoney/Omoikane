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
    AGENT_DATABASE_URL: "pglite://:memory:",
    AGENT_ARTIFACT_ROOT: join(root, "artifacts"),
    AGENT_SKILL_ROOT: join(root, "skills"),
    AGENT_SANDBOX_ROOT: join(root, "sandboxes"),
    AGENT_CREDENTIAL_SECRET: "mimo-e2e-local-credential-secret",
    AGENT_TRACING_DISABLED: "true",
  }),
  { startWorker: false },
);
try {
  const connection = await container.providers.create({
    name: "MiMo Token Plan CN",
    provider: "xiaomi_mimo",
    endpoint_profile: "token_plan_cn",
    api_key_env: "MIMO_API_KEY",
  });
  const validation = await container.providers.validate(connection.id);
  if (!validation.valid) throw new Error(String(validation.error));
  const deployment = await container.definitions.deploy({
    config: {
      name: "MiMo E2E",
      instructions:
        "Answer concisely. Return one sentence confirming the runtime works.",
      provider: { connection_id: connection.id },
      model: "mimo-v2.5",
      model_settings: { max_tokens: 1024, reasoning_effort: "none" },
      compaction: { enabled: false },
    },
  });
  const created = await container.runner.create({
    deploymentId: deployment.id,
    externalSessionId: "mimo-smoke-session",
    input: "Confirm that this Omoikane TypeScript runtime call succeeded.",
    limits: { max_turns: 3, max_duration_seconds: 180 },
  });
  await container.runner.processNext();
  const run = await container.runner.publicRun(created.id);
  if (run.status !== "completed") {
    throw new Error(`MiMo run failed: ${JSON.stringify(run.error_json)}`);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        provider_valid: true,
        model_count: validation.model_count,
        run_status: run.status,
        output: run.output,
        new_item_count: (run.new_items as unknown[]).length,
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
