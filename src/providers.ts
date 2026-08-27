import OpenAI from "openai";
import { OpenAIProvider } from "@openai/agents-openai";
import { aisdk } from "@openai/agents-extensions/ai-sdk";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { Model } from "@openai/agents";
import type { Database } from "./database.js";
import { StateCipher, checksum } from "./crypto.js";
import { ConflictError, ValidationError } from "./database.js";
import { ResourceStore, type Resource } from "./resources.js";

export type ProviderProtocol =
  "responses" | "chat_completions" | "anthropic" | "google_gemini";
export interface ReasoningCapability {
  supported: boolean;
  effort_values: string[];
  adapter?: "reasoning_effort";
  value_map?: Record<string, string>;
}
export interface ModelCapability {
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  structured_output: "native" | "prompt";
  context_window?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  context_window_type: "total" | "input";
  capability_source: "catalog" | "remote" | "user";
  reasoning: ReasoningCapability;
}
export interface ProviderModelDefinition {
  id: string;
  display_name: string;
  capabilities: ModelCapability;
}
export interface ProviderDefinition {
  id: string;
  name: string;
  country: string;
  aliases?: string[];
  default_profile: string;
  profiles: Record<
    string,
    { name: string; base_url: string; protocol: ProviderProtocol }
  >;
  models: ProviderModelDefinition[];
}

const noReasoning = (): ReasoningCapability => ({
  supported: false,
  effort_values: [],
});
const standard = (
  effort_values = ["none", "low", "medium", "high", "xhigh"],
): ReasoningCapability => ({
  supported: true,
  adapter: "reasoning_effort",
  effort_values,
});
const model = (
  id: string,
  context_window?: number,
  options: Partial<ModelCapability> = {},
): ProviderModelDefinition => ({
  id,
  display_name: id,
  capabilities: {
    streaming: true,
    tools: true,
    vision: false,
    structured_output: "prompt",
    context_window,
    context_window_type: "total",
    capability_source: "catalog",
    reasoning: noReasoning(),
    ...options,
  },
});
const provider = (
  id: string,
  name: string,
  country: string,
  base_url: string,
  protocol: ProviderProtocol,
  models: ProviderModelDefinition[],
  profiles?: ProviderDefinition["profiles"],
  aliases?: string[],
): ProviderDefinition => ({
  id,
  name,
  country,
  aliases,
  default_profile: Object.keys(profiles ?? { default: {} })[0]!,
  profiles: profiles ?? {
    default: { name: `${name} API`, base_url, protocol },
  },
  models,
});

