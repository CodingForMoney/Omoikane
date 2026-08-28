import { afterEach, describe, expect, it, vi } from "vitest";
import type { Container } from "../src/container.js";
import { ValidationError } from "../src/database.js";
import { OMOIKANE_VERSION } from "../src/runtime-versions.js";
import packageJson from "../package.json" with { type: "json" };
import { testContainer } from "./helpers.js";

let container: Container | undefined;
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  container = undefined;
  cleanup = undefined;
  vi.unstubAllGlobals();
});

describe("provider registry", () => {
  it("keeps the runtime and npm package versions aligned", () => {
    expect(OMOIKANE_VERSION).toBe(packageJson.version);
  });

  it("ships known context and reasoning capabilities", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const catalog = container.providers.catalog();
    expect(catalog.length).toBeGreaterThanOrEqual(25);
    const bridge = catalog.find((item) => item.id === "codex_bridge")!;
    expect(bridge.models[0]!.capabilities.context_window).toBe(258_400);
    expect(bridge.models[0]!.capabilities.context_compaction).toEqual({
      supported: true,
      method: "responses_compact",
    });
    const mimo = catalog.find((item) => item.id === "xiaomi_mimo")!;
    expect(
      mimo.models.find((item) => item.id === "mimo-v2.5")!.capabilities,
    ).toMatchObject({
      context_window: 1_048_576,
      context_compaction: { supported: false },
    });
  });

  it("maps supported effort and rejects it for unsupported models", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const mimo = await container.providers.create({
      name: "MiMo",
      provider: "xiaomi_mimo",
      api_key: "test-only-key",
    });
    const resolved = await container.providers.resolveConfig({
      provider: { connection_id: mimo.id },
      model: "mimo-v2.5",
      model_settings: { reasoning_effort: "high", max_tokens: 4096 },
    });
    expect(resolved.model_settings).toMatchObject({
      reasoning: { effort: "high" },
      maxTokens: 4096,
    });
    expect(resolved.model_context_window).toBe(1_048_576);

    const qwen = await container.providers.create({
      name: "Qwen",
      provider: "alibaba_qwen",
      api_key: "test-only-key",
    });
    await expect(
      container.providers.resolveConfig({
        provider: { connection_id: qwen.id },
        model: "qwen3.7-plus",
        model_settings: { reasoning_effort: "high" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects unknown endpoint profiles and known-Provider URL overrides without changing the connection", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const connection = await container.providers.create({
      name: "MiMo",
      provider: "xiaomi_mimo",
      api_key: "test-only-key",
    });

    await expect(
      container.providers.update(connection.id, {
        endpoint_profile: "does-not-exist",
      }),
    ).rejects.toThrow("unknown endpoint profile");
    await expect(
      container.providers.update(connection.id, {
        custom_base_url: "https://unexpected.example/v1",
      }),
    ).rejects.toThrow("only valid for custom_openai_compatible");

    const unchanged = await container.providers.get(connection.id);
    expect(unchanged).toMatchObject({
      base_url: "https://token-plan-cn.xiaomimimo.com/v1",
      protocol: "responses",
    });
  });

  it("distinguishes an empty remote list from catalog fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [], has_more: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const connection = await container.providers.create({
      name: "Anthropic",
      provider: "anthropic",
      api_key: "test-only-key",
    });

    const result = await container.providers.validate(connection.id);
    expect(result).toMatchObject({
      valid: true,
      discovery: {
        status: "empty",
        source: "catalog_fallback",
        remote_model_count: 0,
      },
    });
    const models = await container.providers.listModels(connection.id);
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((item) => item.source === "catalog")).toBe(true);
    expect(models.every((item) => item.remote_presence === "unknown")).toBe(
      true,
    );
  });

  it("marks disappeared models unavailable and reports a stale default", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: "claude-sonnet-4-6" }, { id: "retired-test-model" }],
            has_more: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: "claude-sonnet-4-6" }],
            has_more: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const connection = await container.providers.create({
      name: "Anthropic",
      provider: "anthropic",
      api_key: "test-only-key",
    });

    await container.providers.syncModels(connection.id);
    await container.providers.update(connection.id, {
      default_model: "retired-test-model",
    });
    await container.providers.syncModels(connection.id);

    const active = await container.providers.listModels(connection.id);
    expect(active.map((item) => item.model_id)).not.toContain(
      "retired-test-model",
    );
    const stored = await container.db.query<{
      status: string;
      data: Record<string, unknown>;
    }>(
      "SELECT status,data FROM resources WHERE kind='provider_model' AND parent_id=$1 AND data->>'model_id'=$2",
      [connection.id, "retired-test-model"],
    );
    expect(stored.rows[0]).toMatchObject({ status: "unavailable" });
    expect(await container.providers.get(connection.id)).toMatchObject({
      default_model: "retired-test-model",
      default_model_status: "unavailable",
    });
    await expect(
      container.providers.resolveConfig({
        provider: { connection_id: connection.id },
      }),
    ).rejects.toThrow("is not active");
  });

  it("keeps explicit user models and capability overrides across synchronization", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [{ id: "claude-sonnet-4-6" }],
            has_more: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const connection = await container.providers.create({
      name: "Anthropic",
      provider: "anthropic",
      api_key: "test-only-key",
    });
    await container.providers.addModel(connection.id, {
      model_id: "manual-test-model",
      capabilities: { context_window: 777_777, tools: true },
    });

    await container.providers.syncModels(connection.id);
    const manual = (await container.providers.listModels(connection.id)).find(
      (item) => item.model_id === "manual-test-model",
    );
    expect(manual).toMatchObject({
      status: "active",
      manually_added: true,
      remote_presence: "not_listed",
      capabilities: {
        context_window: 777_777,
        tools: true,
        capability_source: "user",
        capability_status: "user",
      },
    });

    await expect(
      container.providers.addModel(connection.id, {
        model_id: "invalid-reasoning-model",
        capabilities: { reasoning: { supported: true } },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("retries safe discovery reads, follows Gemini pagination, and keeps unknown capabilities conservative", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("", { status: 503, headers: { "retry-after": "0" } }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [{ name: "models/new-model-a" }],
            nextPageToken: "page-2",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ models: [{ name: "models/new-model-b" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const connection = await container.providers.create({
      name: "Gemini",
      provider: "google_gemini",
      api_key: "test-only-key",
      settings: { model_discovery_max_retries: 2 },
    });

    const result = await container.providers.validate(connection.id);
    expect(result).toMatchObject({
      valid: true,
      discovery: { status: "succeeded", remote_model_count: 2 },
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[2]![0])).toContain("pageToken=page-2");
    const models = await container.providers.listModels(connection.id);
    expect(models.map((item) => item.model_id).sort()).toEqual([
      "new-model-a",
      "new-model-b",
    ]);
    expect(models[0]!.capabilities).toMatchObject({
      tools: false,
      streaming: false,
      capability_source: "remote",
      capability_status: "unknown",
    });
  });

  it("returns safe structured discovery errors without discarding catalog usability", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "credential rejected" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const secret = "test-secret-that-must-not-appear";
    const connection = await container.providers.create({
      name: "Anthropic",
      provider: "anthropic",
      api_key: secret,
    });

    const result = await container.providers.validate(connection.id);
    expect(result).toMatchObject({
      valid: false,
      error_details: {
        category: "authentication",
        operation: "model_discovery",
        retryable: false,
        http_status: 401,
      },
      discovery: { status: "failed", source: "none" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(secret);

    const fallback = await container.providers.listModels(connection.id);
    expect(fallback.length).toBeGreaterThan(0);
    expect(await container.providers.get(connection.id)).toMatchObject({
      status: "configured",
      model_discovery: {
        status: "failed",
        source: "catalog_fallback",
        effective_model_count: fallback.length,
      },
    });
  });
});
