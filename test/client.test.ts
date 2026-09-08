import { describe, expect, it, vi } from "vitest";
import {
  OmoikaneClient,
  isModelReasoningMetadataCompletedEvent,
  isModelReasoningMetadataEvent,
  isModelReasoningMetadataProgressEvent,
  isModelReasoningMetadataStartedEvent,
  isModelReasoningSummaryCompletedEvent,
  isModelReasoningSummaryDeltaEvent,
  type RuntimeEvent,
} from "../src/client/index.js";

describe("OmoikaneClient integration contract", () => {
  it("narrows stable reasoning-summary Events", () => {
    const base = {
      schema_version: 1,
      id: "event-1",
      run_id: "run-1",
      seq: 1,
      time: new Date(0).toISOString(),
    };
    const delta: RuntimeEvent = {
      ...base,
      type: "model.reasoning_summary_delta",
      data: { delta: "summary" },
    };
    const completed: RuntimeEvent = {
      ...base,
      type: "model.reasoning_summary_completed",
      data: { text: "summary" },
    };
    const metadata: RuntimeEvent[] = [
      "model.reasoning_metadata_started",
      "model.reasoning_metadata_progress",
      "model.reasoning_metadata_completed",
    ].map((type, index) => ({
      ...base,
      id: `metadata-${index}`,
      type,
      data: {},
    }));

    expect(isModelReasoningSummaryDeltaEvent(delta)).toBe(true);
    expect(isModelReasoningSummaryCompletedEvent(delta)).toBe(false);
    expect(isModelReasoningSummaryCompletedEvent(completed)).toBe(true);
    expect(isModelReasoningMetadataStartedEvent(metadata[0]!)).toBe(true);
    expect(isModelReasoningMetadataProgressEvent(metadata[1]!)).toBe(true);
    expect(isModelReasoningMetadataCompletedEvent(metadata[2]!)).toBe(true);
    expect(metadata.every(isModelReasoningMetadataEvent)).toBe(true);
  });

  it("fetches a Run reasoning-metadata aggregate", async () => {
    let request: Request | undefined;
    const fetcher: typeof fetch = vi.fn(async (input, init) => {
      request = new Request(input, init);
      return Response.json({
        run_id: "run/1",
        raw_reasoning_observed: false,
        public_summary_observed: false,
        provider_reasoning_tokens: null,
        content_available: false,
        content_persisted: false,
        attempts: [],
      });
    });
    const client = new OmoikaneClient({
      baseUrl: "http://runtime.test",
      fetch: fetcher,
    });

    const result = await client.getReasoningMetadata("run/1");

    expect(request?.url).toBe(
      "http://runtime.test/v1/runs/run%2F1/reasoning-metadata",
    );
    expect(result.raw_reasoning_observed).toBe(false);
  });

  it("requires and forwards a caller-owned Run idempotency key", async () => {
    let request: Request | undefined;
    const fetcher: typeof fetch = vi.fn(async (input, init) => {
      request = new Request(input, init);
      return Response.json({ id: "run-1" }, { status: 202 });
    });
    const client = new OmoikaneClient({
      baseUrl: "http://runtime.test",
      fetch: fetcher,
    });

    expect(() =>
      client.createRun(
        { deployment_id: "deployment-1", input: "hello" },
        undefined as never,
      ),
    ).toThrow("requires an idempotencyKey");

    await client.createRun(
      { deployment_id: "deployment-1", input: "hello" },
      { idempotencyKey: "business-message-42" },
    );
    expect(request?.headers.get("idempotency-key")).toBe("business-message-42");
  });

  it("applies scoped request IDs and bounded timeouts", async () => {
    let observedRequestId: string | null = null;
    const successful: typeof fetch = vi.fn(async (input, init) => {
      const request = new Request(input, init);
      observedRequestId = request.headers.get("x-request-id");
      return Response.json({ status: "ok" });
    });
    const base = new OmoikaneClient({
      baseUrl: "http://runtime.test",
      fetch: successful,
    });
    await base.withOptions({ requestId: "business-request-7" }).health();
    expect(observedRequestId).toBe("business-request-7");

    const hanging: typeof fetch = vi.fn(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const bounded = new OmoikaneClient({
      baseUrl: "http://runtime.test",
      fetch: hanging,
      timeoutMs: 5,
      requestId: "timed-request",
    });
    await expect(bounded.health()).rejects.toEqual(
      expect.objectContaining({
        code: "client_timeout",
        status: 408,
        requestId: "timed-request",
      }),
    );
  });
});
