import { describe, expect, it, vi } from "vitest";
import type { Model } from "@openai/agents";
import OpenAI from "openai";
import { OpenAIProvider } from "@openai/agents-openai";
import {
  PROVIDER_CATALOG,
  applyReasoningModelSettings,
} from "../src/providers.js";
import {
  ReasoningCompatibleModel,
  normalizeReasoningChunkInPlace,
  withChatReasoningReplayField,
} from "../src/reasoning-model.js";
import { ModelStreamEventNormalizer } from "../src/model-stream-events.js";

const capability = (providerId: string, modelId: string) =>
  PROVIDER_CATALOG[providerId]!.models.find((model) => model.id === modelId)!
    .capabilities.reasoning;

describe("Provider reasoning capabilities", () => {
  it("catalogs every verified reasoning-capable static model", () => {
    const actual = Object.values(PROVIDER_CATALOG).flatMap((provider) =>
      provider.models
        .filter((model) => model.capabilities.reasoning.supported)
        .map((model) => `${provider.id}/${model.id}`),
    );
    expect(actual).toEqual([
      "openai/gpt-6-astra",
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-luna",
      "openai/gpt-5.4",
      "openai/gpt-5.4-mini",
      "codex_bridge/gpt-6-astra",
      "codex_bridge/gpt-5.6-sol",
      "codex_bridge/gpt-5.6-luna",
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-haiku-4-5-20251001",
      "google_gemini/gemini-3.1-pro-preview",
      "google_gemini/gemini-3-flash-preview",
      "google_gemini/gemini-3.1-flash-lite",
      "cohere/command-a-plus-05-2026",
      "xai/grok-4.3",
      "xai/grok-4.5",
      "mistral/mistral-small-latest",
      "groq/openai/gpt-oss-120b",
      "groq/qwen/qwen3.6-27b",
      "groq/minimaxai/minimax-m2.7",
      "together/openai/gpt-oss-120b",
      "together/openai/gpt-oss-20b",
      "perplexity/sonar-pro",
      "cerebras/gpt-oss-120b",
      "xiaomi_mimo/mimo-v2.5",
      "xiaomi_mimo/mimo-v2.5-pro",
      "deepseek/deepseek-flash",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-flash-vision-exp",
      "alibaba_qwen/qwen3.8-max",
      "alibaba_qwen/qwen3.7-max",
      "alibaba_qwen/qwen3.7-plus",
      "zhipu_glm/glm-5.2",
      "zhipu_glm/glm-5.1",
      "zhipu_glm/glm-5",
      "zhipu_glm/glm-4.7",
      "moonshot_kimi/kimi-k2.7-code",
      "moonshot_kimi/kimi-k2.6",
      "moonshot_kimi/kimi-k2.5",
      "volcengine_ark/doubao-seed-2-0-lite-260215",
      "baidu_qianfan/ernie-x1.1-preview",
      "tencent_hunyuan/hunyuan-t1-latest",
      "minimax/MiniMax-M2.7",
      "minimax/MiniMax-M2.5",
      "minimax/MiniMax-M2.1",
      "stepfun/step-3.5-flash",
      "stepfun/step-3.5-flash-2603",
      "iflytek_spark/spark-x",
    ]);
    for (const provider of Object.values(PROVIDER_CATALOG))
      for (const model of provider.models) {
        const reasoning = model.capabilities.reasoning;
        expect(reasoning.controls.effort).toBe(
          reasoning.effort_values.length > 0,
        );
        expect(reasoning.controls.summary).toBe(
          reasoning.summary_values.length > 0,
        );
      }
  });

  it("maps Responses, Chat Completions, Anthropic, and Gemini controls", () => {
    expect(
      applyReasoningModelSettings(
        { reasoning_effort: "max", reasoning_summary: "auto" },
        capability("openai", "gpt-6-astra"),
        "gpt-6-astra",
      ),
    ).toMatchObject({ reasoning: { effort: "max", summary: "auto" } });

    expect(
      applyReasoningModelSettings(
        { reasoning_effort: "none", reasoning_summary: "auto" },
        capability("codex_bridge", "gpt-6-astra"),
        "gpt-6-astra",
      ),
    ).toMatchObject({ reasoning: { effort: "none", summary: "auto" } });

    expect(
      applyReasoningModelSettings(
        { reasoning_effort: "high", reasoning_summary: "detailed" },
        capability("openai", "gpt-5.6-sol"),
        "gpt-5.6-sol",
      ),
    ).toMatchObject({ reasoning: { effort: "high", summary: "detailed" } });

    expect(
      applyReasoningModelSettings(
        { reasoning_enabled: true },
        capability("alibaba_qwen", "qwen3.7-plus"),
        "qwen3.7-plus",
      ),
    ).toMatchObject({ providerData: { enable_thinking: true } });

    expect(
      applyReasoningModelSettings(
        { reasoning_effort: "low" },
        capability("zhipu_glm", "glm-5.2"),
        "glm-5.2",
      ),
    ).toMatchObject({
      reasoning: { effort: "high" },
      providerData: { thinking: { type: "enabled" } },
    });

    expect(
      applyReasoningModelSettings(
        { reasoning_effort: "max" },
        capability("deepseek", "deepseek-flash"),
        "deepseek-flash",
      ),
    ).toEqual({ reasoning: { effort: "max" } });

    expect(
      applyReasoningModelSettings(
        { reasoning_enabled: false },
        capability("deepseek", "deepseek-flash"),
        "deepseek-flash",
      ),
    ).toEqual({ reasoning: { effort: "none" } });

    expect(
      applyReasoningModelSettings(
        {},
        capability("moonshot_kimi", "kimi-k2.7-code"),
        "kimi-k2.7-code",
      ),
    ).toMatchObject({
      providerData: { thinking: { type: "enabled", keep: "all" } },
    });

    expect(
      applyReasoningModelSettings(
        {},
        capability("minimax", "MiniMax-M2.7"),
        "MiniMax-M2.7",
      ),
    ).toMatchObject({ providerData: { reasoning_split: true } });

    expect(
      applyReasoningModelSettings(
        {},
        capability("stepfun", "step-3.5-flash"),
        "step-3.5-flash",
      ),
    ).toMatchObject({
      providerData: { reasoning_format: "deepseek-style" },
    });

    expect(
      applyReasoningModelSettings(
        { reasoning_effort: "high" },
        capability("groq", "openai/gpt-oss-120b"),
        "openai/gpt-oss-120b",
      ),
    ).toMatchObject({
      reasoning: { effort: "high" },
      providerData: { reasoning_format: "parsed", include_reasoning: true },
    });

    expect(
      applyReasoningModelSettings(
        {},
        capability("anthropic", "claude-opus-5"),
        "claude-opus-5",
      ),
    ).toMatchObject({
      providerData: {
        providerOptions: {
          anthropic: {
            thinking: { type: "adaptive", display: "summarized" },
          },
        },
      },
    });

    expect(
      applyReasoningModelSettings(
        { reasoning_enabled: true, reasoning_budget_tokens: 4096 },
        capability("anthropic", "claude-haiku-4-5-20251001"),
        "claude-haiku-4-5-20251001",
      ),
    ).toMatchObject({
      providerData: {
        providerOptions: {
          anthropic: { thinking: { type: "enabled", budgetTokens: 4096 } },
        },
      },
    });

    expect(
      applyReasoningModelSettings(
        { reasoning_effort: "high", reasoning_summary: "auto" },
        capability("google_gemini", "gemini-3.1-pro-preview"),
        "gemini-3.1-pro-preview",
      ),
    ).toMatchObject({
      providerData: {
        reasoning: "high",
        providerOptions: {
          google: {
            thinkingConfig: { thinkingLevel: "high", includeThoughts: true },
          },
        },
      },
    });

    expect(
      applyReasoningModelSettings(
        { reasoning_enabled: true, reasoning_budget_tokens: 8192 },
        capability("cohere", "command-a-plus-05-2026"),
        "command-a-plus-05-2026",
      ),
    ).toMatchObject({
      providerData: { thinking: { type: "enabled", token_budget: 8192 } },
    });
  });

  it("rejects unsupported controls instead of silently forwarding them", () => {
    expect(() =>
      applyReasoningModelSettings(
        { reasoning_effort: "none" },
        capability("openai", "gpt-6-astra"),
        "gpt-6-astra",
      ),
    ).toThrow("does not support reasoning effort none");
    expect(() =>
      applyReasoningModelSettings(
        { reasoning_summary: "detailed" },
        capability("codex_bridge", "gpt-6-astra"),
        "gpt-6-astra",
      ),
    ).toThrow("does not support reasoning summary detailed");

    expect(() =>
      applyReasoningModelSettings(
        { reasoning_effort: "high" },
        capability("alibaba_qwen", "qwen3.7-plus"),
        "qwen3.7-plus",
      ),
    ).toThrow("does not support reasoning effort");
    expect(() =>
      applyReasoningModelSettings(
        { reasoning_enabled: false },
        capability("minimax", "MiniMax-M2.7"),
        "MiniMax-M2.7",
      ),
    ).toThrow("does not support toggling reasoning");
    expect(() =>
      applyReasoningModelSettings(
        { reasoning_summary: "detailed" },
        capability("google_gemini", "gemini-3.1-pro-preview"),
        "gemini-3.1-pro-preview",
      ),
    ).toThrow("does not support reasoning summary detailed");
    expect(() =>
      applyReasoningModelSettings(
        { reasoning_enabled: true },
        capability("cohere", "command-a-03-2025"),
        "command-a-03-2025",
      ),
    ).toThrow("does not support reasoning");
  });
});

