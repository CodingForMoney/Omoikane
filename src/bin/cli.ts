#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import YAML from "yaml";
import { OmoikaneClient } from "../client/index.js";
import { parseAgentMarkdown } from "../agent-definitions.js";
import { OMOIKANE_VERSION } from "../runtime-versions.js";

const program = new Command()
  .name("omoikane")
  .description("Omoikane TypeScript Agent Runtime CLI")
  .version(OMOIKANE_VERSION);
const client = (options: { url?: string }) =>
  new OmoikaneClient({
    baseUrl: options.url ?? process.env.OMOIKANE_URL ?? "http://127.0.0.1:8000",
    tenantId: process.env.OMOIKANE_TENANT_ID,
    actorId: process.env.OMOIKANE_ACTOR_ID ?? "omoikane-cli",
  });
program
  .command("init")
  .argument("[directory]", "project directory", ".")
  .action(async (directory) => {
    const root = resolve(directory);
    await mkdir(resolve(root, "agents", "assistant"), { recursive: true });
    await mkdir(resolve(root, "skills"), { recursive: true });
    await writeFile(
      resolve(root, "omoikane.yaml"),
      YAML.stringify({
        apiVersion: "omoikane.io/v1",
        kind: "ProjectRelease",
        project: "my-agent-project",
        resources: {
          agents: { assistant: "agents/assistant/AGENT.md" },
          skills: {},
          mcpServers: {},
          schemas: {},
        },
      }),
      { flag: "wx" },
    ).catch(() => {});
    await writeFile(
      resolve(root, "agents", "assistant", "AGENT.md"),
      `---\napiVersion: agentsdk/v1\nkind: Agent\nmetadata:\n  slug: assistant\n  name: Assistant\nspec:\n  provider:\n    connection_id: replace-me\n  model: replace-me\n---\n\nYou are a helpful assistant.\n`,
      { flag: "wx" },
    ).catch(() => {});
    process.stdout.write(`Initialized ${root}\n`);
  });
program
  .command("validate")
  .argument("<agentFile>")
  .action(async (path) => {
    const document = parseAgentMarkdown(await readFile(resolve(path), "utf8"));
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  });
program
  .command("deploy-agent")
  .argument("<agentFile>")
  .option("--url <url>")
  .option("--draft")
  .action(async (path, options) => {
    const document = await readFile(resolve(path), "utf8");
    const result = await client(options).createAgentFromDefinition(
      document,
      !options.draft,
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });
program
  .command("provider-add")
  .requiredOption("--name <name>")
  .requiredOption("--provider <provider>")
  .option("--api-key <key>")
  .option("--api-key-env <name>")
  .option("--profile <profile>")
  .option("--url <runtimeUrl>")
  .option("--base-url <providerUrl>")
  .option("--protocol <protocol>")
  .action(async (options) => {
    const result = await client(options).createProvider({
      name: options.name,
      provider: options.provider,
      api_key: options.apiKey,
      api_key_env: options.apiKeyEnv,
      endpoint_profile: options.profile,
      custom_base_url: options.baseUrl,
      custom_protocol: options.protocol,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });
program
  .command("run")
  .requiredOption("--agent-version <id>")
  .requiredOption("--input <text>")
  .option("--session <id>")
  .option("--url <url>")
  .action(async (options) => {
    const runtime = client(options);
    const created = await runtime.createRun({
      agent_version_id: options.agentVersion,
      input: options.input,
      session_id: options.session,
    });
    const runId = String(created.id);
    for await (const event of runtime.streamRun(runId))
      process.stdout.write(`${JSON.stringify(event)}\n`);
    const run = await runtime.getRun(runId);
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  });
program
  .command("serve")
  .description("Start the Runtime API and embedded workers")
  .action(async () => {
    await import("./runtime.js");
  });
program
  .command("migrate")
  .description("Apply database migrations")
  .action(async () => {
    await import("./migrate.js");
  });
await program.parseAsync();
