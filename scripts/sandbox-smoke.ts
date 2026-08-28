import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSettings } from "../src/config.js";
import { Container } from "../src/container.js";

const root = await mkdtemp(join(tmpdir(), "omoikane-sandbox-smoke-"));
const settings = getSettings({
  AGENT_DATABASE_URL: "pglite://:memory:",
  AGENT_ARTIFACT_ROOT: join(root, "artifacts"),
  AGENT_SKILL_ROOT: join(root, "skills"),
  AGENT_SANDBOX_ROOT: join(root, "sandboxes"),
  AGENT_CREDENTIAL_SECRET: "sandbox-test-secret",
  OMOIKANE_SANDBOX_PROVIDER: "docker",
});
const container = await Container.create(settings, { startWorker: false });
const handle = await container.sandbox.create({
  runId: "sandbox-smoke",
  networkEnabled: false,
  timeoutSeconds: 30,
  image: "node:22-alpine",
});
try {
  const skill = await container.skills.importBundle([
    {
      path: "SKILL.md",
      content_base64: Buffer.from(
        `---
name: Docker smoke Skill
slug: docker-smoke
omoikane:
  schema_version: 1
  workspace: required
  requires:
    tools: [sandbox_exec]
    commands: [node]
    network: false
  entrypoints:
    run:
      command: [node, .omoikane/skills/docker-smoke/scripts/run.mjs]
---

# Docker smoke

Run only through the explicitly bound Sandbox Tool.
`,
      ).toString("base64"),
    },
    {
      path: "input.txt",
      content_base64: Buffer.from("sandbox Skill input").toString("base64"),
    },
    {
      path: "scripts/run.mjs",
      content_base64: Buffer.from(
        "import fs from 'node:fs'; console.log(fs.readFileSync('.omoikane/skills/docker-smoke/input.txt','utf8')); console.log(process.getuid?.());\n",
      ).toString("base64"),
    },
  ]);
  const bindings = await container.skills.prepareForRun(
    [{ version_id: skill.version.id }],
    {
      toolNames: new Set(["sandbox_exec"]),
      sandboxConfig: { enabled: true, network_enabled: false },
      sandbox: handle,
      sandboxService: container.sandbox,
    },
  );
  const result = await container.sandbox.execute(handle, "node", [
    ".omoikane/skills/docker-smoke/scripts/run.mjs",
  ]);
  process.stdout.write(
    `${JSON.stringify(
      { provider: handle.provider, skill: bindings[0], ...result },
      null,
      2,
    )}\n`,
  );
  if (
    result.exit_code !== 0 ||
    !result.stdout.includes("sandbox Skill input") ||
    result.stdout.trim().endsWith("0") ||
    bindings[0]?.workspace !== ".omoikane/skills/docker-smoke"
  )
    process.exitCode = 1;
} finally {
  await container.sandbox.destroy(handle);
  await container.close();
  await rm(root, { recursive: true, force: true });
}