describe("reasoning protocol normalization", () => {
  it("maps reasoning_content and Mistral ThinkChunk before SDK conversion", () => {
    const deepSeek = {
      type: "model",
      event: {
        choices: [{ index: 0, delta: { reasoning_content: "private" } }],
      },
    };
    normalizeReasoningChunkInPlace(deepSeek);
    expect(deepSeek.event.choices[0]!.delta).toMatchObject({
      reasoning: "private",
    });

    const mistral = {
      type: "model",
      event: {
        choices: [
          {
            index: 0,
            delta: {
              content: [
                { type: "thinking", thinking: "hidden" },
                { type: "text", text: "answer" },
              ],
            },
          },
        ],
      },
    };
    normalizeReasoningChunkInPlace(mistral);
    expect(mistral.event.choices[0]!.delta).toEqual({
      content: "answer",
      reasoning: "hidden",
    });
  });

  it("lets the SDK retain aliased reasoning for tool-call continuity", async () => {
    const raw = {
      type: "model",
      event: {
        choices: [{ index: 0, delta: { reasoning_content: "private" } }],
      },
    };
    const inner = {
      async getResponse() {
        return {
          usage: {} as never,
          output: [],
          providerData: {
            choices: [{ message: { reasoning_content: "private" } }],
          },
        };
      },
      async *getStreamedResponse() {
        yield raw as never;
      },
    } as Model;
    const model = new ReasoningCompatibleModel(inner);
    const streamed = [];
    for await (const event of model.getStreamedResponse({} as never))
      streamed.push(event);
    expect(
      (
        streamed[0] as {
          event: { choices: Array<{ delta: Record<string, unknown> }> };
        }
      ).event.choices[0]!.delta.reasoning,
    ).toBe("private");
    expect((await model.getResponse({} as never)).output[0]).toMatchObject({
      type: "reasoning",
      rawContent: [{ type: "reasoning_text", text: "private" }],
    });
  });

  it("normalizes a real OpenAI-compatible SDK stream before conversion", async () => {
    const chunks = [
      {
        id: "chat-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-reasoner",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", reasoning_content: "private trace" },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chat-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-reasoner",
        choices: [
          { index: 0, delta: { content: "answer" }, finish_reason: null },
        ],
      },
      {
        id: "chat-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-reasoner",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      },
    ];
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    const client = new OpenAI({
      apiKey: "test-only",
      baseURL: "http://provider.test/v1",
      fetch: fetcher,
      maxRetries: 0,
    });
    const provider = new OpenAIProvider({
      openAIClient: client,
      useResponses: false,
    });
    const model = new ReasoningCompatibleModel(
      await provider.getModel("test-reasoner"),
    );
    const events = [];
    for await (const event of model.getStreamedResponse({
      input: "hello",
      modelSettings: {},
      tools: [],
      outputType: "text",
      handoffs: [],
      tracing: false,
    } as never))
      events.push(event);
    const done = events.find((event) => event.type === "response_done") as
      { response: { output: unknown[] } } | undefined;
    expect(done?.response.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reasoning",
          rawContent: [{ type: "reasoning_text", text: "private trace" }],
        }),
        expect.objectContaining({ type: "message" }),
      ]),
    );
    await provider.close();
  });

  it("replays reasoning_content for Providers that require it", async () => {
    let sent: Record<string, unknown> | undefined;
    const fetcher = withChatReasoningReplayField(async (input, init) => {
      const request = new Request(input, init);
      sent = JSON.parse(await request.text()) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }, "reasoning_content");
    await fetcher("https://provider.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "reasoner",
        messages: [
          { role: "assistant", content: null, reasoning: "private" },
          { role: "tool", content: "result", tool_call_id: "call-1" },
        ],
      }),
    });
    expect(sent).toMatchObject({
      messages: [
        {
          role: "assistant",
          content: null,
          reasoning_content: "private",
        },
        { role: "tool", content: "result", tool_call_id: "call-1" },
      ],
    });
    expect(JSON.stringify(sent)).not.toContain('"reasoning":"private"');
  });

  it("normalizes Provider traces as metadata and AI SDK summaries as public text", () => {
    const trace = new ModelStreamEventNormalizer(1, {
      reasoning: capability("deepseek", "deepseek-flash"),
    });
    const privateText = "PRIVATE_TRACE";
    const traceEvents = trace.consume({
      type: "model",
      event: {
        id: "chat-1",
        choices: [{ index: 0, delta: { reasoning_content: privateText } }],
      },
    });
    trace.consume({
      type: "model",
      event: {
        id: "chat-1",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    });
    traceEvents.push(...trace.flush());
    expect(traceEvents.map((event) => event.type)).toEqual([
      "model.reasoning_metadata_started",
      "model.reasoning_metadata_completed",
    ]);
    expect(traceEvents.at(-1)?.data).toMatchObject({
      source: "responses_reasoning_text",
      unicode_character_count: privateText.length,
      content_available: false,
      content_persisted: false,
    });
    expect(JSON.stringify(traceEvents)).not.toContain(privateText);

    const summary = new ModelStreamEventNormalizer(2, {
      reasoning: capability("anthropic", "claude-opus-5"),
    });
    const summaryEvents = [
      ...summary.consume({
        type: "model",
        event: { type: "reasoning-delta", id: "r1", delta: "summary " },
      }),
      ...summary.consume({
        type: "model",
        event: { type: "reasoning-delta", id: "r1", delta: "text" },
      }),
      ...summary.consume({
        type: "model",
        event: { type: "reasoning-end", id: "r1" },
      }),
    ];
    expect(summaryEvents.at(-1)).toMatchObject({
      type: "model.reasoning_summary_completed",
      data: { text: "summary text", execution_attempt: 2 },
    });

    const itemOnly = new ModelStreamEventNormalizer(3, {
      reasoning: capability("google_gemini", "gemini-3.1-pro-preview"),
    });
    expect(
      itemOnly.consumeReasoningItem({
        type: "reasoning",
        id: "gemini-summary",
        content: [{ type: "input_text", text: "public thought summary" }],
        rawContent: [{ type: "reasoning_text", text: "private copy" }],
      }),
    ).toEqual([
      expect.objectContaining({
        type: "model.reasoning_summary_completed",
        data: expect.objectContaining({ text: "public thought summary" }),
      }),
    ]);

    const serviceSteps = new ModelStreamEventNormalizer(4, {
      reasoning: capability("perplexity", "sonar-pro"),
    });
    const stepEvents = serviceSteps.consume({
      type: "model",
      event: {
        type: "provider-metadata",
        id: "search-1",
        reasoning_steps: [{ text: "searched sources" }],
      },
    });
    expect(stepEvents[0]).toMatchObject({
      type: "model.reasoning_metadata_started",
      data: { source: "service_reasoning_steps", content_available: false },
    });
    expect(JSON.stringify(stepEvents)).not.toContain("searched sources");
  });
});
