import { randomUUID } from "node:crypto";
import type { AgentInputItem } from "@openai/agents";
import { estimateItemsTokens } from "./token-meter.js";

export type CompactionProbeMode = "exact" | "contains";

export interface CompactionEvaluationProbe {
  id: string;
  prompt: string;
  mode: CompactionProbeMode;
  expected_answers?: string[];
  required_values?: string[];
  forbidden_values?: string[];
  critical: boolean;
  case_sensitive?: boolean;
  tags: string[];
}

export interface CompactionEvaluationCase {
  id: string;
  description: string;
  tags: string[];
  items: AgentInputItem[];
  probes: CompactionEvaluationProbe[];
}

export interface CompactionEvaluationCorpus {
  schema_version: 1;
  corpus_version: string;
  description: string;
  cases: CompactionEvaluationCase[];
}

export interface CompactionEvaluationSubject {
  provider: string;
  model: string;
  protocol: string;
  strategy: "native" | "portable";
  projection_version: number;
  runtime_version?: string;
  sdk_version?: string;
}

export interface CompactionEvaluationThresholds {
  critical_fact_recall: number;
  exact_value_recall: number;
  constraint_retention: number;
  task_success_rate: number;
  false_fact_rate: number;
  stale_fact_rate: number;
  max_generation_score_drop: number;
}

export const DEFAULT_COMPACTION_EVALUATION_THRESHOLDS: CompactionEvaluationThresholds =
  {
    critical_fact_recall: 0.99,
    exact_value_recall: 1,
    constraint_retention: 1,
    task_success_rate: 0.95,
    false_fact_rate: 0,
    stale_fact_rate: 0,
    max_generation_score_drop: 0.02,
  };

export interface CompactionProbeScore {
  case_id: string;
  probe_id: string;
  passed: boolean;
  critical: boolean;
  answer: string;
  expected_units: number;
  retained_units: number;
  false_fact: boolean;
  stale_fact: boolean;
  missing_values: string[];
  matched_forbidden_values: string[];
  tags: string[];
}

export interface CompactionEvaluationMetrics {
  probe_count: number;
  passed_probe_count: number;
  task_success_rate: number;
  critical_fact_recall: number;
  exact_value_recall: number;
  constraint_retention: number;
  false_fact_rate: number;
  stale_fact_rate: number;
  per_tag_success_rate: Record<string, number>;
}

export interface CompactionEvaluationReport {
  schema_version: 1;
  evaluation_id: string;
  created_at: string;
  corpus_version: string;
  subject: CompactionEvaluationSubject;
  generation: number;
  estimated_source_tokens?: number;
  tokens_before?: number;
  tokens_after?: number;
  compression_ratio?: number;
  compaction_metrics?: Record<string, unknown>;
  thresholds: CompactionEvaluationThresholds;
  metrics: CompactionEvaluationMetrics;
  status: "passed" | "failed";
  failures: string[];
  probes: CompactionProbeScore[];
}

export interface CompactionEvaluationSuiteReport {
  schema_version: 1;
  corpus_version: string;
  subject: CompactionEvaluationSubject;
  status: "passed" | "failed";
  max_observed_task_score_drop: number;
  failures: string[];
  generations: CompactionEvaluationReport[];
}

export interface CompactionSemanticRisk {
  assurance: "degraded" | "insufficient";
  risk_reasons: string[];
  recommended_action:
    | "continue_with_business_validation"
    | "request_source_items"
    | "start_fresh_run";
  evaluation_key: {
    provider: string;
    model: string;
    protocol: string;
    strategy: "native" | "portable";
    projection_version: 4;
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyStrings(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim())
  )
    throw new Error(`${field} must be an array of non-empty strings`);
  return value.map((item) => String(item));
}

