import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/api.js";
import type { Container } from "../src/container.js";
import {
  clearOfficialTokenizerCacheForTests,
  renderDeepseekV41Prompt,
  renderDeepseekV4Prompt,
} from "../src/local-tokenizers.js";
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
  vi.unstubAllGlobals();
  clearOfficialTokenizerCacheForTests();
});

async function setup() {
  const test = await testContainer();
  container = test.container;
  cleanup = test.close;
  app = await createApp(container);
  return { app, container };
}

const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const testTokenizer = {
  version: "1.0",
  truncation: null,
  padding: null,
  added_tokens: [
    {
      id: 0,
      content: "[UNK]",
      single_word: false,
      lstrip: false,
      rstrip: false,
      normalized: false,
      special: true,
    },
  ],
  normalizer: null,
  pre_tokenizer: { type: "Whitespace" },
  post_processor: null,
  decoder: { type: "WordPiece", prefix: "##", cleanup: true },
  model: {
    type: "WordPiece",
    unk_token: "[UNK]",
    continuing_subword_prefix: "##",
    max_input_chars_per_word: 100,
    vocab: { "[UNK]": 0 },
  },
};

const testTokenizerConfig = {
  unk_token: "[UNK]",
  chat_template:
    "{% for message in messages %}{{ message.role }}: {{ message.content }}\\n{% endfor %}{% for tool in tools %}{{ tool.function.name }} {{ tool.function.description }}{% endfor %}{% if add_generation_prompt %}assistant:{% endif %}",
};

