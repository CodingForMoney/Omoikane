import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { Container } from "../../src/container.js";
import { getSettings, type Settings } from "../../src/config.js";

const safeDatabaseName = () =>
  `omoikane_it_${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;

async function dropTestDatabase(admin: pg.Pool, databaseName: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const active = await admin.query<{ count: string }>(
      "SELECT count(*) count FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
      [databaseName],
    );
    if (Number(active.rows[0]?.count) === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
    [databaseName],
  );
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
}

export interface PostgresTestEnvironment {
  databaseUrl: string;
  settings: Settings;
  primary: Container;
  secondary: Container;
  pool: pg.Pool;
  closeRuntimeConnections(): Promise<void>;
  close(): Promise<void>;
}

export async function postgresTestEnvironment(): Promise<PostgresTestEnvironment> {
  const adminUrl = process.env.AGENT_POSTGRES_TEST_URL;
  if (!adminUrl)
    throw new Error(
      "AGENT_POSTGRES_TEST_URL is required; use npm run test:postgres:docker for a managed local database",
    );
  const databaseName = safeDatabaseName();
  const admin = new pg.Pool({ connectionString: adminUrl, max: 4 });
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const target = new URL(adminUrl);
  target.pathname = `/${databaseName}`;
  const databaseUrl = target.toString();
  const root = await mkdtemp(join(tmpdir(), "omoikane-postgres-test-"));
  const settings = getSettings({
    OMOIKANE_DATA_DIR: root,
    AGENT_DATABASE_URL: databaseUrl,
    AGENT_ARTIFACT_ROOT: join(root, "artifacts"),
    AGENT_SKILL_ROOT: join(root, "skills"),
    AGENT_SANDBOX_ROOT: join(root, "sandboxes"),
    AGENT_CREDENTIAL_SECRET: "postgres-test-secret-with-sufficient-entropy",
    AGENT_TRACING_DISABLED: "true",
    AGENT_AUTO_MIGRATE: "true",
    AGENT_RUN_LEASE_SECONDS: "10",
    AGENT_WORKER_POLL_MS: "25",
  });
  let primary: Container | undefined;
  let secondary: Container | undefined;
  try {
    primary = await Container.create(settings, { startWorker: false });
    secondary = await Container.create(settings, { startWorker: false });
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
    let runtimeConnectionsClosed = false;
    const closeRuntimeConnections = async () => {
      if (runtimeConnectionsClosed) return;
      runtimeConnectionsClosed = true;
      await Promise.all([primary!.close(), secondary!.close(), pool.end()]);
    };
    return {
      databaseUrl,
      settings,
      primary,
      secondary,
      pool,
      closeRuntimeConnections,
      async close() {
        await closeRuntimeConnections();
        await dropTestDatabase(admin, databaseName);
        await admin.end();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await Promise.allSettled([primary?.close(), secondary?.close()]);
    await dropTestDatabase(admin, databaseName);
    await admin.end();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function queuedRun(environment: PostgresTestEnvironment) {
  const deployment = await environment.primary.definitions.deploy({
    config: {
      name: "PostgreSQL integration Agent",
      instructions: "This Run is used only for durable queue tests.",
      runtime_policy: { max_turns: 3, max_duration_seconds: 30 },
    },
  });
  const run = await environment.primary.runner.create({
    deploymentId: deployment.id,
    input: "queue test",
  });
  return { deployment, run };
}
