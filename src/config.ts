import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import { DEFAULT_RUNTIME_GENERATION } from "./runtime-versions.js";

dotenv.config({ override: false, quiet: true });

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined) return fallback;
      return ["1", "true", "yes", "on"].includes(value.toLowerCase());
    });

const optionalNumber = z
  .string()
  .optional()
  .transform((value) =>
    value === undefined || value === "" ? undefined : Number(value),
  );

export interface Settings {
  databaseUrl: string;
  host: string;
  port: number;
  redisUrl?: string;
  artifactBackend: "local" | "s3";
  artifactRoot: string;
  skillRoot: string;
  sandboxRoot: string;
  sandboxHostRoot?: string;
  runStateSecret: string;
  workerPollMs: number;
  runLeaseSeconds: number;
  sseHeartbeatSeconds: number;
  tracingDisabled: boolean;
  maxEventPayloadBytes: number;
  defaultDailyBudgetUsd?: number;
  defaultApprovalTimeoutSeconds: number;
  autoMigrate: boolean;
  environment: "development" | "test" | "production";
  embeddedWorker: boolean;
  runtimeGeneration: string;
  buildCommit: string;
  webhookTimeoutMs: number;
  webhookDispatchBatchSize: number;
  s3Bucket?: string;
  s3EndpointUrl?: string;
  s3Region?: string;
}

const Environment = z.enum(["development", "test", "production"]);

export function getSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const environment = Environment.parse(env.AGENT_ENVIRONMENT ?? "development");
  const settings: Settings = {
    databaseUrl: env.AGENT_DATABASE_URL ?? "pglite://./var/omoikane",
    host: env.AGENT_HOST ?? "127.0.0.1",
    port: z.coerce
      .number()
      .int()
      .min(1)
      .max(65_535)
      .parse(env.AGENT_PORT ?? 8000),
    redisUrl: env.AGENT_REDIS_URL || undefined,
    artifactBackend: z
      .enum(["local", "s3"])
      .parse(env.AGENT_ARTIFACT_BACKEND ?? "local"),
    artifactRoot: resolve(env.AGENT_ARTIFACT_ROOT ?? "./var/artifacts"),
    skillRoot: resolve(env.AGENT_SKILL_ROOT ?? "./var/skills"),
    sandboxRoot: resolve(env.AGENT_SANDBOX_ROOT ?? "./var/sandboxes"),
    sandboxHostRoot: env.AGENT_SANDBOX_HOST_ROOT
      ? resolve(env.AGENT_SANDBOX_HOST_ROOT)
      : undefined,
    runStateSecret:
      env.AGENT_RUN_STATE_SECRET ??
      "development-only-change-me-before-production",
    workerPollMs: z.coerce
      .number()
      .positive()
      .parse(env.AGENT_WORKER_POLL_MS ?? 500),
    runLeaseSeconds: z.coerce
      .number()
      .int()
      .min(10)
      .parse(env.AGENT_RUN_LEASE_SECONDS ?? 60),
    sseHeartbeatSeconds: z.coerce
      .number()
      .int()
      .min(1)
      .parse(env.AGENT_SSE_HEARTBEAT_SECONDS ?? 15),
    tracingDisabled: bool(true).parse(env.AGENT_TRACING_DISABLED),
    maxEventPayloadBytes: z.coerce
      .number()
      .int()
      .min(1024)
      .parse(env.AGENT_MAX_EVENT_PAYLOAD_BYTES ?? 256_000),
    defaultDailyBudgetUsd: optionalNumber.parse(
      env.AGENT_DEFAULT_DAILY_BUDGET_USD,
    ),
    defaultApprovalTimeoutSeconds: z.coerce
      .number()
      .int()
      .min(60)
      .parse(env.AGENT_DEFAULT_APPROVAL_TIMEOUT_SECONDS ?? 86_400),
    autoMigrate: bool(true).parse(env.AGENT_AUTO_MIGRATE),
    environment,
    embeddedWorker: bool(true).parse(env.AGENT_EMBEDDED_WORKER),
    runtimeGeneration:
      env.AGENT_RUNTIME_GENERATION ?? DEFAULT_RUNTIME_GENERATION,
    buildCommit: env.AGENT_BUILD_COMMIT ?? "unknown",
    webhookTimeoutMs: z.coerce
      .number()
      .positive()
      .max(120_000)
      .parse(env.AGENT_WEBHOOK_TIMEOUT_MS ?? 10_000),
    webhookDispatchBatchSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .parse(env.AGENT_WEBHOOK_DISPATCH_BATCH_SIZE ?? 100),
    s3Bucket: env.AGENT_S3_BUCKET || undefined,
    s3EndpointUrl: env.AGENT_S3_ENDPOINT_URL || undefined,
    s3Region: env.AGENT_S3_REGION || undefined,
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(settings.runtimeGeneration)) {
    throw new Error("AGENT_RUNTIME_GENERATION has an invalid format");
  }
  if (environment === "production") {
    if (settings.runStateSecret.startsWith("development-only")) {
      throw new Error("AGENT_RUN_STATE_SECRET must be replaced in production");
    }
    if (!settings.databaseUrl.startsWith("postgres")) {
      throw new Error("production requires PostgreSQL");
    }
  }
  for (const directory of [
    settings.artifactRoot,
    settings.skillRoot,
    settings.sandboxRoot,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  if (settings.databaseUrl.startsWith("pglite://")) {
    const dataPath = settings.databaseUrl.slice("pglite://".length);
    if (dataPath !== ":memory:") {
      const path = resolve(dataPath);
      mkdirSync(path, { recursive: true });
    }
  }
  return settings;
}
