import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/api.js";
import { sseRetryDelay } from "../src/client/index.js";
import type { Container } from "../src/container.js";
import { publishedAgent, testContainer } from "./helpers.js";

let app: FastifyInstance | undefined;
let container: Container | undefined;
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await app?.close();
  await cleanup?.();
  app = undefined;
  container = undefined;
  cleanup = undefined;
});

describe("pagination and local SSE bounds", () => {
  it("lists stable lightweight Run pages with scoped filters", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const fixture = await publishedAgent(container);
    const original = [];
    for (let index = 0; index < 5; index += 1)
      original.push(
        await container.runner.create({
          deploymentId: fixture.version.id,
          externalSessionId: index % 2 ? "business-b" : "business-a",
          input: `RUN_INPUT_SECRET_${index}`,
          context: { protected: `RUN_CONTEXT_SECRET_${index}` },
        }),
      );
    await container.db.query(
      "UPDATE runs SET created_at=$1,updated_at=$1 WHERE id=ANY($2::text[])",
      ["2020-01-01T00:00:00.000Z", original.map((run) => run.id)],
    );
    app = await createApp(container);

    const first = await app.inject({ method: "GET", url: "/v1/runs?limit=2" });
    expect(first.statusCode).toBe(200);
    const firstPage = first.json() as {
      data: Array<Record<string, unknown>>;
      next_cursor: string | null;
    };
    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.next_cursor).toEqual(expect.any(String));

    const insertedLater = await container.runner.create({
      deploymentId: fixture.version.id,
      externalSessionId: "business-a",
      input: "RUN_LATE_INSERT_SECRET",
    });
    const collected = [...firstPage.data];
    let cursor = firstPage.next_cursor;
    while (cursor) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/runs?limit=2&cursor=${encodeURIComponent(cursor)}`,
      });
      expect(response.statusCode).toBe(200);
      const page = response.json() as typeof firstPage;
      collected.push(...page.data);
      cursor = page.next_cursor;
    }

    const expected = original
      .map((run) => run.id)
      .sort()
      .reverse();
    expect(collected.map((run) => run.id)).toEqual(expected);
    expect(new Set(collected.map((run) => run.id)).size).toBe(5);
    expect(collected.map((run) => run.id)).not.toContain(insertedLater.id);
    const encoded = JSON.stringify(collected);
    expect(encoded).not.toContain("RUN_INPUT_SECRET");
    expect(encoded).not.toContain("RUN_CONTEXT_SECRET");
    for (const row of collected) {
      expect(row).not.toHaveProperty("input_json");
      expect(row).not.toHaveProperty("output_json");
      expect(row).not.toHaveProperty("context_json");
      expect(row).not.toHaveProperty("conversation_json");
      expect(row).not.toHaveProperty("new_items_json");
      expect(row).not.toHaveProperty("error_json");
    }

    const filtered = await app.inject({
      method: "GET",
      url: "/v1/runs?external_session_id=business-a&status=queued&limit=20",
    });
    expect(filtered.statusCode).toBe(200);
    expect(
      (filtered.json().data as Array<Record<string, unknown>>).every(
        (run) =>
          run.external_session_id === "business-a" && run.status === "queued",
      ),
    ).toBe(true);

    const incompatible = await app.inject({
      method: "GET",
      url: `/v1/runs?status=queued&cursor=${encodeURIComponent(firstPage.next_cursor!)}`,
    });
    expect(incompatible.statusCode).toBe(422);
    const malformed = await app.inject({
      method: "GET",
      url: "/v1/runs?cursor=not-a-cursor",
    });
    expect(malformed.statusCode).toBe(422);
  });

  it("paginates Provider resources without exposing stored credentials", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    for (let index = 0; index < 3; index += 1)
      await container.providers.create({
        name: `Provider ${index}`,
        provider: "xiaomi_mimo",
        api_key: `PROVIDER_PAGE_SECRET_${index}`,
      });
    app = await createApp(container);

    const first = await app.inject({
      method: "GET",
      url: "/v1/provider-connections?limit=2",
    });
    const firstPage = first.json() as {
      data: Array<Record<string, unknown>>;
      next_cursor: string | null;
    };
    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.next_cursor).toEqual(expect.any(String));
    const second = await app.inject({
      method: "GET",
      url: `/v1/provider-connections?limit=2&cursor=${encodeURIComponent(firstPage.next_cursor!)}`,
    });
    const all = [...firstPage.data, ...second.json().data];
    expect(all).toHaveLength(3);
    expect(JSON.stringify(all)).not.toContain("PROVIDER_PAGE_SECRET");
    expect(
      all.every((record) => !Object.hasOwn(record, "api_key_ciphertext")),
    ).toBe(true);
  });

  it("wakes Event waiters only after their transaction commits", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const fixture = await publishedAgent(container);
    const run = await container.runner.create({
      deploymentId: fixture.version.id,
      input: "event transaction",
    });
    const beforeRollback = container.events.revision(run.id);
    const rollbackWait = container.events.waitForChange(
      run.id,
      beforeRollback,
      50,
    );
    await expect(
      container.db.transaction(async (tx) => {
        await container!.events.appendInTransaction(
          tx,
          run.id,
          "test.rolled_back",
        );
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await rollbackWait).toBe(false);
    expect(container.events.revision(run.id)).toBe(beforeRollback);

    const beforeCommit = container.events.revision(run.id);
    const commitWait = container.events.waitForChange(
      run.id,
      beforeCommit,
      1_000,
    );
    await container.db.transaction(async (tx) => {
      await container!.events.appendInTransaction(tx, run.id, "test.committed");
    });
    expect(await commitWait).toBe(true);
    expect(container.events.revision(run.id)).toBe(beforeCommit + 1);
    expect(
      (await container.events.list(run.id)).map((event) => event.type),
    ).not.toContain("test.rolled_back");
  });

  it("caps SSE connections, wakes on commit, and releases capacity", async () => {
    const test = await testContainer({
      env: {
        OMOIKANE_SSE_MAX_CONNECTIONS: "1",
        OMOIKANE_SSE_MAX_CONNECTIONS_PER_RUN: "1",
        OMOIKANE_SSE_POLL_FALLBACK_MS: "5000",
        OMOIKANE_SSE_HEARTBEAT_SECONDS: "60",
      },
    });
    container = test.container;
    cleanup = test.close;
    const fixture = await publishedAgent(container);
    const run = await container.runner.create({
      deploymentId: fixture.version.id,
      input: "hold SSE open",
    });
    app = await createApp(container);

    const firstStream = app.inject({
      method: "GET",
      url: `/v1/runs/${run.id}/stream`,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const runtimeStatus = await app.inject({
      method: "GET",
      url: "/v1/runtime/status",
    });
    expect(runtimeStatus.json().sse_connections).toEqual({
      active: 1,
      maximum: 1,
      maximum_per_run: 1,
    });
    const rejected = await app.inject({
      method: "GET",
      url: `/v1/runs/${run.id}/stream`,
    });
    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers["retry-after"]).toBe("1");
    expect(rejected.json().error.code).toBe("too_many_requests");

    const cancelledAt = Date.now();
    await container.runner.cancel(run.id);
    const first = await firstStream;
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain("run.cancelled");
    expect(Date.now() - cancelledAt).toBeLessThan(2_000);

    const afterRelease = await app.inject({
      method: "GET",
      url: `/v1/runs/${run.id}/stream`,
    });
    expect(afterRelease.statusCode).toBe(200);
  }, 15_000);

  it("drains an Event committed between the SSE list and terminal status read", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const fixture = await publishedAgent(container);
    const run = await container.runner.create({
      deploymentId: fixture.version.id,
      input: "terminal SSE race",
    });
    const originalList = container.events.list.bind(container.events);
    let injectTerminalCommit = true;
    container.events.list = async (...args) => {
      const listed = await originalList(...args);
      if (injectTerminalCommit) {
        injectTerminalCommit = false;
        await container!.runner.cancel(run.id);
      }
      return listed;
    };
    app = await createApp(container);

    const response = await app.inject({
      method: "GET",
      url: `/v1/runs/${run.id}/stream`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: run.cancelled");
    expect(response.body).toContain('"cursor":2');
  });

  it("bounds exponential SSE retry delay with jitter", () => {
    expect(sseRetryDelay(0, () => 0.5)).toBe(500);
    expect(sseRetryDelay(1, () => 0.5)).toBe(1_000);
    expect(sseRetryDelay(4, () => 0.5)).toBe(5_000);
    expect(sseRetryDelay(100, () => 0)).toBe(4_000);
    expect(sseRetryDelay(100, () => 1)).toBe(5_000);
  });
});
