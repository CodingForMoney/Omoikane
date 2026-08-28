import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildCompactionEvaluationConversation,
  compactionEvaluationOutputSchema,
  compactionSemanticRisk,
  qualifyCompactionEvaluationReports,
  scoreCompactionEvaluation,
  validateCompactionEvaluationCorpus,
  type CompactionEvaluationCorpus,
  type CompactionEvaluationSubject,
} from "../src/compaction.js";
import { estimateItemsTokens } from "../src/compaction/token-meter.js";

let corpus: CompactionEvaluationCorpus;
const subject: CompactionEvaluationSubject = {
  provider: "xiaomi_mimo",
  model: "mimo-v2.5",
  protocol: "responses",
  strategy: "portable",
  projection_version: 4,
  runtime_version: "test",
  sdk_version: "test",
};

const correctAnswers = (value: CompactionEvaluationCorpus) =>
  Object.fromEntries(
    value.cases.flatMap((evaluationCase) =>
      evaluationCase.probes.map((probe) => [
        probe.id,
        probe.mode === "exact"
          ? probe.expected_answers![0]!
          : probe.required_values!.join(" | "),
      ]),
    ),
  );

beforeAll(async () => {
  corpus = validateCompactionEvaluationCorpus(
    JSON.parse(
      await readFile(resolve("evals/compaction/corpus-v1.json"), "utf8"),
    ),
  );
});

describe("context compaction semantic evaluation", () => {
  it("validates a broad versioned corpus and builds distributed long input", () => {
    expect(corpus.cases.length).toBeGreaterThanOrEqual(16);
    const tags = [...new Set(corpus.cases.flatMap((entry) => entry.tags))];
    expect(tags).toEqual(
      expect.arrayContaining([
        "multilingual",
        "adversarial",
        "code",
        "tool",
        "state_transition",
      ]),
    );
    const conversation = buildCompactionEvaluationConversation(corpus, 48_000);
    expect(estimateItemsTokens(conversation)).toBeGreaterThanOrEqual(47_000);
    expect(JSON.stringify(conversation)).toContain("019fa37d-d1a4");
    expect(JSON.stringify(conversation)).toContain("call-health-52");
    const schema = compactionEvaluationOutputSchema(corpus) as {
      properties: { answers: { required: string[] } };
    };
    expect(schema.properties.answers.required).toHaveLength(
      corpus.cases.flatMap((entry) => entry.probes).length,
    );
  });

  it("passes only when deterministic critical, constraint, and false-fact gates pass", () => {
    const report = scoreCompactionEvaluation(
      corpus,
      correctAnswers(corpus),
      subject,
      { createdAt: "2026-08-28T00:00:00.000Z", evaluationId: "eval-pass" },
    );
    expect(report).toMatchObject({
      status: "passed",
      metrics: {
        critical_fact_recall: 1,
        exact_value_recall: 1,
        constraint_retention: 1,
        task_success_rate: 1,
        false_fact_rate: 0,
        stale_fact_rate: 0,
      },
    });
  });

  it("detects stale state, invented absent facts, and missing exact values", () => {
    const answers = correctAnswers(corpus);
    answers.rollout_state = "PAUSED";
    answers.cloud_region = "us-east-1";
    answers.incident_uuid = "invented-id";
    const report = scoreCompactionEvaluation(corpus, answers, subject, {
      evaluationId: "eval-fail",
    });
    expect(report.status).toBe("failed");
    expect(report.metrics.stale_fact_rate).toBeGreaterThan(0);
    expect(report.metrics.false_fact_rate).toBeGreaterThan(0);
    expect(report.metrics.exact_value_recall).toBeLessThan(1);
    expect(
      report.probes.find((probe) => probe.probe_id === "rollout_state"),
    ).toMatchObject({
      passed: false,
      stale_fact: true,
      matched_forbidden_values: ["PAUSED"],
    });
  });

  it("rejects multi-generation regression and emits explainable runtime risk", () => {
    const first = scoreCompactionEvaluation(
      corpus,
      correctAnswers(corpus),
      subject,
      { generation: 1, evaluationId: "eval-generation-1" },
    );
    const degradedAnswers = correctAnswers(corpus);
    degradedAnswers.otlp_status = "COMPLETED";
    const second = scoreCompactionEvaluation(
      corpus,
      degradedAnswers,
      subject,
      {
        generation: 2,
        evaluationId: "eval-generation-2",
        thresholds: { task_success_rate: 0.9, false_fact_rate: 0.1 },
      },
    );
    const comparableSecond = {
      ...second,
      thresholds: first.thresholds,
      subject: first.subject,
    };
    const suite = qualifyCompactionEvaluationReports([
      first,
      comparableSecond,
    ]);
    expect(suite.status).toBe("failed");
    expect(suite.max_observed_task_score_drop).toBeGreaterThan(0.02);
    expect(
      compactionSemanticRisk({
        provider: "xiaomi_mimo",
        model: "mimo-v2.5",
        protocol: "responses",
        strategy: "portable",
        generation: 4,
      }),
    ).toMatchObject({
      assurance: "insufficient",
      recommended_action: "start_fresh_run",
      risk_reasons: expect.arrayContaining([
        "repeated_compaction_can_accumulate_loss",
      ]),
    });
    expect(
      compactionSemanticRisk({
        provider: "xiaomi_mimo",
        model: "mimo-v2.5",
        protocol: "responses",
        strategy: "portable",
        generation: 1,
        additionalRiskReasons: [
          "deterministic_evidence_capacity_exceeded",
        ],
      }),
    ).toMatchObject({
      assurance: "insufficient",
      recommended_action: "request_source_items",
    });
  });
});
