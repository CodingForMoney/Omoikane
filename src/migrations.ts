import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { Database } from "./database.js";
import type { SqlExecutor } from "./database.js";
import { LEGACY_DEVELOPMENT_CREDENTIAL_SECRET } from "./config.js";
import { CredentialCipher } from "./crypto.js";
import { hashJson } from "./serialization.js";

export const MIGRATION_FILES = [
  "0001_typescript_runtime.sql",
  "0002_runtime_boundary.sql",
  "0003_postgres_reliability.sql",
  "0004_local_runtime_storage.sql",
  "0005_single_instance_runtime.sql",
  "0006_usage_only.sql",
  "0007_mcp_runtime.sql",
  "0008_compaction_runtime.sql",
  "0009_recovery_semantics.sql",
  "0010_artifact_lifecycle.sql",
] as const;

export const MIGRATION_VERSIONS = MIGRATION_FILES.map(
  (filename) => filename.split("_")[0]!,
);
export const TARGET_MIGRATION_VERSION =
  MIGRATION_VERSIONS[MIGRATION_VERSIONS.length - 1]!;

export interface MigrationPreflight {
  migration_table_exists: boolean;
  applied_versions: string[];
  current_version: string | null;
  target_version: string;
  pending_versions: string[];
  compatible: boolean;
  issues: string[];
}

export class MigrationCompatibilityError extends Error {
  constructor(readonly preflight: MigrationPreflight) {
    super(`database schema is not compatible: ${preflight.issues.join("; ")}`);
    this.name = "MigrationCompatibilityError";
  }
}

export async function preflightMigrations(
  database: Database,
): Promise<MigrationPreflight> {
  const table = await database.query<{ relation: string | null }>(
    "SELECT to_regclass('public.omoikane_migrations')::text AS relation",
  );
  const migrationTableExists = Boolean(table.rows[0]?.relation);
  const appliedVersions = migrationTableExists
    ? (
        await database.query<{ version: string }>(
          "SELECT version FROM omoikane_migrations ORDER BY version",
        )
      ).rows.map((row) => row.version)
    : [];
  const issues: string[] = [];
  const known = new Set(MIGRATION_VERSIONS);
  const unknown = appliedVersions.filter((version) => !known.has(version));
  if (unknown.length)
    issues.push(
      `database contains migrations unknown to this Runtime: ${unknown.join(", ")}`,
    );
  const knownApplied = appliedVersions.filter((version) => known.has(version));
  const expectedPrefix = MIGRATION_VERSIONS.slice(0, knownApplied.length);
  if (
    knownApplied.length > MIGRATION_VERSIONS.length ||
    knownApplied.some((version, index) => version !== expectedPrefix[index])
  )
    issues.push(
      `applied migrations are not a contiguous prefix of ${MIGRATION_VERSIONS.join(", ")}`,
    );
  const prefixLength = issues.length ? 0 : knownApplied.length;
  return {
    migration_table_exists: migrationTableExists,
    applied_versions: appliedVersions,
    current_version:
      appliedVersions.length > 0
        ? appliedVersions[appliedVersions.length - 1]!
        : null,
    target_version: TARGET_MIGRATION_VERSION,
    pending_versions: issues.length
      ? []
      : MIGRATION_VERSIONS.slice(prefixLength),
    compatible: issues.length === 0,
    issues,
  };
}

export async function assertMigrationCompatible(database: Database) {
  const preflight = await preflightMigrations(database);
  if (!preflight.compatible) throw new MigrationCompatibilityError(preflight);
  return preflight;
}

