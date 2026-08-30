import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import type { Settings } from "./config.js";
import { Database } from "./database.js";
import { MIGRATION_VERSIONS, assertMigrationCompatible } from "./migrations.js";
import { ProviderService } from "./providers.js";
import { McpOAuthService } from "./mcp-oauth.js";
import { RuntimeLock } from "./runtime-lock.js";
import { OMOIKANE_VERSION } from "./runtime-versions.js";

export interface BackupFile {
  path: string;
  size: number;
  sha256: string;
}

export interface BackupManifest {
  format: "omoikane-backup";
  format_version: 1;
  created_at: string;
  omoikane_version: string;
  migration: {
    applied_versions: string[];
    current_version: string | null;
    target_version: string;
  };
  database: { engine: "pglite"; path: "database" };
  credential:
    | { mode: "file"; path: "credential.key" }
    | { mode: "external"; required_environment: true };
  skills: { path: "skills"; source_root: string };
  artifacts: { path: "artifacts" };
  excluded: string[];
  files: BackupFile[];
}

export interface BackupVerification {
  path: string;
  manifest: BackupManifest;
  files_verified: number;
  bytes_verified: number;
}

const pathInside = (root: string, candidate: string) => {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
};

const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function pgliteDirectory(settings: Settings) {
  if (!settings.databaseUrl.startsWith("pglite://"))
    throw new Error(
      "packaged backup/restore is available only for PGlite; use pg_dump/pg_restore for PostgreSQL",
    );
  const path = settings.databaseUrl.slice("pglite://".length);
  if (path === ":memory:")
    throw new Error("an in-memory PGlite database cannot be backed up");
  return resolve(path);
}

function safeManifestPath(path: unknown) {
  if (typeof path !== "string" || !path) return false;
  return (
    path === posix.normalize(path) &&
    !path.startsWith("/") &&
    !path.startsWith("../") &&
    !path.includes("\\") &&
    !path.includes("\0")
  );
}

async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function walkFiles(root: string, prefix = ""): Promise<BackupFile[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: BackupFile[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const absolute = join(root, entry.name);
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const info = await lstat(absolute);
    if (info.isSymbolicLink())
      throw new Error(`backup source contains a symbolic link: ${path}`);
    if (info.isDirectory()) {
      files.push(...(await walkFiles(absolute, path)));
      continue;
    }
    if (!info.isFile())
      throw new Error(`backup source contains a non-regular file: ${path}`);
    files.push({ path, size: info.size, sha256: await digest(absolute) });
  }
  return files;
}

async function copyDirectory(source: string, target: string) {
  if (!(await exists(source))) {
    await mkdir(target, { recursive: true });
    return;
  }
  const info = await lstat(source);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`backup source must be a directory: ${source}`);
  await walkFiles(source);
  await cp(source, target, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
  });
}

function validateMigrationManifest(manifest: BackupManifest) {
  const applied = manifest.migration.applied_versions;
  const expected = MIGRATION_VERSIONS.slice(0, applied.length);
  if (
    applied.length > MIGRATION_VERSIONS.length ||
    applied.some((version, index) => version !== expected[index])
  )
    throw new Error(
      "backup was created from an unknown, future, or discontinuous database schema",
    );
  const current = applied.length ? applied[applied.length - 1]! : null;
  if (manifest.migration.current_version !== current)
    throw new Error("backup migration metadata is inconsistent");
  const backupTargetIndex = MIGRATION_VERSIONS.indexOf(
    manifest.migration.target_version,
  );
  const currentIndex = current ? MIGRATION_VERSIONS.indexOf(current) : -1;
  if (backupTargetIndex < 0 || backupTargetIndex < currentIndex)
    throw new Error(
      `backup targets an incompatible migration: ${manifest.migration.target_version}`,
    );
}