export const PROVIDER_CATALOG: Record<string, ProviderDefinition> =
  Object.fromEntries(
    [
      provider(
        "openai",
        "OpenAI",
        "US",
        "https://api.openai.com/v1",
        "responses",
        [
          model("gpt-5.6-sol", 1_050_000, {
            max_output_tokens: 128_000,
            vision: true,
            structured_output: "native",
            reasoning: standard([
              "none",
              "low",
              "medium",
              "high",
              "xhigh",
              "max",
            ]),
          }),
          model("gpt-5.6-terra", 1_050_000, {
            max_output_tokens: 128_000,
            vision: true,
            structured_output: "native",
            reasoning: standard([
              "none",
              "low",
              "medium",
              "high",
              "xhigh",
              "max",
            ]),
          }),
          model("gpt-5.6-luna", 1_050_000, {
            max_output_tokens: 128_000,
            vision: true,
            structured_output: "native",
            reasoning: standard([
              "none",
              "low",
              "medium",
              "high",
              "xhigh",
              "max",
            ]),
          }),
          model("gpt-5.4", 1_050_000, {
            max_output_tokens: 128_000,
            vision: true,
            structured_output: "native",
            reasoning: standard(),
          }),
          model("gpt-5.4-mini", 400_000, {
            max_output_tokens: 128_000,
            vision: true,
            structured_output: "native",
            reasoning: standard(),
          }),
        ],
      ),
      provider(
        "codex_bridge",
        "Codex Bridge (local)",
        "local",
        "http://127.0.0.1:3456/v1",
        "responses",
        [
          model("gpt-5.6-sol", 258_400, {
            max_output_tokens: 128_000,
            vision: true,
            structured_output: "native",
            reasoning: standard([
              "none",
              "low",
              "medium",
              "high",
              "xhigh",
              "max",
            ]),
          }),
          model("gpt-5.6-luna", 258_400, {
            max_output_tokens: 128_000,
            vision: true,
            structured_output: "native",
            reasoning: standard([
              "none",
              "low",
              "medium",
              "high",
              "xhigh",
              "max",
            ]),
          }),
        ],
        {
          loopback: {
            name: "Local 127.0.0.1:3456",
            base_url: "http://127.0.0.1:3456/v1",
            protocol: "responses",
          },
        },
        ["codex-bridge"],
      ),
      provider(
        "anthropic",
        "Anthropic Claude",
        "US",
        "https://api.anthropic.com/v1",
        "anthropic",
        [
          model("claude-opus-5", 1_000_000, {
            max_input_tokens: 1_000_000,
            context_window_type: "input",
            vision: true,
          }),
          model("claude-sonnet-5", 1_000_000, {
            max_input_tokens: 1_000_000,
            context_window_type: "input",
            vision: true,
          }),
          model("claude-opus-4-6", 1_000_000, {
            max_input_tokens: 1_000_000,
            context_window_type: "input",
            vision: true,
          }),
          model("claude-sonnet-4-6", 1_000_000, {
            max_input_tokens: 1_000_000,
            context_window_type: "input",
            vision: true,
          }),
          model("claude-haiku-4-5-20251001", 200_000, {
            max_input_tokens: 200_000,
            context_window_type: "input",
            vision: true,
          }),
        ],
      ),
      provider(
        "google_gemini",
        "Google Gemini",
        "US",
        "https://generativelanguage.googleapis.com/v1beta",
        "google_gemini",
        [
          model("gemini-3.1-pro-preview", 1_000_000, {
            max_input_tokens: 1_000_000,
            max_output_tokens: 64_000,
            context_window_type: "input",
            vision: true,
          }),
          model("gemini-3-flash-preview", 1_000_000, {
            max_input_tokens: 1_000_000,
            max_output_tokens: 64_000,
            context_window_type: "input",
            vision: true,
          }),
          model("gemini-3.1-flash-lite", 1_000_000, {
            max_input_tokens: 1_000_000,
            max_output_tokens: 64_000,
            context_window_type: "input",
            vision: true,
          }),
        ],
      ),
      provider(
        "cohere",
        "Cohere",
        "CA",
        "https://api.cohere.ai/compatibility/v1",
        "chat_completions",
        [
          model("command-a-plus-05-2026", 128_000, {
            max_output_tokens: 64_000,
          }),
          model("command-a-03-2025", 256_000),
        ],
      ),
      provider(
        "xai",
        "xAI Grok",
        "US",
        "https://api.x.ai/v1",
        "chat_completions",
        [
          model("grok-4.3", 1_000_000, { vision: true }),
          model("grok-4.5", 500_000, { vision: true }),
          model("grok-build-0.1", 256_000),
        ],
      ),
      provider(
        "mistral",
        "Mistral AI",
        "FR",
        "https://api.mistral.ai/v1",
        "chat_completions",
        [
          model("mistral-large-latest", 256_000),
          model("mistral-small-latest", 256_000),
          model("codestral-latest", 128_000),
        ],
      ),
      provider(
        "groq",
        "Groq",
        "US",
        "https://api.groq.com/openai/v1",
        "chat_completions",
        [
          model("openai/gpt-oss-120b", 131_072, { max_output_tokens: 65_536 }),
          model("qwen/qwen3.6-27b", 131_072, { max_output_tokens: 16_384 }),
          model("minimaxai/minimax-m2.7", 196_608, {
            max_output_tokens: 131_072,
          }),
        ],
      ),
      provider(
        "together",
        "Together AI",
        "US",
        "https://api.together.ai/v1",
        "chat_completions",
        [
          model("openai/gpt-oss-120b", 131_072, {
            reasoning: standard(["low", "medium", "high"]),
          }),
          model("openai/gpt-oss-20b", 131_072),
        ],
      ),
      provider(
        "openrouter",
        "OpenRouter",
        "US",
        "https://openrouter.ai/api/v1",
        "chat_completions",
        [],
      ),
      provider(
        "perplexity",
        "Perplexity",
        "US",
        "https://api.perplexity.ai",
        "chat_completions",
        [model("sonar", 128_000), model("sonar-pro", 200_000)],
      ),
      provider(
        "cerebras",
        "Cerebras Inference",
        "US",
        "https://api.cerebras.ai/v1",
        "chat_completions",
        [model("gpt-oss-120b", 131_072, { max_output_tokens: 40_960 })],
      ),
      provider(
        "xiaomi_mimo",
        "Xiaomi MiMo",
        "CN",
        "https://token-plan-cn.xiaomimimo.com/v1",
        "responses",
        [
          model("mimo-v2.5", 1_048_576, {
            max_output_tokens: 32_768,
            reasoning: standard(["none", "high"]),
          }),
          model("mimo-v2.5-pro", 1_048_576, {
            max_output_tokens: 131_072,
            reasoning: standard(["none", "high"]),
          }),
        ],
        {
          token_plan_cn: {
            name: "MiMo Token Plan CN",
            base_url: "https://token-plan-cn.xiaomimimo.com/v1",
            protocol: "responses",
          },
          payg_cn: {
            name: "MiMo Pay-as-you-go CN",
            base_url: "https://api.xiaomimimo.com/v1",
            protocol: "responses",
          },
        },
        ["mimo", "xiaomi"],
      ),
      provider(
        "deepseek",
        "DeepSeek",
        "CN",
        "https://api.deepseek.com",
        "responses",
        [
          model("deepseek-v4-pro", 1_000_000, {
            reasoning: standard(["low", "high", "max"]),
          }),
          model("deepseek-v4-flash", 1_000_000, {
            reasoning: standard(["low", "high", "max"]),
          }),
        ],
      ),
      provider(
        "alibaba_qwen",
        "Alibaba Qwen",
        "CN",
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "chat_completions",
        [
          model("qwen3.8-max-preview", 1_000_000, { vision: true }),
          model("qwen3.7-max", 1_000_000, { vision: true }),
          model("qwen3.7-plus", 1_000_000, { vision: true }),
          model("qwen3.6-flash", 1_000_000),
        ],
      ),
      provider(
        "zhipu_glm",
        "Zhipu GLM",
        "CN",
        "https://open.bigmodel.cn/api/paas/v4",
        "chat_completions",
        [
          model("glm-5.2", 1_000_000, { max_output_tokens: 128_000 }),
          model("glm-5.1", 200_000, { max_output_tokens: 128_000 }),
          model("glm-5", 200_000, { max_output_tokens: 128_000 }),
          model("glm-4.7", 200_000, { max_output_tokens: 128_000 }),
        ],
      ),
      provider(
        "moonshot_kimi",
        "Moonshot / Kimi",
        "CN",
        "https://api.moonshot.cn/v1",
        "chat_completions",
        [
          model("kimi-k2.7-code", 262_144),
          model("kimi-k2.6", 262_144),
          model("kimi-k2.5", 262_144),
        ],
        {
          cn: {
            name: "Moonshot CN",
            base_url: "https://api.moonshot.cn/v1",
            protocol: "chat_completions",
          },
          global: {
            name: "Moonshot Global",
            base_url: "https://api.moonshot.ai/v1",
            protocol: "chat_completions",
          },
        },
      ),
      provider(
        "volcengine_ark",
        "Volcengine Ark / Doubao",
        "CN",
        "https://ark.cn-beijing.volces.com/api/v3",
        "responses",
        [model("doubao-seed-2-0-lite-260215"), model("ark-code-latest")],
      ),
      provider(
        "baidu_qianfan",
        "Baidu Qianfan",
        "CN",
        "https://qianfan.baidubce.com/v2",
        "chat_completions",
        [
          model("ernie-4.5-turbo-128k", 128_000),
          model("ernie-x1.1-preview", 64_000),
        ],
      ),
      provider(
        "tencent_hunyuan",
        "Tencent Hunyuan",
        "CN",
        "https://api.hunyuan.cloud.tencent.com/v1",
        "chat_completions",
        [
          model("hunyuan-turbos-latest"),
          model("hunyuan-lite"),
          model("hunyuan-vision", undefined, { vision: true }),
        ],
      ),
      provider(
        "minimax",
        "MiniMax",
        "CN",
        "https://api.minimaxi.com/v1",
        "chat_completions",
        [
          model("MiniMax-M2.7", 204_800),
          model("MiniMax-M2.5", 204_800),
          model("MiniMax-M2.1", 204_800),
        ],
      ),
      provider(
        "siliconflow",
        "SiliconFlow",
        "CN",
        "https://api.siliconflow.cn/v1",
        "chat_completions",
        [],
      ),
      provider(
        "stepfun",
        "StepFun",
        "CN",
        "https://api.stepfun.com/v1",
        "chat_completions",
        [
          model("step-3.5-flash", 262_144),
          model("step-3.5-flash-2603", 262_144),
          model("step-router-v1"),
        ],
      ),
      provider(
        "baichuan",
        "Baichuan",
        "CN",
        "https://api.baichuan-ai.com/v1",
        "chat_completions",
        [model("Baichuan3-Turbo-128k", 131_072), model("Baichuan3-Turbo")],
      ),
      provider(
        "lingyiwanwu",
        "01.AI",
        "CN",
        "https://api.lingyiwanwu.com/v1",
        "chat_completions",
        [model("yi-lightning"), model("yi-large")],
      ),
      provider(
        "iflytek_spark",
        "iFlytek Spark",
        "CN",
        "https://spark-api-open.xf-yun.com/v1",
        "chat_completions",
        [
          model("4.0Ultra", 32_768, {
            max_input_tokens: 32_768,
            max_output_tokens: 32_768,
          }),
          model("spark-x"),
        ],
      ),
      provider(
        "modelscope",
        "ModelScope",
        "CN",
        "https://api-inference.modelscope.cn/v1",
        "chat_completions",
        [],
      ),
      provider(
        "custom_openai_compatible",
        "Custom OpenAI-compatible",
        "custom",
        "",
        "chat_completions",
        [],
      ),
    ].map((item) => [item.id, item]),
  );