export interface MigrationOptions {
  credentialSecret?: string;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  (typeof value === "string" ? JSON.parse(value) : value) as Record<
    string,
    unknown
  >;

function decryptLegacy(
  ciphertext: Uint8Array,
  checksum: string,
  ciphers: CredentialCipher[],
): Buffer {
  for (const cipher of ciphers) {
    try {
      return cipher.decrypt(ciphertext, checksum);
    } catch {
      // Try the next locally configured compatibility secret.
    }
  }
  throw new Error(
    "cannot migrate encrypted local Runtime data; provide its previous credential secret through OMOIKANE_CREDENTIAL_SECRET (or the legacy AGENT_CREDENTIAL_SECRET/AGENT_RUN_STATE_SECRET alias)",
  );
}

async function migrateLocalRuntimeStorage(
  tx: SqlExecutor,
  options: MigrationOptions,
) {
  const secrets = [
    options.credentialSecret,
    LEGACY_DEVELOPMENT_CREDENTIAL_SECRET,
  ].filter((value, index, values): value is string =>
    Boolean(value && values.indexOf(value) === index),
  );
  const ciphers = secrets.map((secret) => new CredentialCipher(secret));

  const runs = await tx.query<{
    id: string;
    deployment_id: string;
    external_session_id: string | null;
    parent_run_id: string | null;
    input_json: unknown;
    limits_json: Record<string, unknown>;
    context_json: Record<string, unknown>;
    conversation_json: unknown[];
    output_json: unknown;
    new_items_json: unknown[];
    projection_json: Record<string, unknown> | null;
    idempotency_key: string | null;
    request_hash: string | null;
    payload_purged_at: string | null;
    encrypted_payload: Uint8Array | null;
    payload_checksum: string | null;
    encrypted_result: Uint8Array | null;
    result_checksum: string | null;
  }>("SELECT * FROM runs");
  for (const run of runs.rows) {
    const payload =
      run.encrypted_payload && run.payload_checksum
        ? asRecord(
            JSON.parse(
              decryptLegacy(
                run.encrypted_payload,
                run.payload_checksum,
                ciphers,
              ).toString(),
            ),
          )
        : {
            input: run.input_json,
            conversation: run.conversation_json ?? [],
            context: run.context_json ?? {},
          };
    const result =
      run.encrypted_result && run.result_checksum
        ? asRecord(
            JSON.parse(
              decryptLegacy(
                run.encrypted_result,
                run.result_checksum,
                ciphers,
              ).toString(),
            ),
          )
        : {
            output: run.output_json,
            new_items: run.new_items_json ?? [],
            projection: run.projection_json,
          };
    const requestHash =
      run.idempotency_key && !run.payload_purged_at
        ? hashJson({
            deployment_id: run.deployment_id,
            input: payload.input,
            conversation: payload.conversation ?? [],
            external_session_id: run.external_session_id,
            context: payload.context ?? {},
            limits: run.limits_json ?? {},
            parent_run_id: run.parent_run_id,
          })
        : run.request_hash;
    await tx.query(
      `UPDATE runs SET input_json=$2::jsonb,conversation_json=$3::jsonb,context_json=$4::jsonb,
       output_json=$5::jsonb,new_items_json=$6::jsonb,projection_json=$7::jsonb,request_hash=$8
       WHERE id=$1`,
      [
        run.id,
        JSON.stringify(payload.input ?? null),
        JSON.stringify(payload.conversation ?? []),
        JSON.stringify(payload.context ?? {}),
        JSON.stringify(result.output ?? null),
        JSON.stringify(result.new_items ?? []),
        JSON.stringify(result.projection ?? null),
        requestHash,
      ],
    );
  }

  const states = await tx.query<{
    run_id: string;
    encrypted_state: Uint8Array | null;
    checksum: string | null;
    state_json: unknown;
  }>("SELECT * FROM run_states");
  for (const state of states.rows) {
    if (state.state_json !== null && state.state_json !== undefined) continue;
    if (!state.encrypted_state || !state.checksum)
      throw new Error(`Run ${state.run_id} has no resumable SDK state`);
    const plaintext = decryptLegacy(
      state.encrypted_state,
      state.checksum,
      ciphers,
    ).toString();
    await tx.query(
      "UPDATE run_states SET state_json=$2::jsonb WHERE run_id=$1",
      [state.run_id, JSON.stringify(JSON.parse(plaintext))],
    );
  }

  const providers = await tx.query<{ id: string; data: unknown }>(
    "SELECT id,data FROM resources WHERE kind='provider_connection'",
  );
  for (const provider of providers.rows) {
    const data = asRecord(provider.data);
    if (!data.api_key_ciphertext || !data.api_key_checksum) continue;
    if (!options.credentialSecret)
      throw new Error(
        "OMOIKANE_CREDENTIAL_SECRET is required to migrate stored Provider credentials",
      );
    const plaintext = decryptLegacy(
      Buffer.from(String(data.api_key_ciphertext), "base64"),
      String(data.api_key_checksum),
      ciphers,
    );
    const encrypted = new CredentialCipher(options.credentialSecret).encrypt(
      plaintext,
    );
    await tx.query("UPDATE resources SET data=$2::jsonb WHERE id=$1", [
      provider.id,
      JSON.stringify({
        ...data,
        api_key_ciphertext: encrypted.ciphertext.toString("base64"),
        api_key_checksum: encrypted.checksum,
      }),
    ]);
  }

  await tx.query("ALTER TABLE run_states ALTER COLUMN state_json SET NOT NULL");
  await tx.query(
    "ALTER TABLE run_states DROP COLUMN IF EXISTS encrypted_state",
  );
  await tx.query("ALTER TABLE run_states DROP COLUMN IF EXISTS checksum");
  await tx.query("ALTER TABLE runs DROP COLUMN IF EXISTS encrypted_payload");
  await tx.query("ALTER TABLE runs DROP COLUMN IF EXISTS payload_checksum");
  await tx.query("ALTER TABLE runs DROP COLUMN IF EXISTS encrypted_result");
  await tx.query("ALTER TABLE runs DROP COLUMN IF EXISTS result_checksum");
}

async function assertSingleInstanceMergeIsSafe(tx: SqlExecutor) {
  const checks = [
    {
      label: "resource slugs",
      sql: `SELECT kind || ':' || slug AS key,count(*)::int AS count
            FROM resources WHERE slug IS NOT NULL
            GROUP BY kind,slug HAVING count(*)>1 LIMIT 10`,
    },
    {
      label: "Run idempotency keys",
      sql: `SELECT idempotency_key AS key,count(*)::int AS count
            FROM runs WHERE idempotency_key IS NOT NULL
            GROUP BY idempotency_key HAVING count(*)>1 LIMIT 10`,
    },
    {
      label: "Tool idempotency keys",
      sql: `SELECT idempotency_key AS key,count(*)::int AS count
            FROM tool_executions
            GROUP BY idempotency_key HAVING count(*)>1 LIMIT 10`,
    },
  ];
  for (const check of checks) {
    const conflicts = await tx.query<{ key: string; count: number }>(check.sql);
    if (conflicts.rows.length)
      throw new Error(
        `cannot merge legacy namespaces: conflicting ${check.label}: ${conflicts.rows
          .map((row) => `${row.key} (${row.count})`)
          .join(", ")}`,
      );
  }
}

/**
 * Low-level ordered migration executor. Runtime operators should use
 * safeUpgrade(), which adds offline locking, backup evidence, and post-checks.
 */
export async function migrate(
  database: Database,
  options: MigrationOptions = {},
): Promise<string[]> {
  await database.query(`CREATE TABLE IF NOT EXISTS omoikane_migrations (
    version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await assertMigrationCompatible(database);
  const applied = new Set(
    (
      await database.query<{ version: string }>(
        "SELECT version FROM omoikane_migrations",
      )
    ).rows.map((row) => row.version),
  );
  const completed: string[] = [];
  const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  for (const filename of MIGRATION_FILES) {
    const version = filename.split("_")[0]!;
    if (applied.has(version)) continue;
    const path = resolve(packageRoot, "migrations", filename);
    const sql = await readFile(path, "utf8");
    await database.transaction(async (tx) => {
      if (version === "0005") await assertSingleInstanceMergeIsSafe(tx);
      for (const statement of sql.split(/;\s*(?:\n|$)/)) {
        if (statement.trim()) await tx.query(statement);
      }
      if (version === "0004") await migrateLocalRuntimeStorage(tx, options);
      await tx.query("INSERT INTO omoikane_migrations(version) VALUES ($1)", [
        version,
      ]);
    });
    completed.push(version);
  }
  return completed;
}
