import { readFile, rm, mkdtemp } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  getSettings,
  LEGACY_DEVELOPMENT_CREDENTIAL_SECRET,
} from "../src/config.js";
import { CredentialCipher } from "../src/crypto.js";
import { Database } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { hashJson } from "../src/serialization.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const tempRoot = async () => {
  const path = await mkdtemp(join(tmpdir(), "omoikane-storage-test-"));
  temporaryRoots.push(path);
  return path;
};

const applyLegacySchema = async (db: Database) => {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  for (const filename of [
    "0001_typescript_runtime.sql",
    "0002_runtime_boundary.sql",
    "0003_postgres_reliability.sql",
  ]) {
    const sql = await readFile(resolve(root, "migrations", filename), "utf8");
    await db.transaction(async (tx) => {
      for (const statement of sql.split(/;\s*(?:\n|$)/)) {
        if (statement.trim()) await tx.query(statement);
      }
      await tx.query("INSERT INTO omoikane_migrations(version) VALUES($1)", [
        filename.slice(0, 4),
      ]);
    });
  }
};

describe("local Runtime storage boundary", () => {
  it("generates and reuses a private local Provider credential key", async () => {
    const root = await tempRoot();
    const keyFile = join(root, "credential.key");
    const env = {
      AGENT_DATABASE_URL: "pglite://:memory:",
      AGENT_ARTIFACT_ROOT: join(root, "artifacts"),
      AGENT_SKILL_ROOT: join(root, "skills"),
      AGENT_SANDBOX_ROOT: join(root, "sandboxes"),
      AGENT_CREDENTIAL_SECRET_FILE: keyFile,
    };

    const first = getSettings(env);
    const second = getSettings(env);

    expect(first.credentialSecret).toHaveLength(43);
    expect(second.credentialSecret).toBe(first.credentialSecret);
    expect(first.credentialSecretFile).toBe(keyFile);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
  });

  it("requires an explicit override for an unauthenticated remote bind", async () => {
    const root = await tempRoot();
    const environment = {
      OMOIKANE_DATA_DIR: root,
      OMOIKANE_HOST: "0.0.0.0",
      OMOIKANE_CREDENTIAL_SECRET: "remote-bind-test-secret",
    };
    expect(() => getSettings(environment)).toThrow("OMOIKANE_ALLOW_REMOTE");
    const allowed = getSettings({
      ...environment,
      OMOIKANE_ALLOW_REMOTE: "true",
      OMOIKANE_CORS_ORIGINS: "http://127.0.0.1:3000",
    });
    expect(allowed.host).toBe("0.0.0.0");
    expect(allowed.corsOrigins).toEqual(["http://127.0.0.1:3000"]);
  });

  it("migrates legacy encrypted Run data to JSONB and keeps only Provider credential encryption", async () => {
    const root = await tempRoot();
    const settings = getSettings({
      AGENT_DATABASE_URL: "pglite://:memory:",
      AGENT_ARTIFACT_ROOT: join(root, "artifacts"),
      AGENT_SKILL_ROOT: join(root, "skills"),
      AGENT_SANDBOX_ROOT: join(root, "sandboxes"),
      AGENT_CREDENTIAL_SECRET: "new-local-provider-credential-secret",
      AGENT_AUTO_MIGRATE: "false",
    });
    const db = await Database.connect(settings);
    try {
      await applyLegacySchema(db);
      const legacy = new CredentialCipher(LEGACY_DEVELOPMENT_CREDENTIAL_SECRET);
      const payload = {
        input: "legacy input",
        conversation: [{ role: "user", content: "earlier message" }],
        context: { correlation: "business-42" },
      };
      const result = {
        output: "legacy output",
        new_items: [{ type: "message", role: "assistant" }],
        projection: { version: 3 },
      };
      const state = { version: "1.19", currentTurn: 2 };
      const encryptedPayload = legacy.encrypt(JSON.stringify(payload));
      const encryptedResult = legacy.encrypt(JSON.stringify(result));
      const encryptedState = legacy.encrypt(JSON.stringify(state));
      const encryptedKey = legacy.encrypt("legacy-provider-key");
      await db.query(
        `INSERT INTO resources(id,tenant_id,kind,name,status,data)
         VALUES('provider-1','test','provider_connection','Legacy Provider','active',$1::jsonb)`,
        [
          JSON.stringify({
            provider: "xiaomi_mimo",
            api_key_ciphertext: encryptedKey.ciphertext.toString("base64"),
            api_key_checksum: encryptedKey.checksum,
          }),
        ],
      );
      await db.query(
        `INSERT INTO runs(id,tenant_id,agent_version_id,deployment_id,status,input_json,output_json,
         limits_json,context_json,conversation_json,new_items_json,idempotency_key,request_hash,sdk_version,
         runtime_generation,config_hash,trace_id,encrypted_payload,payload_checksum,encrypted_result,result_checksum)
         VALUES('run-1','test','deployment-1','deployment-1','completed','null'::jsonb,'null'::jsonb,
         $1::jsonb,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'business-key','legacy-hmac','0.17.0',
         'legacy-generation','config-hash','trace-1',$2,$3,$4,$5)`,
        [
          JSON.stringify({ max_turns: 5 }),
          encryptedPayload.ciphertext,
          encryptedPayload.checksum,
          encryptedResult.ciphertext,
          encryptedResult.checksum,
        ],
      );
      await db.query(
        `INSERT INTO run_states(run_id,format_version,sdk_version,encrypted_state,checksum)
         VALUES('run-1',1.19,'0.17.0',$1,$2)`,
        [encryptedState.ciphertext, encryptedState.checksum],
      );

      expect(
        await migrate(db, { credentialSecret: settings.credentialSecret }),
      ).toEqual(["0004", "0005", "0006", "0007", "0008", "0009", "0010"]);

      const run = (
        await db.query<Record<string, unknown>>(
          "SELECT * FROM runs WHERE id='run-1'",
        )
      ).rows[0]!;
      expect(run).toMatchObject({
        input_json: payload.input,
        conversation_json: payload.conversation,
        context_json: payload.context,
        output_json: result.output,
        new_items_json: result.new_items,
        projection_json: result.projection,
      });
      expect(run.request_hash).toBe(
        hashJson({
          deployment_id: "deployment-1",
          input: payload.input,
          conversation: payload.conversation,
          external_session_id: null,
          context: payload.context,
          limits: { max_turns: 5 },
          parent_run_id: null,
        }),
      );
      const storedState = (
        await db.query<Record<string, unknown>>(
          "SELECT * FROM run_states WHERE run_id='run-1'",
        )
      ).rows[0]!;
      expect(storedState.state_json).toEqual(state);

      const providerData = (
        await db.query<{ data: Record<string, unknown> }>(
          "SELECT data FROM resources WHERE id='provider-1'",
        )
      ).rows[0]!.data;
      expect(
        new CredentialCipher(settings.credentialSecret)
          .decrypt(
            Buffer.from(String(providerData.api_key_ciphertext), "base64"),
            String(providerData.api_key_checksum),
          )
          .toString(),
      ).toBe("legacy-provider-key");

      const columns = await db.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name IN ('runs','run_states')",
      );
      expect(columns.rows.map((row) => row.column_name)).not.toEqual(
        expect.arrayContaining([
          "encrypted_payload",
          "payload_checksum",
          "encrypted_result",
          "result_checksum",
          "encrypted_state",
          "checksum",
          "tenant_id",
          "runtime_generation",
        ]),
      );
    } finally {
      await db.close();
    }
  });

  it("stops namespace collapse when legacy tenants contain conflicting keys", async () => {
    const root = await tempRoot();
    const settings = getSettings({
      AGENT_DATABASE_URL: "pglite://:memory:",
      AGENT_ARTIFACT_ROOT: join(root, "artifacts"),
      AGENT_SKILL_ROOT: join(root, "skills"),
      AGENT_SANDBOX_ROOT: join(root, "sandboxes"),
      AGENT_CREDENTIAL_SECRET: "single-instance-conflict-test-secret",
      AGENT_AUTO_MIGRATE: "false",
    });
    const db = await Database.connect(settings);
    try {
      await applyLegacySchema(db);
      await db.query(
        `INSERT INTO resources(id,tenant_id,kind,slug,name,data) VALUES
         ('tool-a','tenant-a','tool','shared-slug','A','{}'::jsonb),
         ('tool-b','tenant-b','tool','shared-slug','B','{}'::jsonb)`,
      );
      await expect(
        migrate(db, { credentialSecret: settings.credentialSecret }),
      ).rejects.toThrow("cannot merge legacy namespaces");
      const tenantColumn = await db.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='resources' AND column_name='tenant_id'",
      );
      expect(tenantColumn.rows).toHaveLength(1);
      expect(
        (
          await db.query(
            "SELECT version FROM omoikane_migrations WHERE version='0005'",
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