export function validateCompactionEvaluationCorpus(
  value: unknown,
): CompactionEvaluationCorpus {
  const corpus = asRecord(value);
  if (
    corpus?.schema_version !== 1 ||
    typeof corpus.corpus_version !== "string" ||
    !corpus.corpus_version ||
    typeof corpus.description !== "string" ||
    !Array.isArray(corpus.cases) ||
    !corpus.cases.length
  )
    throw new Error("invalid compaction evaluation corpus envelope");
  const caseIds = new Set<string>();
  const probeIds = new Set<string>();
  for (const rawCase of corpus.cases) {
    const evaluationCase = asRecord(rawCase);
    if (
      !evaluationCase ||
      typeof evaluationCase.id !== "string" ||
      !evaluationCase.id ||
      typeof evaluationCase.description !== "string" ||
      !Array.isArray(evaluationCase.items) ||
      !evaluationCase.items.length ||
      !Array.isArray(evaluationCase.probes) ||
      !evaluationCase.probes.length
    )
      throw new Error("invalid compaction evaluation case");
    if (caseIds.has(evaluationCase.id))
      throw new Error(`duplicate compaction evaluation case: ${evaluationCase.id}`);
    caseIds.add(evaluationCase.id);
    nonEmptyStrings(evaluationCase.tags, `${evaluationCase.id}.tags`);
    for (const rawProbe of evaluationCase.probes) {
      const probe = asRecord(rawProbe);
      if (
        !probe ||
        typeof probe.id !== "string" ||
        !probe.id ||
        typeof probe.prompt !== "string" ||
        !probe.prompt ||
        !["exact", "contains"].includes(String(probe.mode)) ||
        typeof probe.critical !== "boolean"
      )
        throw new Error(`invalid probe in case ${evaluationCase.id}`);
      if (probeIds.has(probe.id))
        throw new Error(`duplicate compaction evaluation probe: ${probe.id}`);
      probeIds.add(probe.id);
      const expected = probe.expected_answers
        ? nonEmptyStrings(probe.expected_answers, `${probe.id}.expected_answers`)
        : [];
      const required = probe.required_values
        ? nonEmptyStrings(probe.required_values, `${probe.id}.required_values`)
        : [];
      if (
        (probe.mode === "exact" && !expected.length) ||
        (probe.mode === "contains" && !required.length)
      )
        throw new Error(`probe ${probe.id} has no scorable expected value`);
      if (probe.forbidden_values)
        nonEmptyStrings(probe.forbidden_values, `${probe.id}.forbidden_values`);
      nonEmptyStrings(probe.tags, `${probe.id}.tags`);
    }
  }
  return value as CompactionEvaluationCorpus;
}

const comparable = (value: string, caseSensitive: boolean): string => {
  const normalized = value.replace(/\s+/g, " ").trim();
  return caseSensitive ? normalized : normalized.toLocaleLowerCase("en-US");
};

function ratio(numerator: number, denominator: number, empty = 1): number {
  return denominator ? numerator / denominator : empty;
}

