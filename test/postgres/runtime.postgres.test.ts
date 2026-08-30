import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponse,
} from "@openai/agents/testing";
import { afterEach, describe, expect, it } from "vitest";
import { Container } from "../../src/container.js";
import { safeUpgrade } from "../../src/upgrade.js";
import {
  registerToolImplementation,
  unregisterToolImplementation,
} from "../../src/tools.js";
import { publishedAgent } from "../helpers.js";
import {
  postgresTestEnvironment,
  queuedRun,
  type PostgresTestEnvironment,
} from "./helpers.js";

let environment: PostgresTestEnvironment | undefined;
const registeredTools = new Set<string>();

afterEach(async () => {
  for (const key of registeredTools) unregisterToolImplementation(key);
  registeredTools.clear();
  await environment?.close();
  environment = undefined;
});

const setup = async () => (environment = await postgresTestEnvironment());
const waitForLine = (
  child: ChildProcessWithoutNullStreams,
  prefix: string,
  timeoutMs = 10_000,
) =>
  new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(
      () => reject(new Error(`child timeout: ${stderr || stdout}`)),
      timeoutMs,
    );
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const line = stdout.split("\n").find((entry) => entry.startsWith(prefix));
      if (!line) return;
      clearTimeout(timeout);
      resolve(line);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`child exited ${code}: ${stderr || stdout}`));
    });
  });
