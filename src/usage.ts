import type { Database, SqlExecutor } from "./database.js";
import { required } from "./database.js";
import { newId } from "./serialization.js";

export type UsageReportingStatus = "reported" | "partial" | "missing";

export interface SdkUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputTokensDetails?: Record<string, number>[];
  outputTokensDetails?: Record<string, number>[];
  requestUsageEntries?: Array<{
    endpoint?: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    inputTokensDetails?: Record<string, number>;
    outputTokensDetails?: Record<string, number>;
  }>;
}

export interface UsageEvidence {
  responses: number;
  responsesWithRawUsage: number;
  rawUsage: Record<string, unknown>[];
}

export interface NormalizedUsage {
  reportingStatus: UsageReportingStatus;
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  inputTokensDetails: Record<string, number>[];
  outputTokensDetails: Record<string, number>[];
  requestUsageEntries: NonNullable<SdkUsage["requestUsageEntries"]>;
  rawUsage: Record<string, unknown>[];
}

interface StoredUsage extends Record<string, unknown> {
  reporting_status: UsageReportingStatus;
  requests: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  raw_json: {
    sdk?: {
      input_tokens_details?: Record<string, number>[];
      output_tokens_details?: Record<string, number>[];
      request_usage_entries?: NonNullable<SdkUsage["requestUsageEntries"]>;
    };
    provider?: Record<string, unknown>[];
  };
}

const nonNegativeInteger = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
};

export function normalizeUsage(
  usage: SdkUsage,
  evidence: UsageEvidence = {
    responses: 0,
    responsesWithRawUsage: 0,
    rawUsage: [],
  },
): NormalizedUsage {
  const requests = nonNegativeInteger(usage.requests);
  const inputTokens = nonNegativeInteger(usage.inputTokens);
  const outputTokens = nonNegativeInteger(usage.outputTokens);
  const totalTokens = nonNegativeInteger(usage.totalTokens);
  const hasNormalizedTokenEvidence =
    inputTokens > 0 || outputTokens > 0 || totalTokens > 0;

  let reportingStatus: UsageReportingStatus;
  if (evidence.responses > 0) {
    if (evidence.responsesWithRawUsage === evidence.responses)
      reportingStatus = "reported";
    else if (evidence.responsesWithRawUsage > 0) reportingStatus = "partial";
    else reportingStatus = hasNormalizedTokenEvidence ? "reported" : "missing";
  } else reportingStatus = hasNormalizedTokenEvidence ? "reported" : "missing";

  if (
    reportingStatus === "reported" &&
    totalTokens !== inputTokens + outputTokens
  )
    reportingStatus = "partial";

  const missing = reportingStatus === "missing";
  return {
    reportingStatus,
    requests,
    inputTokens: missing ? null : inputTokens,
    outputTokens: missing ? null : outputTokens,
    totalTokens: missing ? null : totalTokens,
    inputTokensDetails: usage.inputTokensDetails ?? [],
    outputTokensDetails: usage.outputTokensDetails ?? [],
    requestUsageEntries: usage.requestUsageEntries ?? [],
    rawUsage: evidence.rawUsage,
  };
}

export class UsageService {
  constructor(private readonly db: Database) {}

  async record(
    tx: SqlExecutor,
    input: {
      runId: string;
      provider: string;
      model: string;
      usage: SdkUsage;
      evidence?: UsageEvidence;
    },
  ) {
    const current = normalizeUsage(input.usage, input.evidence);
    const previous = (
      await tx.query<StoredUsage>(
        "SELECT * FROM usage_records WHERE run_id=$1 FOR UPDATE",
        [input.runId],
      )
    ).rows[0];
    const previousSdk = previous?.raw_json?.sdk ?? {};
    const mergedStatus: UsageReportingStatus = !previous
      ? current.reportingStatus
      : previous.reporting_status === current.reportingStatus
        ? current.reportingStatus
        : "partial";
    const addTokens = (
      before: number | null | undefined,
      after: number | null,
    ) => {
      if (before === null && after === null) return null;
      return nonNegativeInteger(before) + nonNegativeInteger(after);
    };
    const normalized: NormalizedUsage = previous
      ? {
          reportingStatus: mergedStatus,
          requests: nonNegativeInteger(previous.requests) + current.requests,
          inputTokens: addTokens(previous.input_tokens, current.inputTokens),
          outputTokens: addTokens(previous.output_tokens, current.outputTokens),
          totalTokens: addTokens(previous.total_tokens, current.totalTokens),
          inputTokensDetails: [
            ...(previousSdk.input_tokens_details ?? []),
            ...current.inputTokensDetails,
          ],
          outputTokensDetails: [
            ...(previousSdk.output_tokens_details ?? []),
            ...current.outputTokensDetails,
          ],
          requestUsageEntries: [
            ...(previousSdk.request_usage_entries ?? []),
            ...current.requestUsageEntries,
          ],
          rawUsage: [
            ...(previous.raw_json?.provider ?? []),
            ...current.rawUsage,
          ],
        }
      : current;
    const raw = {
      sdk: {
        requests: normalized.requests,
        input_tokens: normalized.inputTokens,
        output_tokens: normalized.outputTokens,
        total_tokens: normalized.totalTokens,
        input_tokens_details: normalized.inputTokensDetails,
        output_tokens_details: normalized.outputTokensDetails,
        request_usage_entries: normalized.requestUsageEntries,
      },
      provider: normalized.rawUsage,
    };
    const usage = await required<Record<string, unknown>>(
      tx,
      `INSERT INTO usage_records(id,run_id,model,provider,reporting_status,requests,input_tokens,output_tokens,total_tokens,raw_json)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT (run_id) DO UPDATE SET
         model=EXCLUDED.model,provider=EXCLUDED.provider,reporting_status=EXCLUDED.reporting_status,
         requests=EXCLUDED.requests,input_tokens=EXCLUDED.input_tokens,output_tokens=EXCLUDED.output_tokens,
         total_tokens=EXCLUDED.total_tokens,raw_json=EXCLUDED.raw_json,updated_at=now()
       RETURNING *`,
      [
        newId(),
        input.runId,
        input.model,
        input.provider,
        normalized.reportingStatus,
        normalized.requests,
        normalized.inputTokens,
        normalized.outputTokens,
        normalized.totalTokens,
        JSON.stringify(raw),
      ],
    );
    const summary = {
      reporting_status: normalized.reportingStatus,
      requests: normalized.requests,
      input_tokens: normalized.inputTokens,
      output_tokens: normalized.outputTokens,
      total_tokens: normalized.totalTokens,
      input_tokens_details: normalized.inputTokensDetails,
      output_tokens_details: normalized.outputTokensDetails,
      request_usage_entries: normalized.requestUsageEntries,
    };
    await tx.query("UPDATE runs SET usage_json=$2::jsonb WHERE id=$1", [
      input.runId,
      JSON.stringify(summary),
    ]);
    return { usage, summary };
  }

  async forRun(runId: string) {
    return (
      await this.db.query(
        "SELECT * FROM usage_records WHERE run_id=$1 ORDER BY created_at",
        [runId],
      )
    ).rows;
  }
}
