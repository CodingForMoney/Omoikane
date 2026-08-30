import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPgliteBackup,
  restorePgliteBackup,
  verifyBackup,
  type BackupManifest,
} from "../src/backup.js";
import { getSettings, type Settings } from "../src/config.js";
import { Container } from "../src/container.js";
import { Database } from "../src/database.js";
import {
  MIGRATION_VERSIONS,
  migrate,
  preflightMigrations,
} from "../src/migrations.js";
import { safeUpgrade } from "../src/upgrade.js";
import { RuntimeLock } from "../src/runtime-lock.js";
import { MIGRATION_HEAD } from "../src/runtime-versions.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root() {
  const path = await mkdtemp(join(tmpdir(), "omoikane-backup-test-"));
  roots.push(path);
  return path;
}

function settings(dataDir: string, autoMigrate = true): Settings {
  return getSettings({
    OMOIKANE_DATA_DIR: dataDir,
    OMOIKANE_AUTO_MIGRATE: String(autoMigrate),
    OMOIKANE_RUN_CONCURRENCY: "1",
    OMOIKANE_TRACING_DISABLED: "true",
  });
}

async function populatedRuntime(dataDir: string) {
  const runtimeSettings = settings(dataDir);
  const container = await Container.create(runtimeSettings, {
    startWorker: false,
  });
  const provider = await container.providers.create({
    name: "Backup Provider",
    provider: "xiaomi_mimo",
    api_key: "backup-test-provider-key",
  });
  const imported = await container.skills.importBundle([
    {
      path: "SKILL.md",
      content_base64: Buffer.from(
        "---\nname: Backup Skill\ndescription: Verify Skill restore\n---\n\nKeep this instruction intact.\n",
      ).toString("base64"),
    },
  ]);
  const deployment = await container.definitions.deploy({
    config: {
      name: "Backup Agent",
      instructions: "Preserve durable state.",
      provider: { connection_id: provider.id },
      model: "mimo-v2.5",
      model_settings: {},
      tools: [],
      skills: [{ version_id: imported.version.id }],
      mcp_servers: [],
      compaction: { enabled: false },
    },
  });
  const run = await container.runner.create({
    deploymentId: deployment.id,
    input: "Preserve this queued request",
    idempotencyKey: `backup-${randomUUID()}`,
  });
  await container.db.query(
    "UPDATE runs SET status='waiting_approval' WHERE id=$1",
    [run.id],
  );
  await container.db.query(
    `INSERT INTO approvals(id,run_id,interruption_id,tool_name,request_json,status,expires_at)
     VALUES($1,$2,$3,$4,$5::jsonb,'pending',now()+interval '1 hour')`,
    [
      "backup-approval",
      run.id,
      "backup-interruption",
      "durable_action",
      JSON.stringify({ value: "preserve-me" }),
    ],
  );
  await container.db.query(
    `INSERT INTO tool_executions(id,run_id,tool_call_id,tool_name,implementation_key,idempotency_key,arguments_hash,status,side_effecting)
     VALUES($1,$2,$3,$4,$5,$6,$7,'unknown',true)`,
    [
      "backup-tool-execution",
      run.id,
      "backup-call",
      "durable_action",
      "backup.test.action",
      "backup-tool-idempotency",
      "backup-arguments-hash",
    ],
  );
  const artifact = await container.artifacts.create(
    "result.txt",
    Buffer.from("durable artifact bytes"),
    { runId: run.id, mimeType: "text/plain" },
  );
  return {
    settings: runtimeSettings,
    container,
    provider,
    skill: imported,
    run,
    artifact,
  };
}

async function legacyDatabaseThrough0004(db: Database) {
  const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  for (const filename of [
    "0001_typescript_runtime.sql",
    "0002_runtime_boundary.sql",
    "0003_postgres_reliability.sql",
    "0004_local_runtime_storage.sql",
  ]) {
    const sql = await readFile(
      join(packageRoot, "migrations", filename),
      "utf8",
    );
    await db.transaction(async (tx) => {
      for (const statement of sql.split(/;\s*(?:\n|$)/)) {
        if (statement.trim()) await tx.query(statement);
      }
      await tx.query("INSERT INTO omoikane_migrations(version) VALUES($1)", [
        filename.slice(0, 4),
      ]);
    });
  }
  await db.query("ALTER TABLE run_states ALTER COLUMN state_json SET NOT NULL");
  for (const statement of [
    "ALTER TABLE run_states DROP COLUMN encrypted_state",
    "ALTER TABLE run_states DROP COLUMN checksum",
    "ALTER TABLE runs DROP COLUMN encrypted_payload",
    "ALTER TABLE runs DROP COLUMN payload_checksum",
    "ALTER TABLE runs DROP COLUMN encrypted_result",
    "ALTER TABLE runs DROP COLUMN result_checksum",
  ])
    await db.query(statement);
}