function parseManifest(value: unknown): BackupManifest {
  if (!value || typeof value !== "object")
    throw new Error("backup manifest must be an object");
  const manifest = value as BackupManifest;
  if (manifest.format !== "omoikane-backup" || manifest.format_version !== 1)
    throw new Error("unsupported Omoikane backup format");
  if (
    typeof manifest.created_at !== "string" ||
    !Number.isFinite(Date.parse(manifest.created_at)) ||
    typeof manifest.omoikane_version !== "string" ||
    !Array.isArray(manifest.excluded)
  )
    throw new Error("backup manifest metadata is invalid");
  if (
    manifest.database?.engine !== "pglite" ||
    manifest.database.path !== "database" ||
    manifest.skills?.path !== "skills" ||
    typeof manifest.skills.source_root !== "string" ||
    manifest.artifacts?.path !== "artifacts"
  )
    throw new Error("backup manifest layout is invalid");
  if (
    !manifest.migration ||
    !Array.isArray(manifest.migration.applied_versions) ||
    !manifest.migration.applied_versions.every(
      (version) => typeof version === "string",
    )
  )
    throw new Error("backup migration metadata is invalid");
  if (
    !manifest.credential ||
    (manifest.credential.mode !== "file" &&
      manifest.credential.mode !== "external")
  )
    throw new Error("backup credential metadata is invalid");
  if (
    manifest.credential.mode === "file" &&
    manifest.credential.path !== "credential.key"
  )
    throw new Error("backup credential path is invalid");
  if (!Array.isArray(manifest.files))
    throw new Error("backup file index is invalid");
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (
      !safeManifestPath(file.path) ||
      file.path === "manifest.json" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      seen.has(file.path)
    )
      throw new Error(`backup file index entry is invalid: ${file.path}`);
    seen.add(file.path);
  }
  validateMigrationManifest(manifest);
  return manifest;
}

export async function verifyBackup(path: string): Promise<BackupVerification> {
  const root = resolve(path);
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error("backup path must be a directory");
  const manifest = parseManifest(
    JSON.parse(await readFile(join(root, "manifest.json"), "utf8")),
  );
  for (const directory of ["database", "skills", "artifacts"]) {
    const directoryInfo = await lstat(join(root, directory));
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory())
      throw new Error(`backup is missing required directory: ${directory}`);
  }
  const actual = (await walkFiles(root)).filter(
    (file) => file.path !== "manifest.json",
  );
  if (
    manifest.credential.mode === "file" &&
    !actual.some((file) => file.path === "credential.key")
  )
    throw new Error("backup is missing its credential key");
  if (actual.length !== manifest.files.length)
    throw new Error("backup file count does not match its manifest");
  for (let index = 0; index < actual.length; index += 1) {
    const expected = manifest.files[index]!;
    const found = actual[index]!;
    if (
      found.path !== expected.path ||
      found.size !== expected.size ||
      found.sha256 !== expected.sha256
    )
      throw new Error(`backup checksum mismatch: ${expected.path}`);
  }
  return {
    path: root,
    manifest,
    files_verified: actual.length,
    bytes_verified: actual.reduce((total, file) => total + file.size, 0),
  };
}

