import { spawn } from "node:child_process";
import pg from "pg";

const containerName = `omoikane-postgres-test-${process.pid}-${Date.now()}`;
const image = process.env.OMOIKANE_POSTGRES_TEST_IMAGE ?? "postgres:16-alpine";

const capture = (command: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });

const runInherited = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });

let started = false;
const cleanup = async () => {
  if (!started) return;
  started = false;
  await capture("docker", ["rm", "--force", containerName]).catch(() => {});
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

try {
  await capture("docker", [
    "run",
    "--detach",
    "--rm",
    "--name",
    containerName,
    "--publish",
    "127.0.0.1::5432",
    "--env",
    "POSTGRES_USER=postgres",
    "--env",
    "POSTGRES_PASSWORD=postgres",
    "--env",
    "POSTGRES_DB=postgres",
    image,
  ]);
  started = true;
  const mapping = await capture("docker", ["port", containerName, "5432/tcp"]);
  const port = Number(mapping.match(/:(\d+)\s*$/)?.[1]);
  if (!Number.isInteger(port))
    throw new Error(`could not determine PostgreSQL port from: ${mapping}`);
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    const pool = new pg.Pool({
      connectionString: url,
      connectionTimeoutMillis: 500,
    });
    try {
      await pool.query("SELECT 1");
      ready = true;
      await pool.end();
      break;
    } catch {
      await pool.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!ready) throw new Error("PostgreSQL test container did not become ready");
  const exitCode = await runInherited("npm", ["run", "test:postgres"], {
    ...process.env,
    AGENT_POSTGRES_TEST_URL: url,
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  await cleanup();
}