describe("backup, restore, and safe upgrades", () => {
  it("prevents concurrent Runtime, backup, and restore access", async () => {
    const testRoot = await root();
    const dataDir = join(testRoot, "locked-runtime");
    const first = await RuntimeLock.acquire(dataDir, "first Runtime");
    try {
      await expect(RuntimeLock.acquire(dataDir, "backup")).rejects.toThrow(
        "first Runtime",
      );
    } finally {
      await first.release();
    }
    const reservation = await RuntimeLock.acquireRestoreReservation(dataDir);
    try {
      await expect(RuntimeLock.acquire(dataDir, "Runtime")).rejects.toThrow(
        "being restored",
      );
    } finally {
      await reservation.release();
    }
    const reopened = await RuntimeLock.acquire(dataDir, "Runtime");
    await reopened.release();
  });

  it("restores Provider credentials, active Run state, Skills, and Artifacts", async () => {
    const testRoot = await root();
    const fixture = await populatedRuntime(join(testRoot, "source"));
    await fixture.container.close();
    const snapshot = join(testRoot, "snapshot");
    const created = await createPgliteBackup(fixture.settings, snapshot);
    expect(created.manifest.credential.mode).toBe("file");
    expect(created.manifest.excluded).toContain("sandboxes");

    const target = join(testRoot, "restored");
    await mkdir(target);
    const restored = await restorePgliteBackup(snapshot, target);
    expect(restored).toMatchObject({
      credentials_verified: 1,
      skills_verified: 1,
      artifacts_verified: 1,
    });

    const container = await Container.create(settings(target, false), {
      startWorker: false,
    });
    try {
      expect(await container.providers.verifyStoredCredentialEncryption()).toBe(
        1,
      );
      expect(await container.runner.get(fixture.run.id)).toMatchObject({
        status: "waiting_approval",
      });
      expect(
        (
          await container.db.query(
            "SELECT id FROM approvals WHERE id='backup-approval'",
          )
        ).rows,
      ).toHaveLength(1);
      expect(await container.tools.executions(fixture.run.id)).toEqual([
        expect.objectContaining({
          id: "backup-tool-execution",
          status: "unknown",
          side_effecting: true,
        }),
      ]);
      expect(
        Buffer.from(
          await container.artifacts.bytes(fixture.artifact.id),
        ).toString(),
      ).toBe("durable artifact bytes");
      const versions = await container.skills.versions(fixture.skill.skill.id);
      expect(versions).toHaveLength(1);
      await expect(
        container.skills.validateBindings(
          [{ version_id: fixture.skill.version.id }],
          { toolNames: new Set() },
        ),
      ).resolves.toHaveLength(1);
    } finally {
      await container.close();
    }
  }, 30_000);

  it("rejects checksum corruption and a checksum-consistent wrong credential key", async () => {
    const testRoot = await root();
    const fixture = await populatedRuntime(join(testRoot, "source"));
    await fixture.container.close();
    const snapshot = join(testRoot, "snapshot");
    await createPgliteBackup(fixture.settings, snapshot);

    const databaseFile = (await verifyBackup(snapshot)).manifest.files.find(
      (file) => file.path.startsWith("database/"),
    )!;
    await writeFile(join(snapshot, databaseFile.path), "corrupt");
    await expect(verifyBackup(snapshot)).rejects.toThrow("checksum mismatch");

    await rm(snapshot, { recursive: true, force: true });
    await createPgliteBackup(fixture.settings, snapshot);
    await rm(join(snapshot, "credential.key"));
    await expect(verifyBackup(snapshot)).rejects.toThrow("credential key");

    await rm(snapshot, { recursive: true, force: true });
    await createPgliteBackup(fixture.settings, snapshot);
    const wrongKey = "a-different-but-checksum-consistent-credential-key\n";
    await writeFile(join(snapshot, "credential.key"), wrongKey, {
      mode: 0o600,
    });
    const manifestPath = join(snapshot, "manifest.json");
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as BackupManifest;
    const keyEntry = manifest.files.find(
      (file) => file.path === "credential.key",
    )!;
    keyEntry.size = Buffer.byteLength(wrongKey);
    keyEntry.sha256 = createHash("sha256").update(wrongKey).digest("hex");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(verifyBackup(snapshot)).resolves.toBeDefined();
    await expect(
      restorePgliteBackup(snapshot, join(testRoot, "wrong-key-restore")),
    ).rejects.toThrow();
  }, 60_000);

  it("rejects future and discontinuous migration histories without writing", async () => {
    expect(MIGRATION_VERSIONS.at(-1)).toBe(MIGRATION_HEAD);
    const testRoot = await root();
    const runtimeSettings = settings(join(testRoot, "migration-state"), false);
    const db = await Database.connect(runtimeSettings);
    try {
      await migrate(db, { credentialSecret: runtimeSettings.credentialSecret });
      await db.query("INSERT INTO omoikane_migrations(version) VALUES('9999')");
      expect(await preflightMigrations(db)).toMatchObject({
        compatible: false,
        issues: [expect.stringContaining("unknown")],
      });
      await db.query("DELETE FROM omoikane_migrations WHERE version='9999'");
      await db.query("DELETE FROM omoikane_migrations WHERE version='0004'");
      expect(await preflightMigrations(db)).toMatchObject({
        compatible: false,
        issues: [expect.stringContaining("contiguous prefix")],
      });
    } finally {
      await db.close();
    }
  });

  it("requires explicit safe upgrade and creates a verified pre-upgrade snapshot", async () => {
    const testRoot = await root();
    const runtimeSettings = settings(join(testRoot, "upgrade-source"));
    const container = await Container.create(runtimeSettings, {
      startWorker: false,
    });
    await container.providers.create({
      name: "Upgrade Provider",
      provider: "xiaomi_mimo",
      api_key: "upgrade-provider-key",
    });
    await container.close();

    const db = await Database.connect(runtimeSettings);
    try {
      await db.query("DROP INDEX ix_artifacts_run_status_page");
      await db.query("DELETE FROM omoikane_migrations WHERE version='0010'");
    } finally {
      await db.close();
    }
    await expect(
      Container.create(runtimeSettings, { startWorker: false }),
    ).rejects.toThrow("omoikane upgrade");

    const backupPath = join(testRoot, "pre-upgrade");
    const result = await safeUpgrade(runtimeSettings, { backupPath });
    expect(result.before.current_version).toBe("0009");
    expect(result.applied_versions).toEqual(["0010"]);
    expect(result.after?.current_version).toBe(
      MIGRATION_VERSIONS[MIGRATION_VERSIONS.length - 1],
    );
    expect(
      (await verifyBackup(backupPath)).manifest.migration.current_version,
    ).toBe("0009");

    const reopened = await Container.create(runtimeSettings, {
      startWorker: false,
    });
    try {
      expect(await reopened.providers.verifyStoredCredentialEncryption()).toBe(
        1,
      );
      expect(
        (
          await reopened.db.query<{ column_name: string }>(
            "SELECT column_name FROM information_schema.columns WHERE table_name='runs' AND column_name='execution_attempt'",
          )
        ).rows,
      ).toHaveLength(1);
    } finally {
      await reopened.close();
    }
  }, 30_000);

  it("leaves a verified snapshot when an ordered migration rejects legacy data", async () => {
    const testRoot = await root();
    const runtimeSettings = settings(join(testRoot, "failed-upgrade"), false);
    const db = await Database.connect(runtimeSettings);
    try {
      await legacyDatabaseThrough0004(db);
      await db.query(
        `INSERT INTO resources(id,tenant_id,kind,slug,name,data) VALUES
         ('conflict-a','tenant-a','tool','shared-slug','A','{}'::jsonb),
         ('conflict-b','tenant-b','tool','shared-slug','B','{}'::jsonb)`,
      );
    } finally {
      await db.close();
    }

    const backupPath = join(testRoot, "recovery-snapshot");
    await expect(safeUpgrade(runtimeSettings, { backupPath })).rejects.toThrow(
      "restore the verified snapshot",
    );
    expect(
      (await verifyBackup(backupPath)).manifest.migration.current_version,
    ).toBe("0004");
    const unchanged = await Database.connect(runtimeSettings);
    try {
      expect(
        (
          await unchanged.query(
            "SELECT version FROM omoikane_migrations WHERE version='0005'",
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await unchanged.query(
            "SELECT column_name FROM information_schema.columns WHERE table_name='resources' AND column_name='tenant_id'",
          )
        ).rows,
      ).toHaveLength(1);
    } finally {
      await unchanged.close();
    }
  }, 30_000);
});
