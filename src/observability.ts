import {
  BatchTraceProcessor,
  OpenAITracingExporter,
  generateTraceId,
  getGlobalTraceProvider,
  setSensitiveDataLoggingEnabled,
  setTraceProcessors,
  setTracingDisabled,
  type TracingExporter,
} from "@openai/agents";
import type { Settings } from "./config.js";
import { ValidationError } from "./database.js";

export type RuntimeLogLevel = "debug" | "info" | "warn" | "error" | "silent";
export type TraceExporterFactory = () => TracingExporter;

const exporterFactories = new Map<string, TraceExporterFactory>();
const exporterKey = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export function registerTraceExporter(
  key: string,
  factory: TraceExporterFactory,
) {
  if (!exporterKey.test(key))
    throw new ValidationError(
      "trace exporter key must match [a-z0-9][a-z0-9._-]{0,127}",
    );
  if (exporterFactories.has(key))
    throw new ValidationError(`trace exporter already registered: ${key}`);
  exporterFactories.set(key, factory);
}

export function unregisterTraceExporter(key: string) {
  exporterFactories.delete(key);
}

export type RuntimeLogField = string | number | boolean | null;

const allowedRuntimeLogFields = new Set([
  "run_id",
  "run_trace_id",
  "sdk_trace_id",
  "deployment_id",
  "execution_attempt",
  "worker_id",
  "provider",
  "model",
  "request_id",
  "status",
  "error_type",
  "exporter",
  "failure_count",
  "cleanup_type",
]);

const levels: Record<Exclude<RuntimeLogLevel, "silent">, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function safeErrorType(error: unknown): string {
  const candidate =
    error instanceof Error
      ? error.name || error.constructor.name
      : typeof error === "object" && error !== null
        ? "NonErrorObject"
        : typeof error;
  return candidate.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
}

export function runtimeLogRecord(
  level: Exclude<RuntimeLogLevel, "silent">,
  code: string,
  fields: Record<string, unknown> = {},
) {
  const safe: Record<string, RuntimeLogField> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!allowedRuntimeLogFields.has(key)) continue;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      safe[key] = typeof value === "string" ? value.slice(0, 512) : value;
  }
  return {
    time: new Date().toISOString(),
    level,
    component: "omoikane-runtime",
    code: code.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 128),
    ...safe,
  };
}

class RuntimeLogger {
  constructor(private readonly minimum: RuntimeLogLevel) {}

  private enabled(level: Exclude<RuntimeLogLevel, "silent">) {
    return this.minimum !== "silent" && levels[level] >= levels[this.minimum];
  }

  write(
    level: Exclude<RuntimeLogLevel, "silent">,
    code: string,
    fields: Record<string, unknown> = {},
  ) {
    if (!this.enabled(level)) return;
    const encoded = JSON.stringify(runtimeLogRecord(level, code, fields));
    if (level === "warn" || level === "error") process.stderr.write(`${encoded}\n`);
    else process.stdout.write(`${encoded}\n`);
  }
}

export interface TracingRuntimeStatus {
  enabled: boolean;
  exporter: string;
  content_policy: "metadata_only";
  state: "disabled" | "ready" | "degraded" | "closed";
  failure_count: number;
  last_export_attempt_at: string | null;
  last_export_completed_at: string | null;
  last_export_failure_at: string | null;
}

class MonitoredTraceExporter implements TracingExporter {
  constructor(
    private readonly delegate: TracingExporter,
    private readonly owner: ObservabilityService,
  ) {}

  async export(
    items: Parameters<TracingExporter["export"]>[0],
    signal?: AbortSignal,
  ) {
    this.owner.exportAttempted();
    try {
      await this.delegate.export(items, signal);
      this.owner.exportCompleted();
    } catch (error) {
      this.owner.exportFailed(error);
      // Telemetry delivery is deliberately isolated from Run execution.
    }
  }
}

export class ObservabilityService {
  readonly logger: RuntimeLogger;
  private processor?: BatchTraceProcessor;
  private closed = false;
  private failureCount = 0;
  private lastExportAttemptAt: string | null = null;
  private lastExportCompletedAt: string | null = null;
  private lastExportFailureAt: string | null = null;

  private constructor(private readonly settings: Settings) {
    this.logger = new RuntimeLogger(settings.logLevel);
  }

  static async create(settings: Settings) {
    const service = new ObservabilityService(settings);

    // Importing @openai/agents installs its OpenAI exporter. Replace it before
    // any Runtime work can start so no Provider traffic is exported implicitly.
    setSensitiveDataLoggingEnabled(false);
    setTracingDisabled(true);
    await getGlobalTraceProvider().shutdown(5_000);
    setTraceProcessors([]);

    if (settings.tracingExporter === "disabled") return service;

    let exporter: TracingExporter;
    if (settings.tracingExporter === "openai") {
      if (!settings.tracingApiKey)
        throw new ValidationError(
          `OpenAI tracing requires a key in ${settings.tracingApiKeyEnv}`,
        );
      exporter = new OpenAITracingExporter({ apiKey: settings.tracingApiKey });
    } else {
      const key = settings.tracingExporter.slice("custom:".length);
      const factory = exporterFactories.get(key);
      if (!factory)
        throw new ValidationError(`trace exporter is not registered: ${key}`);
      exporter = factory();
    }

    service.processor = new BatchTraceProcessor(
      new MonitoredTraceExporter(exporter, service),
      {
        maxQueueSize: 1_000,
        maxBatchSize: 100,
        scheduleDelay: 5_000,
        exportTriggerRatio: 0.8,
      },
    );
    setTraceProcessors([service.processor]);
    setTracingDisabled(false);
    return service;
  }

  get tracingEnabled() {
    return this.settings.tracingExporter !== "disabled" && !this.closed;
  }

  newAttemptTraceId() {
    return generateTraceId();
  }

  exportAttempted() {
    this.lastExportAttemptAt = new Date().toISOString();
  }

  exportCompleted() {
    this.lastExportCompletedAt = new Date().toISOString();
  }

  exportFailed(error: unknown) {
    this.failureCount += 1;
    this.lastExportFailureAt = new Date().toISOString();
    this.logger.write("error", "trace_export_failed", {
      exporter: this.settings.tracingExporter,
      failure_count: this.failureCount,
      error_type: safeErrorType(error),
    });
  }

  status(): TracingRuntimeStatus {
    return {
      enabled: this.tracingEnabled,
      exporter: this.settings.tracingExporter,
      content_policy: "metadata_only",
      state: this.closed
        ? "closed"
        : this.settings.tracingExporter === "disabled"
          ? "disabled"
          : this.failureCount
            ? "degraded"
            : "ready",
      failure_count: this.failureCount,
      last_export_attempt_at: this.lastExportAttemptAt,
      last_export_completed_at: this.lastExportCompletedAt,
      last_export_failure_at: this.lastExportFailureAt,
    };
  }

  async flush() {
    if (!this.processor || this.closed) return;
    await this.processor.forceFlush();
  }

  async close() {
    if (this.closed) return;
    setTracingDisabled(true);
    try {
      await this.processor?.forceFlush();
      await this.processor?.shutdown(5_000);
    } finally {
      setTraceProcessors([]);
      this.closed = true;
    }
  }
}
