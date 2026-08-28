#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import YAML from "yaml";
import { OmoikaneClient } from "../client/index.js";
import { parseAgentMarkdown } from "../agent-definitions.js";
import { OMOIKANE_VERSION } from "../runtime-versions.js";
import { configuredCredentialSecret, getSettings } from "../config.js";
import {
  createPgliteBackup,
  defaultBackupPath,
  restorePgliteBackup,
  verifyBackup,
} from "../backup.js";
import { safeUpgrade } from "../upgrade.js";
import type { BackupVerification } from "../backup.js";
import type { UpgradeResult } from "../upgrade.js";

const program = new Command()
  .name("omoikane")
  .description("Omoikane TypeScript Agent Runtime CLI")
  .version(OMOIKANE_VERSION);
const client = (options: { url?: string }) =>
  new OmoikaneClient({
    baseUrl: options.url ?? process.env.OMOIKANE_URL ?? "http://127.0.0.1:8000",
  });
const backupSummary = (result: BackupVerification) => ({
  path: result.path,
  format: `${result.manifest.format}/v${result.manifest.format_version}`,
  created_at: result.manifest.created_at,
  migration_version: result.manifest.migration.current_version,
  files_verified: result.files_verified,
  bytes_verified: result.bytes_verified,
});
const upgradeSummary = (result: UpgradeResult) => ({
  ...result,
  backup: result.backup ? backupSummary(result.backup) : undefined,
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
        kind: "RuntimeDeployment",
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
  .action(async (path, options) => {
    const document = await readFile(resolve(path), "utf8");
    const result = await client(options).deployDefinition(document);
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
  .requiredOption("--deployment <id>")
  .requiredOption("--input <text>")
  .option("--external-session <id>")
  .option("--url <url>")
  .action(async (options) => {
    const runtime = client(options);
    const created = await runtime.createRun({
      deployment_id: options.deployment,
      input: options.input,
      external_session_id: options.externalSession,
    });
    const runId = String(created.id);
    for await (const event of runtime.streamRun(runId))
      process.stdout.write(`${JSON.stringify(event)}\n`);
    const run = await runtime.getRun(runId);
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  });
program
  .command("backup")
  .description("Create and verify an offline PGlite snapshot")
  .argument("[target]", "new snapshot directory")
  .action(async (target) => {
    const settings = getSettings();
    const result = await createPgliteBackup(
      settings,
      target ? resolve(target) : defaultBackupPath(settings),
    );
    process.stdout.write(`${JSON.stringify(backupSummary(result), null, 2)}\n`);
  });
program
  .command("backup-verify")
  .description("Verify a snapshot manifest and all file checksums")
  .argument("<snapshot>")
  .action(async (snapshot) => {
    const result = await verifyBackup(resolve(snapshot));
    process.stdout.write(`${JSON.stringify(backupSummary(result), null, 2)}\n`);
  });
program
  .command("restore")
  .description(
    "Restore a verified PGlite snapshot into an empty data directory",
  )
  .argument("<snapshot>")
  .argument("<dataDirectory>")
  .action(async (snapshot, dataDirectory) => {
    const result = await restorePgliteBackup(
      resolve(snapshot),
      resolve(dataDirectory),
      { externalCredentialSecret: configuredCredentialSecret() },
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });
program
  .command("upgrade")
  .description("Preflight and safely upgrade the offline Runtime database")
  .option("--check", "perform read-only compatibility checks")
  .option("--backup <path>", "PGlite pre-upgrade snapshot path")
  .option(
    "--postgres-backup <path>",
    "existing non-empty pg_dump file required for PostgreSQL upgrades",
  )
  .action(async (options) => {
    const result = await safeUpgrade(getSettings(), {
      checkOnly: Boolean(options.check),
      backupPath: options.backup ? resolve(options.backup) : undefined,
      postgresBackupPath: options.postgresBackup
        ? resolve(options.postgresBackup)
        : undefined,
    });
    process.stdout.write(
      `${JSON.stringify(upgradeSummary(result), null, 2)}\n`,
    );
  });
program
  .command("serve")
  .description("Start the Runtime API and embedded workers")
  .action(async () => {
    await import("./runtime.js");
  });
program
  .command("migrate")
  .description("Alias for the safe upgrade workflow")
  .action(async () => {
    const result = await safeUpgrade(getSettings());
    process.stdout.write(
      `${JSON.stringify(upgradeSummary(result), null, 2)}\n`,
    );
  });
await program.parseAsync();
