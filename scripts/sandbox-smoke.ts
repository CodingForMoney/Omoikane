import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSettings } from "../src/config.js";
import { SandboxService } from "../src/sandbox.js";

const root = await mkdtemp(join(tmpdir(), "omoikane-sandbox-smoke-"));
const settings = getSettings({
  AGENT_ENVIRONMENT: "test",
  AGENT_DATABASE_URL: "pglite://:memory:",
  AGENT_ARTIFACT_ROOT: join(root, "artifacts"),
  AGENT_SKILL_ROOT: join(root, "skills"),
  AGENT_SANDBOX_ROOT: join(root, "sandboxes"),
  AGENT_RUN_STATE_SECRET: "sandbox-test-secret",
});
const service = new SandboxService({
  ...settings,
  environment: "production",
  sandboxHostRoot: join(root, "sandboxes"),
});
const handle = await service.create({
  runId: "sandbox-smoke",
  networkEnabled: false,
  timeoutSeconds: 30,
  image: "node:22-alpine",
});
try {
  await service.write(handle, "input.txt", "sandbox input");
  const result = await service.execute(handle, "node", [
    "-e",
    "const fs=require('node:fs'); console.log(fs.readFileSync('input.txt','utf8')); console.log(process.getuid?.())",
  ]);
  process.stdout.write(
    `${JSON.stringify({ provider: handle.provider, ...result }, null, 2)}\n`,
  );
  if (
    result.exit_code !== 0 ||
    result.stdout.includes("sandbox input") === false ||
    result.stdout.trim().endsWith("0")
  )
    process.exitCode = 1;
} finally {
  await service.destroy(handle);
  await rm(root, { recursive: true, force: true });
}