const startClaimWorker = (test: PostgresTestEnvironment) => {
  const workerPath = fileURLToPath(
    new URL("../fixtures/postgres-claim-worker.ts", import.meta.url),
  );
  return spawn(process.execPath, ["--import", "tsx", workerPath], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: {
      ...process.env,
      AGENT_DATABASE_URL: test.databaseUrl,
      AGENT_AUTO_MIGRATE: "false",
      AGENT_CREDENTIAL_SECRET: test.settings.credentialSecret,
      AGENT_ARTIFACT_ROOT: test.settings.artifactRoot,
      AGENT_SKILL_ROOT: test.settings.skillRoot,
      AGENT_SANDBOX_ROOT: test.settings.sandboxRoot,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
};
const killWorker = async (child: ChildProcessWithoutNullStreams) => {
  if (child.exitCode === null) child.kill("SIGKILL");
  await new Promise<void>((resolve) =>
    child.exitCode === null ? child.once("exit", () => resolve()) : resolve(),
  );
};

describe.sequential("PostgreSQL concurrency and failure recovery", () => {
  it("requires external pg_dump evidence before a PostgreSQL schema upgrade", async () => {
    const test = await setup();
    await test.closeRuntimeConnections();
    const pool = new pg.Pool({ connectionString: test.databaseUrl, max: 2 });
    try {
      await pool.query("DROP TABLE mcp_oauth_states");
      await pool.query("DELETE FROM omoikane_migrations WHERE version='0011'");
    } finally {
      await pool.end();
    }

    await expect(safeUpgrade(test.settings)).rejects.toThrow(
      "--postgres-backup",
    );
    const evidence = `${test.settings.dataDir}/pre-upgrade.pg_dump`;
    await writeFile(evidence, "pg_dump test evidence\n");
    const result = await safeUpgrade(test.settings, {
      postgresBackupPath: evidence,
    });
    expect(result).toMatchObject({
      engine: "postgresql",
      applied_versions: ["0011"],
      postgres_backup: { path: evidence },
      after: { current_version: "0011", pending_versions: [] },
    });
  });

  it("allows exactly one local Worker slot to claim a queued Run", async () => {
    const test = await setup();
    const fixture = await queuedRun(test);

    const claims = await Promise.all([
      test.primary.runner.claim(),
      test.secondary.runner.claim(),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.id).toBe(fixture.run.id);
    const stored = await test.primary.runner.get(fixture.run.id);
    expect(stored.status).toBe("running");
    expect(
      (await test.primary.events.list(fixture.run.id)).filter(
        (event) => event.type === "run.started",
      ),
    ).toHaveLength(1);
  });

  it("converges concurrent idempotent Run creation on one row", async () => {
    const test = await setup();
    const deployment = await test.primary.definitions.deploy({
      config: { name: "Idempotency Agent", instructions: "Test only" },
    });
    const create = (container: Container, input = "same request") =>
      container.runner.create({
        deploymentId: deployment.id,
        input,
        idempotencyKey: "same-business-request",
      });

    const created = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        create(index % 2 ? test.primary : test.secondary),
      ),
    );

    expect(new Set(created.map((run) => run.id)).size).toBe(1);
    const count = await test.pool.query<{ count: string }>(
      "SELECT count(*) count FROM runs WHERE idempotency_key=$1",
      ["same-business-request"],
    );
    expect(Number(count.rows[0]?.count)).toBe(1);
    const changedCredentialContainer = await Container.create(
      {
        ...test.settings,
        credentialSecret: "different-provider-only-credential-secret",
      },
      { startWorker: false },
    );
    try {
      expect((await create(changedCredentialContainer)).id).toBe(
        created[0]!.id,
      );
    } finally {
      await changedCredentialContainer.close();
    }
    await expect(create(test.secondary, "different request")).rejects.toThrow(
      "different request",
    );
  });

  it("serializes concurrent imports into immutable Skill versions", async () => {
    const test = await setup();
    const source = Buffer.from(
      `---
name: PostgreSQL concurrent Skill
slug: postgres-concurrent-skill
omoikane:
  schema_version: 1
  workspace: optional
---

# PostgreSQL concurrent Skill

The bundle is imported concurrently by two Runtime instances.
`,
    ).toString("base64");

    const imported = await Promise.all([
      test.primary.skills.importBundle([
        { path: "SKILL.md", content_base64: source },
      ]),
      test.secondary.skills.importBundle([
        { path: "SKILL.md", content_base64: source },
      ]),
    ]);

    expect(new Set(imported.map((item) => item.skill.id)).size).toBe(1);
    expect(
      imported
        .map((item) => Number(item.version.version))
        .sort((left, right) => left - right),
    ).toEqual([1, 2]);
    const versions = await test.primary.skills.versions(imported[0]!.skill.id);
    expect(versions).toHaveLength(2);
    expect(new Set(versions.map((version) => version.content_hash)).size).toBe(
      1,
    );
    const stored = await readdir(
      `${test.settings.skillRoot}/${imported[0]!.skill.id}`,
    );
    expect(stored.sort()).toEqual(["1", "2"]);
  });

  it("does not reap a Run whose lease was renewed during the race", async () => {
    const test = await setup();
    const fixture = await queuedRun(test);
    await test.primary.runner.claim();
    await test.pool.query(
      "UPDATE runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [fixture.run.id],
    );
    const locker = new pg.Client({ connectionString: test.databaseUrl });
    await locker.connect();
    await locker.query("BEGIN");
    await locker.query("SELECT id FROM runs WHERE id=$1 FOR UPDATE", [
      fixture.run.id,
    ]);
    await locker.query(
      "UPDATE runs SET lease_expires_at=now()+interval '1 minute' WHERE id=$1",
      [fixture.run.id],
    );

    const reaping = test.secondary.runner.reap();
    let lockObserved = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const waiting = await test.pool.query<{ count: string }>(
        "SELECT count(*) count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
      );
      if (Number(waiting.rows[0]?.count) > 0) {
        lockObserved = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(lockObserved).toBe(true);
    await locker.query("COMMIT");
    await locker.end();
    await reaping;

    expect((await test.primary.runner.get(fixture.run.id)).status).toBe(
      "running",
    );
    expect(
      (await test.primary.events.list(fixture.run.id)).some(
        (event) => event.type === "run.requeued",
      ),
    ).toBe(false);

    await test.pool.query(
      "UPDATE runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [fixture.run.id],
    );
    await test.secondary.runner.reap();
    expect((await test.primary.runner.get(fixture.run.id)).status).toBe(
      "queued",
    );
  });

  it("serializes conflicting approval decisions", async () => {
    const test = await setup();
    const implementationKey = `postgres.approval.${crypto.randomUUID()}`;
    const toolSlug = `postgres-approval-${crypto.randomUUID().slice(0, 8)}`;
    registerToolImplementation(implementationKey, async () => ({ ok: true }));
    registeredTools.add(implementationKey);
    await test.primary.tools.create({
      slug: toolSlug,
      name: "postgres_approval_action",
      description: "Approval race integration fixture",
      implementation_key: implementationKey,
      schema: { type: "object", properties: {}, additionalProperties: false },
      policy: { requires_approval: true, side_effecting: true },
    });
    const model = new ScriptedModel([
      modelResponse([
        functionCall(
          "postgres_approval_action",
          {},
          { callId: "pg-approval-1" },
        ),
      ]),
      modelResponse([assistantMessage("done")]),
    ]);
    const fixture = await publishedAgent(test.primary, {
      model,
      tools: [toolSlug],
    });
    const run = await test.primary.runner.create({
      deploymentId: fixture.version.id,
      input: "request approval",
    });
    await test.primary.runner.processNext();
    const approval = (
      await test.pool.query<{ id: string }>(
        "SELECT id FROM approvals WHERE run_id=$1",
        [run.id],
      )
    ).rows[0]!;

    const decisions = await Promise.allSettled([
      test.primary.runner.decideApproval(approval.id, "approved", "reviewer-a"),
      test.secondary.runner.decideApproval(
        approval.id,
        "rejected",
        "reviewer-b",
      ),
    ]);

    expect(
      decisions.filter((decision) => decision.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      decisions.filter((decision) => decision.status === "rejected"),
    ).toHaveLength(1);
    const stored = await test.pool.query<{ status: string }>(
      "SELECT status FROM approvals WHERE id=$1",
      [approval.id],
    );
    expect(["approved", "rejected"]).toContain(stored.rows[0]?.status);
    expect((await test.primary.runner.get(run.id)).status).toBe("queued");
  });

  it("rolls back Run state and Event sequence in one PostgreSQL transaction", async () => {
    const test = await setup();
    const fixture = await queuedRun(test);
    const before = await test.primary.runner.get(fixture.run.id);

    await expect(
      test.primary.db.transaction(async (tx) => {
        await tx.query("UPDATE runs SET status='completed' WHERE id=$1", [
          fixture.run.id,
        ]);
        await test.primary.events.appendInTransaction(
          tx,
          fixture.run.id,
          "postgres.atomic",
          { committed: false },
        );
        throw new Error("rollback PostgreSQL transaction");
      }),
    ).rejects.toThrow("rollback PostgreSQL transaction");

    const after = await test.primary.runner.get(fixture.run.id);
    expect(after.status).toBe("queued");
    expect(after.version).toBe(before.version);
    expect(
      (await test.primary.events.list(fixture.run.id)).some(
        (event) => event.type === "postgres.atomic",
      ),
    ).toBe(false);
  });

  it("recovers a terminated Worker without repeating ambiguous side effects", async () => {
    const test = await setup();
    const fixture = await queuedRun(test);
    const child = startClaimWorker(test);
    try {
      const claimed = await waitForLine(child, "CLAIMED:");
      expect(claimed).toBe(`CLAIMED:${fixture.run.id}`);
    } finally {
      await killWorker(child);
    }
    expect((await test.primary.runner.get(fixture.run.id)).status).toBe(
      "running",
    );

    await test.pool.query(
      "UPDATE runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [fixture.run.id],
    );
    await test.secondary.runner.reap();

    expect((await test.primary.runner.get(fixture.run.id)).status).toBe(
      "queued",
    );
    expect(
      (await test.primary.events.list(fixture.run.id)).some(
        (event) => event.type === "run.requeued",
      ),
    ).toBe(true);

    await test.pool.query("UPDATE runs SET status='cancelled' WHERE id=$1", [
      fixture.run.id,
    ]);
    const ambiguous = await test.primary.runner.create({
      deploymentId: fixture.deployment.id,
      input: "ambiguous side effect",
    });
    const sideEffectWorker = startClaimWorker(test);
    try {
      expect(await waitForLine(sideEffectWorker, "CLAIMED:")).toBe(
        `CLAIMED:${ambiguous.id}`,
      );
      await test.pool.query(
        `INSERT INTO tool_executions(id,run_id,tool_call_id,tool_name,implementation_key,idempotency_key,arguments_hash,status)
         VALUES($1,$2,$3,$4,$5,$6,$7,'running')`,
        [
          crypto.randomUUID(),
          ambiguous.id,
          "ambiguous-call",
          "external_side_effect",
          "postgres.test.side-effect",
          crypto.randomUUID(),
          "arguments-hash",
        ],
      );
    } finally {
      await killWorker(sideEffectWorker);
    }
    await test.pool.query(
      "UPDATE runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [ambiguous.id],
    );
    await test.secondary.runner.reap();

    expect((await test.primary.runner.get(ambiguous.id)).status).toBe(
      "waiting_reconciliation",
    );
    const execution = await test.pool.query<{ status: string }>(
      "SELECT status FROM tool_executions WHERE run_id=$1",
      [ambiguous.id],
    );
    expect(execution.rows[0]?.status).toBe("unknown");
    expect(
      (await test.primary.events.list(ambiguous.id)).some(
        (event) => event.type === "tool.reconciliation_required",
      ),
    ).toBe(true);
  });
});