async function createPgliteBackupUnlocked(
  settings: Settings,
  target: string,
): Promise<BackupVerification> {
  const databasePath = pgliteDirectory(settings);
  if (databasePath === resolve(settings.dataDir))
    throw new Error(
      "PGlite must use its own directory below the Runtime data directory for packaged backups",
    );
  const output = resolve(target);
  for (const source of [
    settings.dataDir,
    databasePath,
    settings.skillRoot,
    settings.artifactRoot,
  ]) {
    if (pathInside(source, output))
      throw new Error(`backup target cannot be inside source path: ${source}`);
  }
  if (await exists(output))
    throw new Error(`backup target already exists: ${output}`);
  await mkdir(dirname(output), { recursive: true });

  const db = await Database.connect(settings);
  let preflight;
  try {
    preflight = await assertMigrationCompatible(db);
  } finally {
    await db.close();
  }

  const temporary = await mkdtemp(
    join(dirname(output), `.${basename(output)}.incomplete-`),
  );
  try {
    await copyDirectory(databasePath, join(temporary, "database"));
    await copyDirectory(settings.skillRoot, join(temporary, "skills"));
    await copyDirectory(settings.artifactRoot, join(temporary, "artifacts"));
    let credential: BackupManifest["credential"];
    if (settings.credentialSecretFile) {
      await cp(
        settings.credentialSecretFile,
        join(temporary, "credential.key"),
        {
          force: false,
          errorOnExist: true,
        },
      );
      await chmod(join(temporary, "credential.key"), 0o600);
      credential = { mode: "file", path: "credential.key" };
    } else {
      credential = { mode: "external", required_environment: true };
    }
    const files = await walkFiles(temporary);
    const manifest: BackupManifest = {
      format: "omoikane-backup",
      format_version: 1,
      created_at: new Date().toISOString(),
      omoikane_version: OMOIKANE_VERSION,
      migration: {
        applied_versions: preflight.applied_versions,
        current_version: preflight.current_version,
        target_version: preflight.target_version,
      },
      database: { engine: "pglite", path: "database" },
      credential,
      skills: { path: "skills", source_root: resolve(settings.skillRoot) },
      artifacts: { path: "artifacts" },
      excluded: [
        "sandboxes",
        "logs-and-caches",
        "environment-provider-credentials",
        "business-owned-conversations-and-memory",
      ],
      files,
    };
    await writeFile(
      join(temporary, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await verifyBackup(temporary);
    await rename(temporary, output);
    return verifyBackup(output);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function createPgliteBackup(
  settings: Settings,
  target: string,
): Promise<BackupVerification> {
  const lock = await RuntimeLock.acquire(settings.dataDir, "backup");
  try {
    return await createPgliteBackupUnlocked(settings, target);
  } finally {
    await lock.release();
  }
}

async function assertEmptyOrMissing(path: string) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(`restore target is not an empty directory: ${path}`);
    if ((await readdir(path)).length)
      throw new Error(`restore target is not empty: ${path}`);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function verifyRestoredArtifacts(db: Database, artifactRoot: string) {
  const rows = await db.query<{
    id: string;
    storage_key: string;
    sha256: string;
    size: number;
  }>("SELECT id,storage_key,sha256,size FROM artifacts WHERE status='active'");
  for (const row of rows.rows) {
    const path = resolve(artifactRoot, row.storage_key);
    if (!pathInside(artifactRoot, path))
      throw new Error(`artifact ${row.id} escaped the restored Artifact root`);
    const info = await stat(path);
    if (info.size !== Number(row.size) || (await digest(path)) !== row.sha256)
      throw new Error(`restored artifact failed verification: ${row.id}`);
  }
  return rows.rows.length;
}

async function relocateAndVerifySkills(
  db: Database,
  sourceRoot: string,
  physicalSkillRoot: string,
  storedSkillRoot: string,
) {
  const versions = await db.query<{
    id: string;
    data: Record<string, unknown>;
  }>("SELECT id,data FROM resources WHERE kind='skill_version'");
  for (const version of versions.rows) {
    const oldPath = resolve(String(version.data.bundle_uri ?? ""));
    if (!pathInside(sourceRoot, oldPath))
      throw new Error(`Skill ${version.id} escaped the backed-up Skill root`);
    const relativePath = relative(resolve(sourceRoot), oldPath);
    const physicalPath = resolve(physicalSkillRoot, relativePath);
    const storedPath = resolve(storedSkillRoot, relativePath);
    if (
      !pathInside(physicalSkillRoot, physicalPath) ||
      !pathInside(storedSkillRoot, storedPath)
    )
      throw new Error(`Skill ${version.id} escaped the restored Skill root`);
    const expected = Array.isArray(version.data.files)
      ? (version.data.files as BackupFile[])
      : undefined;
    const actual = await walkFiles(physicalPath);
    if (expected) {
      if (
        actual.length !== expected.length ||
        actual.some((file, index) => {
          const item = expected[index];
          return (
            !item ||
            file.path !== item.path ||
            file.size !== item.size ||
            file.sha256 !== item.sha256
          );
        })
      )
        throw new Error(`restored Skill failed verification: ${version.id}`);
    } else {
      if (version.data.hash_format === "file-index-v1")
        throw new Error(`Skill ${version.id} has no verifiable file index`);
      const legacyParts: Buffer[] = [];
      for (const file of actual) {
        legacyParts.push(Buffer.from(file.path));
        legacyParts.push(await readFile(resolve(physicalPath, file.path)));
      }
      const legacyDigest = createHash("sha256")
        .update(Buffer.concat(legacyParts))
        .digest("hex");
      if (legacyDigest !== version.data.content_hash)
        throw new Error(
          `restored legacy Skill failed verification: ${version.id}`,
        );
    }
    await db.query(
      `UPDATE resources
       SET data=jsonb_set(data,'{bundle_uri}',to_jsonb($2::text),true),updated_at=now()
       WHERE id=$1`,
      [version.id, storedPath],
    );
  }
  return versions.rows.length;
}

export async function restorePgliteBackup(
  snapshot: string,
  targetDataDir: string,
  options: { externalCredentialSecret?: string } = {},
) {
  const verification = await verifyBackup(snapshot);
  const source = resolve(snapshot);
  const target = resolve(targetDataDir);
  if (pathInside(source, target) || pathInside(target, source))
    throw new Error("backup and restore target cannot contain one another");
  await mkdir(dirname(target), { recursive: true });
  const lock = await RuntimeLock.acquireRestoreReservation(
    target,
    `restore:${basename(target)}`,
  );
  let temporary: string | undefined;
  try {
    const targetExisted = await assertEmptyOrMissing(target);
    temporary = await mkdtemp(
      join(dirname(target), `.${basename(target)}.restore-`),
    );
    await copyDirectory(join(source, "database"), join(temporary, "omoikane"));
    await copyDirectory(join(source, "skills"), join(temporary, "skills"));
    await copyDirectory(
      join(source, "artifacts"),
      join(temporary, "artifacts"),
    );
    let credentialSecret: string;
    let credentialSecretFile: string | undefined;
    if (verification.manifest.credential.mode === "file") {
      credentialSecretFile = join(temporary, "credential.key");
      await cp(join(source, "credential.key"), credentialSecretFile, {
        force: false,
        errorOnExist: true,
      });
      await chmod(credentialSecretFile, 0o600);
      credentialSecret = (await readFile(credentialSecretFile, "utf8")).trim();
      if (!credentialSecret)
        throw new Error("restored credential key is empty");
    } else {
      if (!options.externalCredentialSecret)
        throw new Error(
          "this backup requires OMOIKANE_CREDENTIAL_SECRET from the source Runtime",
        );
      credentialSecret = options.externalCredentialSecret;
    }
    const restoredSettings = {
      dataDir: temporary,
      databaseUrl: `pglite://${join(temporary, "omoikane")}`,
      artifactRoot: join(temporary, "artifacts"),
      skillRoot: join(temporary, "skills"),
      credentialSecret,
      credentialSecretFile,
    };
    const db = await Database.connect(restoredSettings);
    let preflight;
    let credentialsVerified = 0;
    let skillsVerified = 0;
    let artifactsVerified = 0;
    try {
      preflight = await assertMigrationCompatible(db);
      skillsVerified = await relocateAndVerifySkills(
        db,
        verification.manifest.skills.source_root,
        restoredSettings.skillRoot,
        join(target, "skills"),
      );
      artifactsVerified = await verifyRestoredArtifacts(
        db,
        restoredSettings.artifactRoot,
      );
      credentialsVerified = await new ProviderService(
        db,
        credentialSecret,
      ).verifyStoredCredentialEncryption();
      credentialsVerified += await new McpOAuthService(
        db,
        credentialSecret,
        "http://127.0.0.1",
      ).verifyStoredCredentialEncryption();
    } finally {
      await db.close();
    }
    await assertEmptyOrMissing(target);
    if (targetExisted) await rmdir(target);
    await rename(temporary, target);
    temporary = undefined;
    return {
      path: target,
      migration: preflight,
      credentials_verified: credentialsVerified,
      skills_verified: skillsVerified,
      artifacts_verified: artifactsVerified,
    };
  } catch (error) {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    throw error;
  } finally {
    await lock.release();
  }
}

export function defaultBackupPath(settings: Settings) {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  return resolve(
    dirname(settings.dataDir),
    "omoikane-backups",
    `${basename(settings.dataDir)}-${stamp}`,
  );
}

export const internalBackup = {
  createPgliteBackupUnlocked,
};
