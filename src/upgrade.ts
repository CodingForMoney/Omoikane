import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Settings } from "./config.js";
import { Database } from "./database.js";
import {
  assertMigrationCompatible,
  migrate,
  type MigrationPreflight,
} from "./migrations.js";
import {
  defaultBackupPath,
  internalBackup,
  type BackupVerification,
} from "./backup.js";
import { RuntimeLock } from "./runtime-lock.js";

export interface PostgreSqlBackupEvidence {
  path: string;
  size: number;
  sha256: string;
  modified_at: string;
}

export interface UpgradeResult {
  engine: "pglite" | "postgresql";
  check_only: boolean;
  before: MigrationPreflight;
  backup?: BackupVerification;
  postgres_backup?: PostgreSqlBackupEvidence;
  applied_versions: string[];
  after?: MigrationPreflight;
}

async function inspect(settings: Settings) {
  const db = await Database.connect(settings);
  try {
    return await assertMigrationCompatible(db);
  } finally {
    await db.close();
  }
}

async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function validatePostgreSqlBackup(
  path: string | undefined,
): Promise<PostgreSqlBackupEvidence> {
  if (!path)
    throw new Error(
      "PostgreSQL upgrade requires --postgres-backup <pg_dump file>; create it with PostgreSQL's official tools first",
    );
  const absolute = resolve(path);
  const info = await stat(absolute);
  if (!info.isFile() || info.size === 0)
    throw new Error(
      "PostgreSQL backup evidence must be a non-empty regular file",
    );
  return {
    path: absolute,
    size: info.size,
    sha256: await hashFile(absolute),
    modified_at: info.mtime.toISOString(),
  };
}

export async function preflightUpgrade(
  settings: Settings,
): Promise<MigrationPreflight> {
  const lock = await RuntimeLock.acquire(settings.dataDir, "upgrade-check");
  try {
    return await inspect(settings);
  } finally {
    await lock.release();
  }
}

export async function safeUpgrade(
  settings: Settings,
  options: {
    checkOnly?: boolean;
    backupPath?: string;
    postgresBackupPath?: string;
  } = {},
): Promise<UpgradeResult> {
  const engine = settings.databaseUrl.startsWith("pglite://")
    ? "pglite"
    : "postgresql";
  const lock = await RuntimeLock.acquire(settings.dataDir, "upgrade");
  try {
    const before = await inspect(settings);
    if (options.checkOnly || !before.pending_versions.length)
      return {
        engine,
        check_only: Boolean(options.checkOnly),
        before,
        applied_versions: [],
        ...(options.checkOnly ? {} : { after: before }),
      };

    let backup: BackupVerification | undefined;
    let postgresBackup: PostgreSqlBackupEvidence | undefined;
    if (before.migration_table_exists) {
      if (engine === "pglite") {
        backup = await internalBackup.createPgliteBackupUnlocked(
          settings,
          options.backupPath ?? defaultBackupPath(settings),
        );
      } else {
        postgresBackup = await validatePostgreSqlBackup(
          options.postgresBackupPath,
        );
      }
    }

    const db = await Database.connect(settings);
    let applied: string[];
    try {
      applied = await migrate(db, {
        credentialSecret: settings.credentialSecret,
      });
    } catch (error) {
      const recovery = backup
        ? `restore the verified snapshot at ${backup.path}`
        : postgresBackup
          ? `restore ${postgresBackup.path} with PostgreSQL's official tools`
          : "repair or recreate the uninitialized database";
      throw new Error(
        `upgrade failed; Omoikane does not run destructive down-migrations or automatic restore. Stop and ${recovery}`,
        { cause: error },
      );
    } finally {
      await db.close();
    }
    const after = await inspect(settings);
    if (after.pending_versions.length)
      throw new Error(
        `upgrade post-verification failed; pending migrations remain: ${after.pending_versions.join(", ")}`,
      );
    return {
      engine,
      check_only: false,
      before,
      backup,
      postgres_backup: postgresBackup,
      applied_versions: applied,
      after,
    };
  } finally {
    await lock.release();
  }
}