describe("assembled input Token counting", () => {
  it("lists only qualified models with at least one million context Tokens", async () => {
    const { app, container } = await setup();
    const models = container.providers.inputTokenCountingModels();
    expect(models).toHaveLength(18);
    expect(
      models.every(
        (item) =>
          item.context_window_tokens >= 1_000_000 &&
          item.input_token_counting.status === "qualified" &&
          item.input_token_counting.scope === "assembled_model_input",
      ),
    ).toBe(true);
    expect(models.map((item) => `${item.provider}/${item.model_id}`)).toEqual(
      expect.arrayContaining([
        "openai/gpt-6-astra",
        "openai/gpt-5.4",
        "anthropic/claude-sonnet-5",
        "google_gemini/gemini-3.1-pro-preview",
        "xiaomi_mimo/mimo-v2.5",
        "xiaomi_mimo/mimo-v2.5-pro",
        "deepseek/deepseek-flash",
        "deepseek/deepseek-v4-flash",
        "deepseek/deepseek-v4-flash-vision-exp",
        "alibaba_qwen/qwen3.8-max",
      ]),
    );
    expect(
      models
        .filter((item) =>
          ["xiaomi_mimo", "deepseek", "alibaba_qwen"].includes(item.provider),
        )
        .every(
          (item) =>
            item.input_token_counting.method === "official_local_tokenizer" &&
            item.input_token_counting.accuracy === "verified_local" &&
            item.input_token_counting.supported_input_modalities?.[0] ===
              "text",
        ),
    ).toBe(true);

    const response = await app.inject({
      method: "GET",
      url: "/v1/input-token-counting/models",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(models);
  });

  it("counts the complete OpenAI request without creating Runtime records", async () => {
    const { app, container } = await setup();
    const imported = await container.skills.importBundle([
      {
        path: "SKILL.md",
        content_base64: Buffer.from(
          `---
name: counting-skill
slug: counting-skill
description: Counted Skill
omoikane:
  schema_version: 1
  workspace: none
  requires:
    tools: []
    commands: []
    network: false
  entrypoints: {}
---

# COUNTED_SKILL_MARKER

This instruction must be visible to the model.
`,
        ).toString("base64"),
      },
    ]);
    const child = await publishedAgent(container, {
      provider: "openai",
      modelId: "gpt-5.4",
      outputSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    });
    const root = await publishedAgent(container, {
      provider: "openai",
      modelId: "gpt-5.4",
      tools: ["artifact-create"],
      skills: [{ version_id: imported.version.id }],
      handoffs: [child.version.id],
      outputSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    });
    let wireBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(request.url).toContain("/responses/input_tokens");
        wireBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return jsonResponse({
          object: "response.input_tokens",
          input_tokens: 456_789,
        });
      }),
    );
    const before = (
      await container.db.query<{ count: number }>(
        "SELECT count(*)::int count FROM runs",
      )
    ).rows[0]!.count;
    const response = await app.inject({
      method: "POST",
      url: `/v1/deployments/${root.version.id}/input-token-count`,
      payload: {
        conversation: [
          { role: "user", content: "HISTORY_USER_MARKER" },
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "HISTORY_ASSISTANT_MARKER",
                annotations: [],
              },
            ],
          },
        ],
        input: "CURRENT_INPUT_MARKER",
        context: { business_only: "NOT_MODEL_VISIBLE" },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      deployment_id: root.version.id,
      provider: "openai",
      model_id: "gpt-5.4",
      input_tokens: 456_789,
      context_window_tokens: 1_050_000,
      reserved_output_tokens: 128_000,
      maximum_input_tokens: 922_000,
      method: "openai_responses_input_tokens",
      accuracy: "authoritative_exact",
    });
    expect(JSON.stringify(wireBody)).toContain("HISTORY_USER_MARKER");
    expect(JSON.stringify(wireBody)).toContain("CURRENT_INPUT_MARKER");
    expect(JSON.stringify(wireBody)).toContain("COUNTED_SKILL_MARKER");
    expect(JSON.stringify(wireBody)).toContain("artifact_create");
    expect(JSON.stringify(wireBody)).toContain("transfer_to_Test_agent");
    expect(JSON.stringify(wireBody)).toContain("agent_output");
    expect(JSON.stringify(wireBody)).not.toContain("NOT_MODEL_VISIBLE");
    const after = (
      await container.db.query<{ count: number }>(
        "SELECT count(*)::int count FROM runs",
      )
    ).rows[0]!.count;
    expect(after).toBe(before);
    expect(
      (
        await container.db.query<{ count: number }>(
          "SELECT count(*)::int count FROM run_events",
        )
      ).rows[0]!.count,
    ).toBe(0);
  });

  it.each([
    {
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      path: "/messages/count_tokens",
      providerResult: { input_tokens: 123_456 },
      method: "anthropic_messages_count_tokens",
    },
    {
      provider: "google_gemini",
      modelId: "gemini-3.1-pro-preview",
      path: ":countTokens",
      providerResult: { totalTokens: 123_456 },
      method: "gemini_count_tokens",
    },
  ])(
    "uses the $provider official count endpoint",
    async ({ provider, modelId, path, providerResult, method }) => {
      const { app, container } = await setup();
      const fixture = await publishedAgent(container, {
        provider,
        modelId,
        tools: ["artifact-create"],
      });
      let observedBody: Record<string, unknown> | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          expect(request.url).toContain(path);
          observedBody = JSON.parse(await request.text()) as Record<
            string,
            unknown
          >;
          return jsonResponse(providerResult);
        }),
      );
      const response = await app.inject({
        method: "POST",
        url: `/v1/deployments/${fixture.version.id}/input-token-count`,
        payload: { input: "完整输入统计" },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        provider,
        model_id: modelId,
        input_tokens: 123_456,
        maximum_input_tokens: 1_000_000,
        method,
        accuracy: "provider_estimate",
      });
      expect(JSON.stringify(observedBody)).toContain("完整输入统计");
      expect(JSON.stringify(observedBody)).toContain("artifact_create");
    },
  );

  it("uses a pinned official local Tokenizer for a complete text request", async () => {
    const { app, container } = await setup();
    const fixture = await publishedAgent(container, {
      provider: "xiaomi_mimo",
      modelId: "mimo-v2.5",
      tools: ["artifact-create"],
    });
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requestedUrls.push(url);
        return jsonResponse(
          url.endsWith("tokenizer_config.json")
            ? testTokenizerConfig
            : testTokenizer,
        );
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: `/v1/deployments/${fixture.version.id}/input-token-count`,
      payload: { input: "COUNTED_LOCAL_INPUT" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      provider: "xiaomi_mimo",
      model_id: "mimo-v2.5",
      method: "official_local_tokenizer",
      accuracy: "verified_local",
      tokenizer_id: "XiaomiMiMo/MiMo-V2.5",
      tokenizer_revision: "63651580ca774f8504f676040460aed3e1244ac1",
    });
    expect(response.json().input_tokens).toBeGreaterThan(0);
    expect(requestedUrls).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "XiaomiMiMo/MiMo-V2.5/resolve/63651580ca774f8504f676040460aed3e1244ac1/tokenizer.json",
        ),
        expect.stringContaining(
          "XiaomiMiMo/MiMo-V2.5/resolve/63651580ca774f8504f676040460aed3e1244ac1/tokenizer_config.json",
        ),
      ]),
    );
  });

  it("uses the pinned DeepSeek V4.1 Prompt Encoder and Tokenizer", async () => {
    const { app, container } = await setup();
    const fixture = await publishedAgent(container, {
      provider: "deepseek",
      modelId: "deepseek-flash",
      tools: ["artifact-create"],
    });
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requestedUrls.push(url);
        return jsonResponse(
          url.endsWith("tokenizer_config.json")
            ? testTokenizerConfig
            : testTokenizer,
        );
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/deployments/${fixture.version.id}/input-token-count`,
      payload: { input: "COUNTED_DEEPSEEK_V41_INPUT" },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      provider: "deepseek",
      model_id: "deepseek-flash",
      method: "official_local_tokenizer",
      accuracy: "verified_local",
      tokenizer_id: "deepseek-ai/DeepSeek-V4.1-Flash",
      tokenizer_revision: "dba1be0a40aa45a94ad051997016db3960a90277",
    });
    expect(response.json().input_tokens).toBeGreaterThan(0);
    expect(requestedUrls).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "deepseek-ai/DeepSeek-V4.1-Flash/resolve/dba1be0a40aa45a94ad051997016db3960a90277/tokenizer.json",
        ),
        expect.stringContaining(
          "deepseek-ai/DeepSeek-V4.1-Flash/resolve/dba1be0a40aa45a94ad051997016db3960a90277/tokenizer_config.json",
        ),
      ]),
    );
  });

  it("matches the DeepSeek V4 Prompt Encoder for a text turn", () => {
    expect(
      renderDeepseekV4Prompt({
        messages: [
          { role: "system", content: "Be exact." },
          { role: "user", content: "Hello" },
        ],
        reasoning_effort: "high",
      }),
    ).toBe(
      "<｜begin▁of▁sentence｜>Be exact.<｜User｜>Hello<｜Assistant｜><think>",
    );
  });

  it("matches the DeepSeek V4.1 Prompt Encoder for default and disabled reasoning", () => {
    expect(
      renderDeepseekV41Prompt({
        messages: [
          { role: "system", content: "Be exact." },
          { role: "user", content: "Hello" },
        ],
      }),
    ).toBe(
      "<｜begin▁of▁sentence｜><｜System｜>Reasoning Effort: 75 (range 1-100, the higher the value, the more thorough the reasoning)\n\nBe exact.<｜User｜>Hello<｜Assistant｜><think>",
    );
    expect(
      renderDeepseekV41Prompt({
        messages: [{ role: "user", content: "Hello" }],
        reasoning_effort: "none",
      }),
    ).toBe("<｜begin▁of▁sentence｜><｜User｜>Hello<｜Assistant｜></think>");

    const toolPrompt = renderDeepseekV41Prompt({
      messages: [
        { role: "system", content: "Use tools." },
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: "",
          reasoning_content: "I should look it up.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "weather",
                arguments: '{"city":"Taipei"}',
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
      reasoning_effort: "max",
    });
    expect(toolPrompt).toContain("Reasoning Effort: 100 (range 1-100");
    expect(toolPrompt).toContain("<｜DSML｜ calls>");
    expect(toolPrompt).toContain('<｜DSML｜ invoke name="weather">');
    expect(toolPrompt).toContain(
      '<｜DSML｜ parameter name="city" string="true">Taipei</｜DSML｜ parameter>',
    );
    expect(toolPrompt).toContain("<tool_result>sunny</tool_result>");
    expect(toolPrompt).not.toContain("<｜DSML｜tool_calls>");
  });

  it("fails closed for a million-context model without a complete counter", async () => {
    const { app, container } = await setup();
    const fixture = await publishedAgent(container, {
      provider: "zhipu_glm",
      modelId: "glm-5.2",
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/deployments/${fixture.version.id}/input-token-count`,
      payload: { input: "do not estimate this" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "input_token_counting_not_qualified" },
    });
  });

  it("shares the Run conversation/projection exclusivity rule", async () => {
    const { app, container } = await setup();
    const fixture = await publishedAgent(container, {
      provider: "openai",
      modelId: "gpt-5.4",
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/deployments/${fixture.version.id}/input-token-count`,
      payload: {
        input: "hello",
        conversation: [],
        projection: {},
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        code: "invalid_request",
        details: {
          issues: expect.arrayContaining([
            expect.objectContaining({ path: "projection" }),
          ]),
        },
      },
    });
  });
});
