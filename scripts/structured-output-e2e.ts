import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { Container } from "../src/container.js";
import { getSettings } from "../src/config.js";

interface Target {
  name: string;
  provider: string;
  profile?: string;
  model: string;
  apiKeyEnv: string;
  expectedMode: "native" | "prompt";
}

const schema = {
  type: "object",
  properties: {
    provider: { type: "string" },
    status: { type: "string" },
  },
  required: ["provider", "status"],
  additionalProperties: false,
};

async function loadCodexBridgeKey() {
  if (process.env.CODEX_BRIDGE_API_KEY) return;
  try {
    const stored = JSON.parse(
      await readFile(join(homedir(), ".cb", "config.json"), "utf8"),
    ) as { apiKey?: unknown };
    if (typeof stored.apiKey === "string" && stored.apiKey)
      process.env.CODEX_BRIDGE_API_KEY = stored.apiKey;
  } catch {
    // Codex Bridge is optional. The test reports a skip without revealing paths or keys.
  }
}

await loadCodexBridgeKey();

const targets: Target[] = [
  {
    name: "MiMo Token Plan CN",
    provider: "xiaomi_mimo",
    profile: "token_plan_cn",
    model: "mimo-v2.5",
    apiKeyEnv: "MIMO_API_KEY",
    expectedMode: "prompt",
  },
  {
    name: "Codex Bridge",
    provider: "codex_bridge",
    profile: "loopback",
    model: "gpt-5.6-sol",
    apiKeyEnv: "CODEX_BRIDGE_API_KEY",
    expectedMode: "native",
  },
];

const results: Array<Record<string, unknown>> = [];
for (const target of targets) {
  if (!process.env[target.apiKeyEnv]) {
    results.push({
      provider: target.provider,
      status: "skipped_no_credential",
    });
    continue;
  }

  const root = await mkdtemp(join(tmpdir(), "omoikane-structured-e2e-"));
  const container = await Container.create(
    getSettings({
      ...process.env,
      AGENT_DATABASE_URL: "pglite://:memory:",
      AGENT_ARTIFACT_ROOT: join(root, "artifacts"),
      AGENT_SKILL_ROOT: join(root, "skills"),
      AGENT_SANDBOX_ROOT: join(root, "sandboxes"),
      AGENT_CREDENTIAL_SECRET: "structured-e2e-local-credential-secret",
      AGENT_TRACING_DISABLED: "true",
    }),
    { startWorker: false },
  );

  try {
    const connection = await container.providers.create({
      name: target.name,
      provider: target.provider,
      endpoint_profile: target.profile,
      api_key_env: target.apiKeyEnv,
      ...(target.provider === "codex_bridge" &&
      process.env.CODEX_BRIDGE_BASE_URL
        ? { custom_base_url: process.env.CODEX_BRIDGE_BASE_URL }
        : {}),
    });
    const validation = await container.providers.validate(connection.id);
    if (!validation.valid)
      throw new Error(`${target.name} validation failed: ${validation.error}`);

    const models = await container.providers.listModels(connection.id);
    const selected = models.find((item) => item.model_id === target.model);
    const mode = (selected?.capabilities as { structured_output?: unknown })
      ?.structured_output;
    if (mode !== target.expectedMode)
      throw new Error(
        `${target.name} expected structured output mode ${target.expectedMode}, received ${String(mode)}`,
      );

    const deployment = await container.definitions.deploy({
      config: {
        name: `${target.name} structured output E2E`,
        instructions: "Follow the structured output contract exactly.",
        provider: { connection_id: connection.id },
        model: target.model,
        model_settings: { max_tokens: 8192, reasoning_effort: "none" },
        output_schema: schema,
        compaction: { enabled: false },
      },
    });
    const created = await container.runner.create({
      deploymentId: deployment.id,
      input: `Return provider=${JSON.stringify(target.provider)} and status=${JSON.stringify("ok")}.`,
      limits: { max_turns: 6, max_duration_seconds: 180 },
    });
    await container.runner.processNext();
    const run = await container.runner.publicRun(created.id);
    if (run.status !== "completed")
      throw new Error(
        `${target.name} run failed: ${JSON.stringify(run.error_json)}`,
      );
    const output = run.output as { provider?: unknown; status?: unknown };
    if (output.provider !== target.provider || output.status !== "ok")
      throw new Error(`${target.name} returned unexpected validated values`);
    const completed = (await container.events.list(run.id)).find(
      (event) => event.type === "run.completed",
    );
    if (
      completed?.payload_json.structured_output_validated !== true ||
      completed.payload_json.structured_output_mode !== target.expectedMode
    )
      throw new Error(`${target.name} completion event was not validated`);

    results.push({
      provider: target.provider,
      model: target.model,
      mode: target.expectedMode,
      status: "passed",
      model_count: validation.model_count,
    });
  } finally {
    await container.close();
    await rm(root, { recursive: true, force: true });
  }
}

if (!results.some((result) => result.status === "passed"))
  throw new Error("no structured-output live target was available");

process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