export function scoreCompactionEvaluation(
  corpus: CompactionEvaluationCorpus,
  answers: Record<string, unknown>,
  subject: CompactionEvaluationSubject,
  options: {
    generation?: number;
    thresholds?: Partial<CompactionEvaluationThresholds>;
    estimatedSourceTokens?: number;
    tokensBefore?: number;
    tokensAfter?: number;
    createdAt?: string;
    evaluationId?: string;
    compactionMetrics?: Record<string, unknown>;
  } = {},
): CompactionEvaluationReport {
  validateCompactionEvaluationCorpus(corpus);
  const thresholds = {
    ...DEFAULT_COMPACTION_EVALUATION_THRESHOLDS,
    ...options.thresholds,
  };
  const scores: CompactionProbeScore[] = [];
  for (const evaluationCase of corpus.cases) {
    for (const probe of evaluationCase.probes) {
      const rawAnswer = answers[probe.id];
      const answer = typeof rawAnswer === "string" ? rawAnswer : "";
      const caseSensitive = probe.case_sensitive ?? true;
      const normalizedAnswer = comparable(answer, caseSensitive);
      const expected = (probe.expected_answers ?? []).map((value) =>
        comparable(value, caseSensitive),
      );
      const required = (probe.required_values ?? []).map((value) =>
        comparable(value, caseSensitive),
      );
      const forbidden = (probe.forbidden_values ?? []).map((value) => ({
        original: value,
        comparable: comparable(value, caseSensitive),
      }));
      const matchedForbidden = forbidden
        .filter((value) => normalizedAnswer.includes(value.comparable))
        .map((value) => value.original);
      const exactMatch = expected.includes(normalizedAnswer);
      const missingValues = (probe.required_values ?? []).filter(
        (_value, index) => !normalizedAnswer.includes(required[index]!),
      );
      const retained =
        probe.mode === "exact"
          ? exactMatch
            ? 1
            : 0
          : required.length - missingValues.length;
      const expectedUnits = probe.mode === "exact" ? 1 : required.length;
      const passed =
        matchedForbidden.length === 0 &&
        (probe.mode === "exact" ? exactMatch : missingValues.length === 0);
      const staleFact =
        probe.tags.includes("state_transition") && matchedForbidden.length > 0;
      const falseFact =
        matchedForbidden.length > 0 ||
        (probe.mode === "exact" && Boolean(answer) && !exactMatch);
      scores.push({
        case_id: evaluationCase.id,
        probe_id: probe.id,
        passed,
        critical: probe.critical,
        answer,
        expected_units: expectedUnits,
        retained_units: retained,
        false_fact: falseFact,
        stale_fact: staleFact,
        missing_values: missingValues,
        matched_forbidden_values: matchedForbidden,
        tags: [...new Set([...evaluationCase.tags, ...probe.tags])],
      });
    }
  }
  const critical = scores.filter((score) => score.critical);
  const exactValues = scores.filter((score) => score.tags.includes("identifier"));
  const constraints = scores.filter((score) => score.tags.includes("constraint"));
  const stateTransitions = scores.filter((score) =>
    score.tags.includes("state_transition"),
  );
  const retainedRatio = (selected: CompactionProbeScore[]) =>
    ratio(
      selected.reduce((sum, score) => sum + score.retained_units, 0),
      selected.reduce((sum, score) => sum + score.expected_units, 0),
    );
  const tags = [...new Set(scores.flatMap((score) => score.tags))].sort();
  const metrics: CompactionEvaluationMetrics = {
    probe_count: scores.length,
    passed_probe_count: scores.filter((score) => score.passed).length,
    task_success_rate: ratio(
      scores.filter((score) => score.passed).length,
      scores.length,
    ),
    critical_fact_recall: retainedRatio(critical),
    exact_value_recall: retainedRatio(exactValues),
    constraint_retention: retainedRatio(constraints),
    false_fact_rate: ratio(
      scores.filter((score) => score.false_fact).length,
      scores.length,
      0,
    ),
    stale_fact_rate: ratio(
      stateTransitions.filter((score) => score.stale_fact).length,
      stateTransitions.length,
      0,
    ),
    per_tag_success_rate: Object.fromEntries(
      tags.map((tag) => {
        const selected = scores.filter((score) => score.tags.includes(tag));
        return [
          tag,
          ratio(
            selected.filter((score) => score.passed).length,
            selected.length,
          ),
        ];
      }),
    ),
  };
  const failures: string[] = [];
  const minimums = [
    "critical_fact_recall",
    "exact_value_recall",
    "constraint_retention",
    "task_success_rate",
  ] as const;
  for (const key of minimums)
    if (metrics[key] < thresholds[key])
      failures.push(`${key} ${metrics[key].toFixed(4)} < ${thresholds[key].toFixed(4)}`);
  const maximums = ["false_fact_rate", "stale_fact_rate"] as const;
  for (const key of maximums)
    if (metrics[key] > thresholds[key])
      failures.push(`${key} ${metrics[key].toFixed(4)} > ${thresholds[key].toFixed(4)}`);
  const tokensBefore = options.tokensBefore;
  const tokensAfter = options.tokensAfter;
  return {
    schema_version: 1,
    evaluation_id: options.evaluationId ?? randomUUID(),
    created_at: options.createdAt ?? new Date().toISOString(),
    corpus_version: corpus.corpus_version,
    subject,
    generation: options.generation ?? 1,
    estimated_source_tokens: options.estimatedSourceTokens,
    tokens_before: tokensBefore,
    tokens_after: tokensAfter,
    compression_ratio:
      tokensBefore && tokensAfter !== undefined
        ? tokensAfter / tokensBefore
        : undefined,
    compaction_metrics: options.compactionMetrics,
    thresholds,
    metrics,
    status: failures.length ? "failed" : "passed",
    failures,
    probes: scores,
  };
}

