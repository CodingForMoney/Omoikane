import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ override: false, quiet: true });

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined) return fallback;
      return ["1", "true", "yes", "on"].includes(value.toLowerCase());
    });

export interface Settings {
  dataDir: string;
  databaseUrl: string;
  host: string;
  port: number;
  publicBaseUrl: string;
  allowRemote: boolean;
  corsOrigins: string[];
  artifactRoot: string;
  skillRoot: string;
  sandboxRoot: string;
  sandboxProvider: "process" | "docker";
  credentialSecret: string;
  credentialSecretFile?: string;
  runConcurrency: number;
  workerPollMs: number;
  runLeaseSeconds: number;
  sseHeartbeatSeconds: number;
  sseMaxConnections: number;
  sseMaxConnectionsPerRun: number;
  ssePollFallbackMs: number;
  /** @deprecated Use tracingExporter. */
  tracingDisabled: boolean;
  tracingExporter: "disabled" | "openai" | `custom:${string}`;
  tracingApiKeyEnv: string;
  tracingApiKey?: string;
  logLevel: "debug" | "info" | "warn" | "error" | "silent";
  maxEventPayloadBytes: number;
  defaultApprovalTimeoutSeconds: number;
  terminalPayloadTtlSeconds: number;
  eventTtlSeconds: number;
  artifactTtlSeconds: number;
  artifactMaxFileBytes: number;
  artifactMaxTotalBytes: number;
  autoMigrate: boolean;
  buildCommit: string;
}

export const LEGACY_DEVELOPMENT_CREDENTIAL_SECRET =
  "development-only-change-me-before-production";

export function configuredCredentialSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    env.OMOIKANE_CREDENTIAL_SECRET ??
    env.AGENT_CREDENTIAL_SECRET ??
    env.AGENT_RUN_STATE_SECRET
  );
}