export interface ConnectionData extends Record<string, unknown> {
  provider: string;
  endpoint_profile: string;
  base_url: string;
  protocol: ProviderProtocol;
  api_key_ciphertext?: string;
  api_key_checksum?: string;
  api_key_env?: string;
  key_hint?: string;
  last_validated_at?: string;
  last_error?: string;
  settings: Record<string, unknown>;
  default_model?: string;
}

export class ProviderService {
  private readonly store: ResourceStore;
  private readonly cipher: StateCipher;
  constructor(
    private readonly db: Database,
    secret: string,
  ) {
    this.store = new ResourceStore(db);
    this.cipher = new StateCipher(secret);
  }

  catalog(): ProviderDefinition[] {
    return Object.values(PROVIDER_CATALOG);
  }

  private definition(id: string): ProviderDefinition {
    const normalized = Object.values(PROVIDER_CATALOG).find(
      (item) => item.id === id || item.aliases?.includes(id),
    );
    if (!normalized) throw new ValidationError(`unknown provider: ${id}`);
    return normalized;
  }

  async create(
    tenantId: string,
    input: Record<string, unknown>,
  ): Promise<Resource<ConnectionData> & ConnectionData> {
    const definition = this.definition(String(input.provider));
    const endpointProfile = String(
      input.endpoint_profile ?? definition.default_profile,
    );
    const profile = definition.profiles[endpointProfile];
    const custom = definition.id === "custom_openai_compatible";
    const baseUrl = String(
      input.custom_base_url ?? profile?.base_url ?? "",
    ).replace(/\/$/, "");
    const protocol = (input.custom_protocol ?? profile?.protocol) as
      ProviderProtocol | undefined;
    if (!baseUrl || !protocol)
      throw new ValidationError(
        "custom_base_url and custom_protocol are required",
      );
    const apiKey = input.api_key ? String(input.api_key) : undefined;
    const apiKeyEnv = input.api_key_env ? String(input.api_key_env) : undefined;
    if (!apiKey && !apiKeyEnv)
      throw new ValidationError("api_key or api_key_env is required");
    const encrypted = apiKey ? this.cipher.encrypt(apiKey) : undefined;
    const data: ConnectionData = {
      provider: definition.id,
      endpoint_profile: custom ? "custom" : endpointProfile,
      base_url: baseUrl,
      protocol,
      api_key_ciphertext: encrypted?.ciphertext.toString("base64"),
      api_key_checksum: encrypted?.checksum,
      api_key_env: apiKeyEnv,
      key_hint: apiKey
        ? `${apiKey.slice(0, 3)}…${apiKey.slice(-4)}`
        : undefined,
      settings: (input.settings as Record<string, unknown>) ?? {},
    };
    return this.store.create({
      tenantId,
      kind: "provider_connection",
      name: String(input.name),
      data,
      status: "configured",
    });
  }

