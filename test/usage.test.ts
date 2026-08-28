import { describe, expect, it } from "vitest";
import { Usage } from "@openai/agents";
import { normalizeUsage } from "../src/usage.js";

describe("Usage normalization", () => {
  it("preserves Provider-reported token counts and details", () => {
    const normalized = normalizeUsage(
      new Usage({
        requests: 1,
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
        inputTokensDetails: [{ cached_tokens: 40 }],
        outputTokensDetails: [{ reasoning_tokens: 10 }],
        requestUsageEntries: [
          {
            endpoint: "responses.create",
            inputTokens: 120,
            outputTokens: 30,
            totalTokens: 150,
          },
        ],
      }),
      {
        responses: 1,
        responsesWithRawUsage: 1,
        rawUsage: [{ input_tokens: 120, output_tokens: 30, total_tokens: 150 }],
      },
    );

    expect(normalized).toMatchObject({
      reportingStatus: "reported",
      requests: 1,
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      inputTokensDetails: [{ cached_tokens: 40 }],
      outputTokensDetails: [{ reasoning_tokens: 10 }],
    });
  });

  it("uses null rather than zero when a Provider omits Usage", () => {
    const normalized = normalizeUsage(new Usage({ requests: 1 }), {
      responses: 1,
      responsesWithRawUsage: 0,
      rawUsage: [],
    });

    expect(normalized).toMatchObject({
      reportingStatus: "missing",
      requests: 1,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
  });

  it("marks mixed per-response reporting as partial", () => {
    const normalized = normalizeUsage(
      new Usage({
        requests: 2,
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
      }),
      {
        responses: 2,
        responsesWithRawUsage: 1,
        rawUsage: [{ input_tokens: 80, output_tokens: 20, total_tokens: 100 }],
      },
    );

    expect(normalized.reportingStatus).toBe("partial");
    expect(normalized.totalTokens).toBe(100);
  });

  it("accepts normalized token evidence from adapters without raw Usage", () => {
    const normalized = normalizeUsage(
      new Usage({
        requests: 1,
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
      }),
      { responses: 1, responsesWithRawUsage: 0, rawUsage: [] },
    );

    expect(normalized.reportingStatus).toBe("reported");
    expect(normalized.totalTokens).toBe(20);
  });
});
