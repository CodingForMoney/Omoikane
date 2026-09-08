import { afterEach, describe, expect, it, vi } from "vitest";
import type { Container } from "../src/container.js";
import { ConflictError, ValidationError } from "../src/database.js";
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
    const openai = catalog.find((item) => item.id === "openai")!;
    expect(
      openai.models.find((item) => item.id === "gpt-6-astra")!.capabilities,
    ).toMatchObject({
      context_window: 1_050_000,
      max_output_tokens: 128_000,
      vision: true,
      structured_output: "native",
      context_compaction: {
        supported: true,
        method: "responses_compact",
      },
      reasoning: {
        effort_values: ["low", "medium", "high", "xhigh", "max"],
      },
    });
    const bridge = catalog.find((item) => item.id === "codex_bridge")!;
    expect(bridge.models[0]!.capabilities.context_window).toBe(258_400);
    expect(bridge.models[0]!.capabilities.context_compaction).toEqual({
      supported: true,
      method: "responses_compact",
    });
    expect(bridge.models[0]!.capabilities.reasoning).toMatchObject({
      effort_values: ["none", "low", "medium", "high", "xhigh", "max"],
      summary_values: ["auto"],
    });
    const mimo = catalog.find((item) => item.id === "xiaomi_mimo")!;
    expect(
      mimo.models.find((item) => item.id === "mimo-v2.5")!.capabilities,
    ).toMatchObject({
      context_window: 1_048_576,
      context_compaction: { supported: false },
    });
  });

  it("declares coherent modalities and task capabilities for every catalog model", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const catalog = container.providers.catalog();
    const models = catalog.flatMap((provider) =>
      provider.models.map((model) => ({
        provider: provider.id,
        model: model.id,
        capabilities: model.capabilities,
      })),
    );
    expect(models.length).toBeGreaterThanOrEqual(60);
    for (const { capabilities } of models) {
      const image = capabilities.tasks.image_understanding === "native";
      expect(capabilities.vision).toBe(image);
      expect(capabilities.input_modalities.includes("image")).toBe(image);
      expect(new Set(capabilities.input_modalities).size).toBe(
        capabilities.input_modalities.length,
      );
      expect(new Set(capabilities.output_modalities).size).toBe(
        capabilities.output_modalities.length,
      );
      if (capabilities.tasks.transcription !== "none") {
        expect(capabilities.input_modalities).toContain("audio");
        expect(capabilities.output_modalities).toContain("text");
      }
      if (capabilities.tasks.speech_synthesis !== "none") {
        expect(capabilities.input_modalities).toContain("text");
        expect(capabilities.output_modalities).toContain("audio");
      }
    }

    const capability = (provider: string, model: string) =>
      models.find((item) => item.provider === provider && item.model === model)!
        .capabilities;
    expect(capability("openai", "gpt-5.6-sol")).toMatchObject({
      model_kind: "agent",
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      tasks: {
        image_understanding: "native",
        transcription: "none",
        speech_synthesis: "none",
      },
    });
    expect(capability("google_gemini", "gemini-3.1-pro-preview")).toMatchObject(
      {
        input_modalities: ["text", "image", "audio", "video"],
        output_modalities: ["text"],
        tasks: { image_understanding: "native", transcription: "general" },
      },
    );
    expect(capability("xiaomi_mimo", "mimo-v2.5")).toMatchObject({
      input_modalities: ["text", "image", "audio", "video"],
      tasks: { image_understanding: "native", transcription: "general" },
      reasoning: {
        raw_trace_metadata: "responses_reasoning_text",
        native_summary: "not_observed",
      },
    });
    expect(capability("xiaomi_mimo", "mimo-v2.5-pro")).toMatchObject({
      input_modalities: ["text"],
      tasks: { image_understanding: "none", transcription: "none" },
    });
    expect(capability("xiaomi_mimo", "mimo-v2.5-asr")).toMatchObject({
      model_kind: "transcription",
      input_modalities: ["audio"],
      output_modalities: ["text"],
      max_output_tokens: 2_048,
      streaming: false,
      tools: false,
      structured_output: "none",
      tasks: { transcription: "dedicated", speech_synthesis: "none" },
    });
    expect(capability("xiaomi_mimo", "mimo-v2.5-tts")).toMatchObject({
      model_kind: "speech_synthesis",
      input_modalities: ["text"],
      output_modalities: ["audio"],
      max_output_tokens: 8_192,
      streaming: false,
      tools: false,
      structured_output: "none",
      tasks: { transcription: "none", speech_synthesis: "dedicated" },
    });
    expect(capability("cohere", "command-a-plus-05-2026").vision).toBe(true);
    expect(capability("xai", "grok-build-0.1").vision).toBe(true);
    expect(capability("mistral", "mistral-large-latest").vision).toBe(true);
    expect(capability("groq", "qwen/qwen3.6-27b").vision).toBe(true);
    expect(capability("perplexity", "sonar-pro").vision).toBe(true);
    expect(capability("alibaba_qwen", "qwen3.6-flash").vision).toBe(true);
    expect(capability("moonshot_kimi", "kimi-k2.6").vision).toBe(true);
    expect(
      capability("volcengine_ark", "doubao-seed-2-0-lite-260215").vision,
    ).toBe(true);
    expect(capability("volcengine_ark", "ark-code-latest").model_kind).toBe(
      "routing",
    );
    expect(capability("stepfun", "step-router-v1").model_kind).toBe("routing");
    expect(
      models.some(
        ({ capabilities }) =>
          capabilities.tasks.speech_synthesis !== "none" ||
          capabilities.model_kind === "speech_synthesis",
      ),
    ).toBe(true);
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
    await expect(
      container.providers.resolveConfig({
        provider: { connection_id: mimo.id },
        model: "mimo-v2.5-asr",
      }),
    ).rejects.toThrow("cannot back an Agent deployment");
  });

  it("compiles Agents SDK tool history into Responses wire items before native compaction", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "resp_compact_wire_test",
          object: "response.compaction",
          created_at: 1,
          output: [
            {
              id: "cmp_wire_test",
              type: "compaction",
              encrypted_content: "opaque-test-checkpoint",
            },
          ],
          usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const connection = await container.providers.create({
      name: "Codex Bridge",
      provider: "codex_bridge",
      api_key: "test-only-key",
    });
    const resolved = await container.providers.resolveConfig({
      provider: { connection_id: connection.id },
      model: "gpt-5.6-sol",
    });

    await container.providers.compactResponses(
      resolved._connection,
      "gpt-5.6-sol",
      [
        { role: "user", content: "Fetch the next page" },
        {
          type: "function_call",
          callId: "wire-call-1",
          name: "fetch_page",
          arguments: '{"page":1}',
          status: "completed",
        },
        {
          type: "function_call_result",
          callId: "wire-call-1",
          name: "fetch_page",
          status: "completed",
          output: { type: "text", text: '{"items":[]}' },
        },
      ],
      { instructions: "Preserve exact identifiers." },
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [request, init] = fetcher.mock.calls[0]!;
    const outgoing =
      request instanceof Request ? request.clone() : new Request(request, init);
    expect(outgoing.url).toBe("http://127.0.0.1:3456/v1/responses/compact");
    const body = JSON.parse(await outgoing.text());
    expect(body).toMatchObject({
      model: "gpt-5.6-sol",
      instructions: "Preserve exact identifiers.",
      input: [
        { role: "user", content: "Fetch the next page" },
        {
          type: "function_call",
          call_id: "wire-call-1",
          name: "fetch_page",
          arguments: '{"page":1}',
        },
        {
          type: "function_call_output",
          call_id: "wire-call-1",
          output: '{"items":[]}',
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("function_call_result");
    expect(JSON.stringify(body)).not.toContain('"callId"');
  });

  it("deletes an unused connection together with its discovered models", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const connection = await container.providers.create({
      name: "Disposable provider",
      provider: "xiaomi_mimo",
      api_key: "test-only-key",
    });
    await container.providers.listModels(connection.id);
    expect(
      await container.providers.listModels(connection.id),
    ).not.toHaveLength(0);

    await container.providers.delete(connection.id);

    await expect(container.providers.get(connection.id)).rejects.toThrow();
    const models = await container.db.query<{ id: string }>(
      "SELECT id FROM resources WHERE kind='provider_model' AND parent_id=$1",
      [connection.id],
    );
    expect(models.rows).toEqual([]);
  });

  it("refuses to delete a connection referenced by an Agent deployment", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const connection = await container.providers.create({
      name: "Bound provider",
      provider: "xiaomi_mimo",
      api_key: "test-only-key",
    });
    await container.definitions.deploy({
      config: {
        name: "Bound agent",
        instructions: "Answer accurately.",
        provider: { connection_id: connection.id },
        model: "mimo-v2.5",
        model_settings: {},
        tools: [],
        skills: [],
        mcp_servers: [],
        compaction: { enabled: false },
      },
    });

    await expect(
      container.providers.delete(connection.id),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(container.providers.get(connection.id)).resolves.toMatchObject(
      {
        id: connection.id,
      },
    );
  });

  it("invokes MiMo dedicated ASR and TTS without exposing credentials", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "测试语音" } }],
            usage: { prompt_tokens: 12, completion_tokens: 4, seconds: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { audio: { data: "UklGRg==" } } }],
            usage: { prompt_tokens: 5, completion_tokens: 8 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const secret = "test-only-mimo-audio-key";
    const connection = await container.providers.create({
      name: "MiMo Audio",
      provider: "xiaomi_mimo",
      api_key: secret,
    });

    const transcription = await container.providers.transcribeAudio(
      connection.id,
      {
        model: "mimo-v2.5-asr",
        audio: { data: "UklGRg==", format: "wav" },
        language: "zh",
      },
    );
    expect(transcription).toEqual({
      model: "mimo-v2.5-asr",
      text: "测试语音",
      usage: { prompt_tokens: 12, completion_tokens: 4, seconds: 2 },
    });
    const asrRequest = fetcher.mock.calls[0]!;
    expect(String(asrRequest[0])).toBe(
      "https://token-plan-cn.xiaomimimo.com/v1/chat/completions",
    );
    const asrInit = asrRequest[1] as RequestInit;
    const asrBody = JSON.parse(String(asrInit.body));
    expect(asrBody).toMatchObject({
      model: "mimo-v2.5-asr",
      stream: false,
      asr_options: { language: "zh" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: { data: "data:audio/wav;base64,UklGRg==" },
            },
          ],
        },
      ],
    });

    const speech = await container.providers.synthesizeSpeech(connection.id, {
      model: "mimo-v2.5-tts",
      input: "你好",
      voice: "mimo_default",
      format: "wav",
      instructions: "温柔地朗读",
    });
    expect(speech).toEqual({
      model: "mimo-v2.5-tts",
      audio: {
        data: "UklGRg==",
        format: "wav",
        mime_type: "audio/wav",
      },
      usage: { prompt_tokens: 5, completion_tokens: 8 },
    });
    const ttsBody = JSON.parse(String(fetcher.mock.calls[1]![1]!.body));
    expect(ttsBody).toMatchObject({
      model: "mimo-v2.5-tts",
      stream: false,
      messages: [
        { role: "user", content: "温柔地朗读" },
        { role: "assistant", content: "你好" },
      ],
      audio: { format: "wav", voice: "mimo_default" },
    });
    expect(JSON.stringify({ transcription, speech })).not.toContain(secret);
  });

  it("normalizes persisted pre-modality model records on list and page reads", async () => {
    const test = await testContainer();
    container = test.container;
    cleanup = test.close;
    const connection = await container.providers.create({
      name: "OpenAI",
      provider: "openai",
      api_key: "test-only-key",
    });
    const original = (await container.providers.listModels(connection.id))[0]!;
    const legacyCapabilities = {
      ...original.capabilities,
    } as Record<string, unknown>;
    delete legacyCapabilities.model_kind;
    delete legacyCapabilities.input_modalities;
    delete legacyCapabilities.output_modalities;
    delete legacyCapabilities.tasks;
    await container.db.query(
      "UPDATE resources SET data=$2::jsonb WHERE id=$1",
      [
        original.id,
        JSON.stringify({
          ...original.data,
          capabilities: legacyCapabilities,
        }),
      ],
    );

    const listed = (await container.providers.listModels(connection.id)).find(
      (item) => item.id === original.id,
    );
    expect(listed?.capabilities).toMatchObject({
      model_kind: "agent",
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      tasks: { image_understanding: "native" },
    });
    const page = await container.providers.pageModels(connection.id);
    expect(
      page.data.find((item) => item.id === original.id)?.capabilities,
    ).toMatchObject({
      input_modalities: ["text", "image"],
      tasks: { image_understanding: "native" },
    });
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

    await container.providers.addModel(connection.id, {
      model_id: "legacy-vision-override",
      capabilities: { vision: true },
    });
    const legacyVision = (
      await container.providers.listModels(connection.id)
    ).find((item) => item.model_id === "legacy-vision-override");
    expect(legacyVision?.capabilities).toMatchObject({
      vision: true,
      input_modalities: ["text", "image"],
      tasks: { image_understanding: "native" },
    });

    await container.providers.addModel(connection.id, {
      model_id: "manual-tts-model",
      capabilities: {
        model_kind: "speech_synthesis",
        input_modalities: ["text"],
        output_modalities: ["audio"],
        tasks: { speech_synthesis: "dedicated" },
      },
    });
    const tts = (await container.providers.listModels(connection.id)).find(
      (item) => item.model_id === "manual-tts-model",
    );
    expect(tts?.capabilities).toMatchObject({
      model_kind: "speech_synthesis",
      input_modalities: ["text"],
      output_modalities: ["audio"],
      tasks: { speech_synthesis: "dedicated" },
    });

    await expect(
      container.providers.addModel(connection.id, {
        model_id: "invalid-reasoning-model",
        capabilities: { reasoning: { supported: true } },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      container.providers.addModel(connection.id, {
        model_id: "conflicting-image-model",
        capabilities: { vision: true, input_modalities: ["text"] },
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
      model_kind: "agent",
      input_modalities: ["text"],
      output_modalities: ["text"],
      tasks: {
        image_understanding: "none",
        transcription: "none",
        speech_synthesis: "none",
      },
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