  async list(tenantId: string) {
    return this.store.list<ConnectionData>(tenantId, "provider_connection");
  }
  async get(tenantId: string, id: string) {
    return this.store.get<ConnectionData>(tenantId, "provider_connection", id);
  }

  async update(tenantId: string, id: string, input: Record<string, unknown>) {
    const current = await this.get(tenantId, id);
    const definition = this.definition(current.provider);
    const profileName = String(
      input.endpoint_profile ?? current.endpoint_profile,
    );
    const profile = definition.profiles[profileName];
    const patch: Partial<ConnectionData> = {};
    if (input.endpoint_profile) {
      patch.endpoint_profile = profileName;
      patch.base_url = profile?.base_url;
      patch.protocol = profile?.protocol;
    }
    if (input.custom_base_url)
      patch.base_url = String(input.custom_base_url).replace(/\/$/, "");
    if (input.custom_protocol)
      patch.protocol = input.custom_protocol as ProviderProtocol;
    if (input.api_key) {
      const key = String(input.api_key);
      const encrypted = this.cipher.encrypt(key);
      patch.api_key_ciphertext = encrypted.ciphertext.toString("base64");
      patch.api_key_checksum = encrypted.checksum;
      patch.api_key_env = undefined;
      patch.key_hint = `${key.slice(0, 3)}…${key.slice(-4)}`;
    }
    if (input.api_key_env) {
      patch.api_key_env = String(input.api_key_env);
      patch.api_key_ciphertext = undefined;
      patch.api_key_checksum = undefined;
    }
    if (input.default_model) patch.default_model = String(input.default_model);
    if (input.settings)
      patch.settings = {
        ...current.settings,
        ...(input.settings as Record<string, unknown>),
      };
    return this.store.update<ConnectionData>(
      tenantId,
      "provider_connection",
      id,
      {
        name: input.name ? String(input.name) : undefined,
        status: input.status ? String(input.status) : undefined,
        data: patch,
      },
    );
  }

