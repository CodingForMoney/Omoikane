import { describe, expect, it, vi } from "vitest";
import { OmoikaneClient } from "../src/client/index.js";

describe("OmoikaneClient integration contract", () => {
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