export function qualifyCompactionEvaluationReports(
  reports: CompactionEvaluationReport[],
): CompactionEvaluationSuiteReport {
  if (!reports.length)
    throw new Error("at least one compaction evaluation report is required");
  const ordered = [...reports].sort((a, b) => a.generation - b.generation);
  const subject = ordered[0]!.subject;
  if (
    ordered.some(
      (report) =>
        JSON.stringify(report.subject) !== JSON.stringify(subject) ||
        report.corpus_version !== ordered[0]!.corpus_version,
    )
  )
    throw new Error("compaction evaluation reports are not comparable");
  let maximumDrop = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!.metrics.task_success_rate;
    const current = ordered[index]!.metrics.task_success_rate;
    maximumDrop = Math.max(maximumDrop, previous - current);
  }
  const failures = ordered.flatMap((report) =>
    report.failures.map((failure) => `generation ${report.generation}: ${failure}`),
  );
  const allowedDrop = ordered[0]!.thresholds.max_generation_score_drop;
  if (maximumDrop > allowedDrop)
    failures.push(
      `generation task score drop ${maximumDrop.toFixed(4)} > ${allowedDrop.toFixed(4)}`,
    );
  return {
    schema_version: 1,
    corpus_version: ordered[0]!.corpus_version,
    subject,
    status: failures.length ? "failed" : "passed",
    max_observed_task_score_drop: maximumDrop,
    failures,
    generations: ordered,
  };
}

export function buildCompactionEvaluationConversation(
  corpus: CompactionEvaluationCorpus,
  targetEstimatedTokens = 48_000,
): AgentInputItem[] {
  validateCompactionEvaluationCorpus(corpus);
  const base = corpus.cases.flatMap((evaluationCase) => evaluationCase.items);
  const missing = Math.max(0, targetEstimatedTokens - estimateItemsTokens(base));
  const perCaseBytes = Math.ceil((missing * 3) / corpus.cases.length);
  const sentence =
    "Bounded irrelevant archive material for compaction evaluation; it contains no task facts. ";
  const padding = sentence.repeat(Math.max(1, Math.ceil(perCaseBytes / sentence.length)));
  return corpus.cases.flatMap((evaluationCase, index) => [
    ...evaluationCase.items,
    {
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: `Archive segment ${index + 1}/${corpus.cases.length}. ${padding}`,
        },
      ],
    } as AgentInputItem,
  ]);
}

export function renderCompactionEvaluationPrompt(
  corpus: CompactionEvaluationCorpus,
): string {
  validateCompactionEvaluationCorpus(corpus);
  const lines = corpus.cases.flatMap((evaluationCase) =>
    evaluationCase.probes.map(
      (probe) =>
        `${probe.id}: ${probe.prompt} Store the answer as a JSON string in answers.${probe.id}.`,
    ),
  );
  return [
    "Answer every evaluation probe using only the supplied conversation context.",
    "Follow each probe's requested canonical form exactly. Do not explain answers.",
    ...lines,
  ].join("\n");
}

export function compactionEvaluationOutputSchema(
  corpus: CompactionEvaluationCorpus,
): Record<string, unknown> {
  validateCompactionEvaluationCorpus(corpus);
  const probeIds = corpus.cases.flatMap((evaluationCase) =>
    evaluationCase.probes.map((probe) => probe.id),
  );
  return {
    type: "object",
    properties: {
      answers: {
        type: "object",
        properties: Object.fromEntries(
          probeIds.map((probeId) => [probeId, { type: "string" }]),
        ),
        required: probeIds,
        additionalProperties: false,
      },
    },
    required: ["answers"],
    additionalProperties: false,
  };
}

export function compactionSemanticRisk(input: {
  provider: string;
  model: string;
  protocol: string;
  strategy: "native" | "portable";
  generation: number;
  additionalRiskReasons?: string[];
}): CompactionSemanticRisk {
  const generation = Math.max(1, Math.floor(input.generation));
  const reasons = [
    input.strategy === "native"
      ? "opaque_provider_checkpoint"
      : "lossy_model_generated_checkpoint",
    "semantic_evaluation_is_release_evidence_not_online_proof",
  ];
  if (generation > 1) reasons.push("repeated_compaction_can_accumulate_loss");
  reasons.push(...(input.additionalRiskReasons ?? []));
  const evidenceCapacityExceeded = reasons.includes(
    "deterministic_evidence_capacity_exceeded",
  );
  return {
    assurance:
      generation > 3 || evidenceCapacityExceeded ? "insufficient" : "degraded",
    risk_reasons: [...new Set(reasons)],
    recommended_action:
      generation > 3
        ? "start_fresh_run"
        : generation > 1 || evidenceCapacityExceeded
          ? "request_source_items"
          : "continue_with_business_validation",
    evaluation_key: {
      provider: input.provider,
      model: input.model,
      protocol: input.protocol,
      strategy: input.strategy,
      projection_version: 4,
    },
  };
}