  private key(connection: ConnectionData): string {
    if (connection.api_key_env) {
      const key = process.env[connection.api_key_env];
      if (!key)
        throw new ValidationError(
          `provider credential environment variable is missing: ${connection.api_key_env}`,
        );
      return key;
    }
    if (!connection.api_key_ciphertext || !connection.api_key_checksum)
      throw new ValidationError("provider credential is missing");
    return this.cipher
      .decrypt(
        Buffer.from(connection.api_key_ciphertext, "base64"),
        connection.api_key_checksum,
      )
      .toString();
  }

  async syncModels(
    tenantId: string,
    id: string,
  ): Promise<
    Array<Resource<Record<string, unknown>> & Record<string, unknown>>
  > {
    const connection = await this.get(tenantId, id);
    const key = this.key(connection);
    const definition = this.definition(connection.provider);
    let ids: string[] = [];
    if (connection.protocol === "anthropic") {
      const response = await fetch(`${connection.base_url}/models`, {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      if (!response.ok)
        throw new ValidationError(
          `provider model discovery failed: HTTP ${response.status}`,
        );
      const body = (await response.json()) as { data?: Array<{ id: string }> };
      ids = (body.data ?? []).map((item) => item.id);
    } else if (connection.protocol === "google_gemini") {
      const response = await fetch(
        `${connection.base_url}/models?key=${encodeURIComponent(key)}`,
      );
      if (!response.ok)
        throw new ValidationError(
          `provider model discovery failed: HTTP ${response.status}`,
        );
      const body = (await response.json()) as {
        models?: Array<{ name: string }>;
      };
      ids = (body.models ?? []).map((item) =>
        item.name.replace(/^models\//, ""),
      );
    } else {
      const client = new OpenAI({ apiKey: key, baseURL: connection.base_url });
      for await (const item of client.models.list()) ids.push(item.id);
    }
    if (!ids.length) ids = definition.models.map((item) => item.id);
    const existing = await this.store.list<Record<string, unknown>>(
      tenantId,
      "provider_model",
      { parentId: id },
    );
    const byModel = new Map(
      existing.map((item) => [String(item.model_id), item]),
    );
    const output = [];
    for (const modelId of [...new Set(ids)]) {
      const known = definition.models.find((item) => item.id === modelId);
      const data = {
        model_id: modelId,
        display_name: known?.display_name ?? modelId,
        source: known ? "catalog+remote" : "remote",
        capabilities: known?.capabilities ?? model(modelId).capabilities,
        last_seen_at: new Date().toISOString(),
      };
      const current = byModel.get(modelId);
      output.push(
        current
          ? await this.store.update<Record<string, unknown>>(
              tenantId,
              "provider_model",
              current.id,
              { status: "active", data },
            )
          : await this.store.create<Record<string, unknown>>({
              tenantId,
              kind: "provider_model",
              parentId: id,
              name: modelId,
              data,
            }),
      );
    }
    await this.store.update<ConnectionData>(
      tenantId,
      "provider_connection",
      id,
      {
        status: "active",
        data: {
          last_validated_at: new Date().toISOString(),
          last_error: undefined,
          default_model: connection.default_model ?? ids[0],
        },
      },
    );
    return output;
  }

  async listModels(tenantId: string, connectionId: string) {
    const rows = await this.store.list<Record<string, unknown>>(
      tenantId,
      "provider_model",
      { parentId: connectionId, status: "active" },
    );
    if (rows.length) return rows;
    const connection = await this.get(tenantId, connectionId);
    const definition = this.definition(connection.provider);
    return Promise.all(
      definition.models.map((item) =>
        this.store
          .create({
            tenantId,
            kind: "provider_model",
            parentId: connectionId,
            name: item.display_name,
            data: {
              model_id: item.id,
              display_name: item.display_name,
              source: "catalog",
              capabilities: item.capabilities,
            },
          })
          .catch(async (error) => {
            if (error instanceof ConflictError)
              return (
                await this.store.list<Record<string, unknown>>(
                  tenantId,
                  "provider_model",
                  { parentId: connectionId },
                )
              ).find((candidate) => candidate.model_id === item.id)!;
            throw error;
          }),
      ),
    );
  }

  async addModel(
    tenantId: string,
    connectionId: string,
    input: Record<string, unknown>,
  ) {
    await this.get(tenantId, connectionId);
    const modelId = String(input.model_id);
    const known = this.definition(
      (await this.get(tenantId, connectionId)).provider,
    ).models.find((item) => item.id === modelId);
    return this.store.create({
      tenantId,
      kind: "provider_model",
      parentId: connectionId,
      name: String(input.display_name ?? modelId),
      data: {
        model_id: modelId,
        display_name: String(input.display_name ?? modelId),
        source: "user",
        capabilities: {
          ...(known?.capabilities ?? model(modelId).capabilities),
          ...((input.capabilities as object) ?? {}),
          capability_source: "user",
        },
      },
    });
  }

  async validate(tenantId: string, id: string) {
    try {
      const models = await this.syncModels(tenantId, id);
      return { valid: true, model_count: models.length, models };
    } catch (error) {
      await this.store.update<ConnectionData>(
        tenantId,
        "provider_connection",
        id,
        { status: "configured", data: { last_error: String(error) } },
      );
      return { valid: false, error: String(error) };
    }
  }

  async modelFor(connection: ConnectionData, modelId: string): Promise<Model> {
    const apiKey = this.key(connection);
    if (connection.protocol === "anthropic")
      return aisdk(
        createAnthropic({ apiKey, baseURL: connection.base_url })(modelId),
      );
    if (connection.protocol === "google_gemini")
      return aisdk(
        createGoogleGenerativeAI({ apiKey, baseURL: connection.base_url })(
          modelId,
        ),
      );
    return new OpenAIProvider({
      apiKey,
      baseURL: connection.base_url,
      useResponses: connection.protocol === "responses",
    }).getModel(modelId);
  }

  async resolveConfig(
    tenantId: string,
    config: Record<string, unknown>,
  ): Promise<
    Record<string, unknown> & {
      model: string;
      provider: {
        connection_id: string;
        name: string;
        protocol: ProviderProtocol;
      };
      _connection: Resource<ConnectionData> & ConnectionData;
      _capabilities?: ModelCapability;
    }
  > {
    const providerConfig = (config.provider ?? {}) as Record<string, unknown>;
    const connectionId = String(
      providerConfig.connection_id ?? config.provider_connection_id ?? "",
    );
    if (!connectionId)
      throw new ValidationError("agent config requires provider.connection_id");
    const connection = await this.get(tenantId, connectionId);
    const modelId = String(config.model ?? connection.default_model ?? "");
    if (!modelId) throw new ValidationError("agent config requires a model");
    const models = await this.listModels(tenantId, connectionId);
    const capability = models.find((item) => item.model_id === modelId)
      ?.capabilities as ModelCapability | undefined;
    const settings = {
      ...((config.model_settings as Record<string, unknown>) ?? {}),
    };
    const effort = settings.reasoning_effort;
    if (
      effort !== undefined &&
      (!capability?.reasoning.supported ||
        !capability.reasoning.effort_values.includes(String(effort)))
    ) {
      throw new ValidationError(
        `model ${modelId} does not support reasoning effort ${String(effort)}`,
      );
    }
    if (effort !== undefined) {
      const mapped =
        capability?.reasoning.value_map?.[String(effort)] ?? String(effort);
      settings.reasoning = {
        ...((settings.reasoning as Record<string, unknown> | undefined) ?? {}),
        effort: mapped,
      };
      delete settings.reasoning_effort;
    }
    if (settings.max_tokens !== undefined && settings.maxTokens === undefined) {
      settings.maxTokens = settings.max_tokens;
      delete settings.max_tokens;
    }
    if (
      connection.provider === "codex_bridge" &&
      settings.store === undefined
    ) {
      settings.store = false;
    }
    return {
      ...config,
      model: modelId,
      model_settings: settings,
      provider: {
        connection_id: connectionId,
        name: connection.provider,
        protocol: connection.protocol,
      },
      model_context_window:
        config.model_context_window ?? capability?.context_window,
      _connection: connection,
      _capabilities: capability,
    };
  }
}