function localCredentialSecret(
  env: NodeJS.ProcessEnv,
  dataDir: string,
): { secret: string; file?: string } {
  const configured = configuredCredentialSecret(env);
  if (configured) return { secret: configured };
  const file = resolve(
    env.OMOIKANE_CREDENTIAL_FILE ??
      env.AGENT_CREDENTIAL_SECRET_FILE ??
      resolve(dataDir, "credential.key"),
  );
  mkdirSync(dirname(file), { recursive: true });
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (!existing) throw new Error(`credential key file is empty: ${file}`);
    return { secret: existing, file };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const generated = randomBytes(32).toString("base64url");
  try {
    writeFileSync(file, `${generated}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return { secret: generated, file };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readFileSync(file, "utf8").trim();
    if (!existing) throw new Error(`credential key file is empty: ${file}`);
    return { secret: existing, file };
  }
}

const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);

export function getSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const dataDir = resolve(env.OMOIKANE_DATA_DIR ?? "./var");
  const credential = localCredentialSecret(env, dataDir);
  const host = env.OMOIKANE_HOST ?? env.AGENT_HOST ?? "127.0.0.1";
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65_535)
    .parse(env.OMOIKANE_PORT ?? env.AGENT_PORT ?? 8000);
  const allowRemote = bool(false).parse(env.OMOIKANE_ALLOW_REMOTE);
  if (!allowRemote && !localHosts.has(host))
    throw new Error(
      "Omoikane is a local unauthenticated Runtime; set OMOIKANE_ALLOW_REMOTE=true only behind a trusted business-system boundary",
    );
  const legacyTracingDisabled = bool(true).parse(
    env.OMOIKANE_TRACING_DISABLED ?? env.AGENT_TRACING_DISABLED,
  );
  const tracingExporter = z
    .string()
    .regex(/^(disabled|openai|custom:[a-z0-9][a-z0-9._-]{0,127})$/)
    .parse(
      env.OMOIKANE_TRACING_EXPORTER ??
        (legacyTracingDisabled ? "disabled" : "openai"),
    ) as Settings["tracingExporter"];
  const tracingApiKeyEnv = z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .parse(env.OMOIKANE_TRACING_API_KEY_ENV ?? "OPENAI_TRACING_API_KEY");
  const settings: Settings = {
    dataDir,
    databaseUrl:
      env.OMOIKANE_DATABASE_URL ??
      env.AGENT_DATABASE_URL ??
      `pglite://${resolve(dataDir, "omoikane")}`,
    host,
    port,
    publicBaseUrl: (() => {
      const displayHost = host === "::1" ? "[::1]" : host;
      const raw =
        env.OMOIKANE_PUBLIC_BASE_URL ?? `http://${displayHost}:${port}`;
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new Error("OMOIKANE_PUBLIC_BASE_URL must be an absolute URL");
      }
      if (!["http:", "https:"].includes(url.protocol))
        throw new Error("OMOIKANE_PUBLIC_BASE_URL must use http or https");
      if (url.username || url.password || url.search || url.hash)
        throw new Error(
          "OMOIKANE_PUBLIC_BASE_URL must not contain credentials, query, or fragment",
        );
      if (url.pathname !== "/")
        throw new Error("OMOIKANE_PUBLIC_BASE_URL must not contain a path");
      return url.toString().replace(/\/$/, "");
    })(),
    allowRemote,
    corsOrigins: (
      env.OMOIKANE_CORS_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000"
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    artifactRoot: resolve(
      env.OMOIKANE_ARTIFACT_DIR ??
        env.AGENT_ARTIFACT_ROOT ??
        resolve(dataDir, "artifacts"),
    ),
    skillRoot: resolve(
      env.OMOIKANE_SKILL_DIR ??
        env.AGENT_SKILL_ROOT ??
        resolve(dataDir, "skills"),
    ),
    sandboxRoot: resolve(
      env.OMOIKANE_SANDBOX_DIR ??
        env.AGENT_SANDBOX_ROOT ??
        resolve(dataDir, "sandboxes"),
    ),
    sandboxProvider: z
      .enum(["process", "docker"])
      .parse(env.OMOIKANE_SANDBOX_PROVIDER ?? "process"),
    credentialSecret: credential.secret,
    credentialSecretFile: credential.file,
    runConcurrency: z.coerce
      .number()
      .int()
      .min(1)
      .max(64)
      .parse(env.OMOIKANE_RUN_CONCURRENCY ?? 4),
    workerPollMs: z.coerce
      .number()
      .positive()
      .parse(env.OMOIKANE_WORKER_POLL_MS ?? env.AGENT_WORKER_POLL_MS ?? 500),
    runLeaseSeconds: z.coerce
      .number()
      .int()
      .min(10)
      .parse(
        env.OMOIKANE_RUN_LEASE_SECONDS ?? env.AGENT_RUN_LEASE_SECONDS ?? 60,
      ),
    sseHeartbeatSeconds: z.coerce
      .number()
      .int()
      .min(1)
      .parse(
        env.OMOIKANE_SSE_HEARTBEAT_SECONDS ??
          env.AGENT_SSE_HEARTBEAT_SECONDS ??
          15,
      ),
    sseMaxConnections: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .parse(env.OMOIKANE_SSE_MAX_CONNECTIONS ?? 64),
    sseMaxConnectionsPerRun: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .parse(env.OMOIKANE_SSE_MAX_CONNECTIONS_PER_RUN ?? 8),
    ssePollFallbackMs: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .parse(env.OMOIKANE_SSE_POLL_FALLBACK_MS ?? 1_000),
    tracingDisabled: tracingExporter === "disabled",
    tracingExporter,
    tracingApiKeyEnv,
    tracingApiKey: env[tracingApiKeyEnv],
    logLevel: z
      .enum(["debug", "info", "warn", "error", "silent"])
      .parse(env.OMOIKANE_LOG_LEVEL ?? "info"),
    maxEventPayloadBytes: z.coerce
      .number()
      .int()
      .min(1024)
      .parse(
        env.OMOIKANE_MAX_EVENT_PAYLOAD_BYTES ??
          env.AGENT_MAX_EVENT_PAYLOAD_BYTES ??
          256_000,
      ),
    defaultApprovalTimeoutSeconds: z.coerce
      .number()
      .int()
      .min(60)
      .parse(
        env.OMOIKANE_DEFAULT_APPROVAL_TIMEOUT_SECONDS ??
          env.AGENT_DEFAULT_APPROVAL_TIMEOUT_SECONDS ??
          86_400,
      ),
    terminalPayloadTtlSeconds: z.coerce
      .number()
      .int()
      .min(60)
      .parse(
        env.OMOIKANE_TERMINAL_PAYLOAD_TTL_SECONDS ??
          env.AGENT_TERMINAL_PAYLOAD_TTL_SECONDS ??
          86_400,
      ),
    eventTtlSeconds: z.coerce
      .number()
      .int()
      .min(60)
      .parse(
        env.OMOIKANE_EVENT_TTL_SECONDS ??
          env.AGENT_EVENT_TTL_SECONDS ??
          604_800,
      ),
    artifactTtlSeconds: z.coerce
      .number()
      .int()
      .min(60)
      .parse(
        env.OMOIKANE_ARTIFACT_TTL_SECONDS ??
          env.AGENT_ARTIFACT_TTL_SECONDS ??
          86_400,
      ),
    artifactMaxFileBytes: z.coerce
      .number()
      .int()
      .min(1)
      .max(2_000_000_000)
      .parse(env.OMOIKANE_ARTIFACT_MAX_FILE_BYTES ?? 100_000_000),
    artifactMaxTotalBytes: z.coerce
      .number()
      .int()
      .min(1)
      .max(20_000_000_000)
      .parse(env.OMOIKANE_ARTIFACT_MAX_TOTAL_BYTES ?? 1_000_000_000),
    autoMigrate: bool(true).parse(
      env.OMOIKANE_AUTO_MIGRATE ?? env.AGENT_AUTO_MIGRATE,
    ),
    buildCommit:
      env.OMOIKANE_BUILD_COMMIT ?? env.AGENT_BUILD_COMMIT ?? "unknown",
  };
  if (settings.artifactMaxTotalBytes < settings.artifactMaxFileBytes)
    throw new Error(
      "OMOIKANE_ARTIFACT_MAX_TOTAL_BYTES must be greater than or equal to OMOIKANE_ARTIFACT_MAX_FILE_BYTES",
    );
  for (const directory of [
    settings.dataDir,
    settings.artifactRoot,
    settings.skillRoot,
    settings.sandboxRoot,
  ])
    mkdirSync(directory, { recursive: true });
  if (settings.databaseUrl.startsWith("pglite://")) {
    const dataPath = settings.databaseUrl.slice("pglite://".length);
    if (dataPath !== ":memory:")
      mkdirSync(resolve(dataPath), { recursive: true });
  }
  return settings;
}
