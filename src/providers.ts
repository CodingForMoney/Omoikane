import OpenAI from "openai";
import { OpenAIProvider, OpenAIResponsesModel } from "@openai/agents-openai";
import { aisdk } from "@openai/agents-extensions/ai-sdk";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import {
  NoopTrace,
  withTrace,
  type Model,
  type ModelRequest,
} from "@openai/agents";
import type { Database, SqlExecutor } from "./database.js";
import { CredentialCipher } from "./crypto.js";
import { ConflictError, ValidationError } from "./database.js";
import {
  ModelCapabilityOverrideSchema,
  ModelCapabilitySchema,
  ProviderSettingsSchema,
  mergeModelCapabilities,
  normalizeModelCapabilities,
  type ContextCompactionCapability,
  type InputTokenCountingCapability,
  type ModelCapability,
  type ModelTaskCapability,
  type ReasoningCapability,
} from "./provider-capabilities.js";
import { ResourceStore, type Resource } from "./resources.js";
import { hashJson } from "./serialization.js";
import type { PageOptions } from "./pagination.js";
import {
  countWithOfficialTokenizer,
  localTokenizerRequestHasMultimodalInput,
} from "./local-tokenizers.js";

export type ProviderProtocol =
  "responses" | "chat_completions" | "anthropic" | "google_gemini";
export type {
  ContextCompactionCapability,
  InputTokenCountingCapability,
  ModelCapability,
  ModelInputModality,
  ModelKind,
  ModelOutputModality,
  ModelTaskCapability,
  ReasoningCapability,
} from "./provider-capabilities.js";
export interface ProviderModelDefinition {
  id: string;
  display_name: string;
  capabilities: ModelCapability;
  capability_reviewed_at: string;
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

type ModelDiscoveryStatus = "succeeded" | "empty" | "unsupported" | "failed";
interface ModelDiscoveryState {
  status: ModelDiscoveryStatus;
  source: "remote" | "catalog_fallback" | "none";
  remote_model_count: number;
  effective_model_count: number;
  attempted_at: string;
}
interface ProviderOperationError {
  category:
    | "authentication"
    | "rate_limit"
    | "endpoint_unsupported"
    | "provider_unavailable"
    | "network"
    | "invalid_response"
    | "configuration"
    | "unknown";
  operation: "model_discovery";
  retryable: boolean;
  observed_at: string;
  http_status?: number;
  message: string;
}

const CATALOG_REVIEWED_AT = "2026-08-30";
const DEFAULT_DISCOVERY_TIMEOUT_MS = 15_000;
const DEFAULT_DISCOVERY_MAX_RETRIES = 2;
const MAX_DISCOVERY_PAGES = 100;
const PROVIDER_PROTOCOLS = new Set<ProviderProtocol>([
  "responses",
  "chat_completions",
  "anthropic",
  "google_gemini",
]);

class ProviderDiscoveryError extends Error {
  constructor(
    message: string,
    readonly category: ProviderOperationError["category"],
    readonly statusCode?: number,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderDiscoveryError";
  }
}

class ProviderInvocationError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
  ) {
    super(message);
    this.name = "ProviderInvocationError";
  }
}

export class InputTokenCountingProviderError extends Error {
  readonly statusCode: number;
  readonly errorCode = "input_token_counting_provider_unavailable";
  constructor(message: string, statusCode = 503) {
    super(message);
    this.name = "InputTokenCountingProviderError";
    this.statusCode = statusCode;
  }
}

export interface ProviderInputTokenCount {
  input_tokens: number;
}

interface CapturedWireRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

class InputCountingOpenAIResponsesModel extends OpenAIResponsesModel {
  buildCountRequest(request: ModelRequest): Record<string, unknown> {
    return this._buildResponsesCreateRequest(request, false).requestData;
  }
}

const MAX_PROVIDER_JSON_BYTES = 100_000_000;
const MIMO_AUDIO_TIMEOUT_MS = 120_000;
const INPUT_TOKEN_COUNT_TIMEOUT_MS = 30_000;

const jsonBody = async (
  response: Response,
): Promise<Record<string, unknown>> => {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new InputTokenCountingProviderError(
      "Provider Token count response was not valid JSON",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InputTokenCountingProviderError(
      "Provider Token count response was not an object",
    );
  return value as Record<string, unknown>;
};

const countFrom = (value: unknown, field: string): number => {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0)
    throw new InputTokenCountingProviderError(
      `Provider Token count response did not contain a valid ${field}`,
    );
  return count;
};

async function boundedJsonResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_PROVIDER_JSON_BYTES
  )
    throw new ProviderInvocationError(
      "Provider audio response exceeded the Runtime size limit",
    );
  if (!response.body)
    throw new ProviderInvocationError("Provider returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PROVIDER_JSON_BYTES) {
      await reader.cancel();
      throw new ProviderInvocationError(
        "Provider audio response exceeded the Runtime size limit",
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ProviderInvocationError(
      "Provider returned an invalid audio response",
    );
  }
}

function validatedProviderSettings(value: unknown): Record<string, unknown> {
  const result = ProviderSettingsSchema.safeParse(value ?? {});
  if (!result.success)
    throw new ValidationError(
      `invalid Provider settings: ${result.error.issues[0]?.message ?? "invalid value"}`,
    );
  return result.data;
}

function validatedCapabilityOverride(value: unknown): Record<string, unknown> {
  const result = ModelCapabilityOverrideSchema.safeParse(value ?? {});
  if (!result.success)
    throw new ValidationError(
      `invalid model capabilities: ${result.error.issues[0]?.message ?? "invalid value"}`,
    );
  return result.data;
}

function validatedCapabilityMerge(
  base: ModelCapability,
  override: Record<string, unknown>,
): ModelCapability {
  try {
    return mergeModelCapabilities(base, override);
  } catch (error) {
    const issues =
      error && typeof error === "object" && "issues" in error
        ? (error as { issues?: Array<{ message?: string }> }).issues
        : undefined;
    throw new ValidationError(
      `invalid model capabilities: ${issues?.[0]?.message ?? "invalid effective capability"}`,
    );
  }
}

function validatedBaseUrl(value: unknown): string {
  try {
    const url = new URL(String(value));
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("unsupported URL");
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new ValidationError(
      "custom_base_url must be an HTTP(S) URL without credentials, query, or fragment",
    );
  }
}

function validatedProtocol(value: unknown): ProviderProtocol {
  const protocol = String(value) as ProviderProtocol;
  if (!PROVIDER_PROTOCOLS.has(protocol))
    throw new ValidationError(
      `unsupported Provider protocol: ${String(value)}`,
    );
  return protocol;
}

const noReasoning = (): ReasoningCapability => ({
  supported: false,
  effort_values: [],
});
const noContextCompaction = (): ContextCompactionCapability => ({
  supported: false,
});
const noInputTokenCounting = (): InputTokenCountingCapability => ({
  status: "unavailable",
});
const providerInputTokenCounting = (
  method: Exclude<InputTokenCountingCapability["method"], undefined>,
  accuracy: Exclude<InputTokenCountingCapability["accuracy"], undefined>,
): InputTokenCountingCapability => ({
  status: "qualified",
  scope: "assembled_model_input",
  method,
  accuracy,
  reviewed_at: CATALOG_REVIEWED_AT,
});
const localTokenizerInputCounting = (
  tokenizer_id: string,
  tokenizer_revision: string,
): InputTokenCountingCapability => ({
  status: "qualified",
  scope: "assembled_model_input",
  method: "official_local_tokenizer",
  accuracy: "verified_local",
  tokenizer_id,
  tokenizer_revision,
  supported_input_modalities: ["text"],
  reviewed_at: CATALOG_REVIEWED_AT,
});
const responsesCompaction = (): ContextCompactionCapability => ({
  supported: true,
  method: "responses_compact",
});
const standard = (
  effort_values = ["none", "low", "medium", "high", "xhigh"],
): ReasoningCapability => ({
  supported: true,
  adapter: "reasoning_effort",
  effort_values,
});
const noModelTasks = (): ModelTaskCapability => ({
  image_understanding: "none",
  transcription: "none",
  speech_synthesis: "none",
});
type ModelOptions = Omit<Partial<ModelCapability>, "tasks"> & {
  tasks?: Partial<ModelTaskCapability>;
};
const model = (
  id: string,
  context_window?: number,
  options: ModelOptions = {},
): ProviderModelDefinition => {
  const imageUnderstanding =
    options.tasks?.image_understanding ??
    (options.vision || options.input_modalities?.includes("image")
      ? "native"
      : "none");
  const inputModalities = options.input_modalities
    ? [...options.input_modalities]
    : imageUnderstanding === "native"
      ? (["text", "image"] as const)
      : (["text"] as const);
  const capabilities = ModelCapabilitySchema.parse({
    streaming: true,
    tools: true,
    structured_output: "prompt",
    context_window,
    context_window_type: "total",
    capability_source: "catalog",
    capability_status: "catalog",
    reasoning: noReasoning(),
    context_compaction: noContextCompaction(),
    input_token_counting: noInputTokenCounting(),
    ...options,
    model_kind: options.model_kind ?? "agent",
    input_modalities: inputModalities,
    output_modalities: options.output_modalities ?? ["text"],
    tasks: {
      ...noModelTasks(),
      ...options.tasks,
      image_understanding: imageUnderstanding,
    },
    vision: imageUnderstanding === "native",
  });
  return {
    id,
    display_name: id,
    capabilities,
    capability_reviewed_at: CATALOG_REVIEWED_AT,
  };
};
const unknownModelCapabilities = (): ModelCapability =>
  ModelCapabilitySchema.parse({
    model_kind: "agent",
    input_modalities: ["text"],
    output_modalities: ["text"],
    tasks: noModelTasks(),
    streaming: false,
    tools: false,
    vision: false,
    structured_output: "prompt",
    context_window_type: "total",
    capability_source: "remote",
    capability_status: "unknown",
    reasoning: noReasoning(),
    context_compaction: noContextCompaction(),
    input_token_counting: noInputTokenCounting(),
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
            input_token_counting: providerInputTokenCounting(
              "openai_responses_input_tokens",
              "authoritative_exact",
            ),
            vision: true,
            structured_output: "native",
            context_compaction: responsesCompaction(),
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
            input_token_counting: providerInputTokenCounting(
              "openai_responses_input_tokens",
              "authoritative_exact",
            ),
            vision: true,
            structured_output: "native",
            context_compaction: responsesCompaction(),
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
            input_token_counting: providerInputTokenCounting(
              "openai_responses_input_tokens",
              "authoritative_exact",
            ),
            vision: true,
            structured_output: "native",
            context_compaction: responsesCompaction(),
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
            input_token_counting: providerInputTokenCounting(
              "openai_responses_input_tokens",
              "authoritative_exact",
            ),
            vision: true,
            structured_output: "native",
            context_compaction: responsesCompaction(),
            reasoning: standard(),
          }),
          model("gpt-5.4-mini", 400_000, {
            max_output_tokens: 128_000,
            vision: true,
            structured_output: "native",
            context_compaction: responsesCompaction(),
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
            context_compaction: responsesCompaction(),
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
            context_compaction: responsesCompaction(),
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
            input_token_counting: providerInputTokenCounting(
              "anthropic_messages_count_tokens",
              "provider_estimate",
            ),
          }),
          model("claude-sonnet-5", 1_000_000, {
            max_input_tokens: 1_000_000,
            context_window_type: "input",
            vision: true,
            input_token_counting: providerInputTokenCounting(
              "anthropic_messages_count_tokens",
              "provider_estimate",
            ),
          }),
          model("claude-opus-4-6", 1_000_000, {
            max_input_tokens: 1_000_000,
            context_window_type: "input",
            vision: true,
            input_token_counting: providerInputTokenCounting(
              "anthropic_messages_count_tokens",
              "provider_estimate",
            ),
          }),
          model("claude-sonnet-4-6", 1_000_000, {
            max_input_tokens: 1_000_000,
            context_window_type: "input",
            vision: true,
            input_token_counting: providerInputTokenCounting(
              "anthropic_messages_count_tokens",
              "provider_estimate",
            ),
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
            input_modalities: ["text", "image", "audio", "video"],
            tasks: {
              image_understanding: "native",
              transcription: "general",
            },
            input_token_counting: providerInputTokenCounting(
              "gemini_count_tokens",
              "provider_estimate",
            ),
          }),
          model("gemini-3-flash-preview", 1_000_000, {
            max_input_tokens: 1_000_000,
            max_output_tokens: 64_000,
            context_window_type: "input",
            input_modalities: ["text", "image", "audio", "video"],
            tasks: {
              image_understanding: "native",
              transcription: "general",
            },
            input_token_counting: providerInputTokenCounting(
              "gemini_count_tokens",
              "provider_estimate",
            ),
          }),
          model("gemini-3.1-flash-lite", 1_000_000, {
            max_input_tokens: 1_000_000,
            max_output_tokens: 64_000,
            context_window_type: "input",
            input_modalities: ["text", "image", "audio", "video"],
            tasks: {
              image_understanding: "native",
              transcription: "general",
            },
            input_token_counting: providerInputTokenCounting(
              "gemini_count_tokens",
              "provider_estimate",
            ),
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
            vision: true,
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
          model("grok-build-0.1", 256_000, { vision: true }),
        ],
      ),
      provider(
        "mistral",
        "Mistral AI",
        "FR",
        "https://api.mistral.ai/v1",
        "chat_completions",
        [
          model("mistral-large-latest", 256_000, { vision: true }),
          model("mistral-small-latest", 256_000, { vision: true }),
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
          model("qwen/qwen3.6-27b", 131_072, {
            max_output_tokens: 16_384,
            vision: true,
          }),
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
        [
          model("sonar", 128_000, { vision: true }),
          model("sonar-pro", 200_000, { vision: true }),
        ],
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
            input_token_counting: localTokenizerInputCounting(
              "XiaomiMiMo/MiMo-V2.5",
              "63651580ca774f8504f676040460aed3e1244ac1",
            ),
            input_modalities: ["text", "image", "audio", "video"],
            tasks: {
              image_understanding: "native",
              transcription: "general",
            },
            reasoning: standard(["none", "high"]),
          }),
          model("mimo-v2.5-pro", 1_048_576, {
            max_output_tokens: 131_072,
            input_token_counting: localTokenizerInputCounting(
              "XiaomiMiMo/MiMo-V2.5-Pro",
              "21d1ecfecd7bd70f31be25ca49d7edd21f003659",
            ),
            reasoning: standard(["none", "high"]),
          }),
          model("mimo-v2.5-asr", 8_192, {
            model_kind: "transcription",
            input_modalities: ["audio"],
            output_modalities: ["text"],
            tasks: { transcription: "dedicated" },
            max_output_tokens: 2_048,
            streaming: false,
            tools: false,
            structured_output: "none",
          }),
          model("mimo-v2.5-tts", 8_192, {
            model_kind: "speech_synthesis",
            input_modalities: ["text"],
            output_modalities: ["audio"],
            tasks: { speech_synthesis: "dedicated" },
            max_output_tokens: 8_192,
            streaming: false,
            tools: false,
            structured_output: "none",
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
            input_token_counting: localTokenizerInputCounting(
              "deepseek-ai/DeepSeek-V4-Pro",
              "b5968e9190ef611bbf34a7229255be88a0e937c1",
            ),
            reasoning: standard(["low", "high", "max"]),
          }),
          model("deepseek-v4-flash", 1_000_000, {
            input_token_counting: localTokenizerInputCounting(
              "deepseek-ai/DeepSeek-V4-Flash",
              "60d8d70770c6776ff598c94bb586a859a38244f1",
            ),
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
          model("qwen3.8-max-preview", 1_000_000, {
            vision: true,
            input_token_counting: localTokenizerInputCounting(
              "Qwen/Qwen3.8-2.4T-A95B",
              "207bd685a7e3696cfaff12ded7c6a7ea0f88c996",
            ),
          }),
          model("qwen3.7-max", 1_000_000, { vision: true }),
          model("qwen3.7-plus", 1_000_000, { vision: true }),
          model("qwen3.6-flash", 1_000_000, { vision: true }),
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
          model("kimi-k2.6", 262_144, { vision: true }),
          model("kimi-k2.5", 262_144, { vision: true }),
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
        [
          model("doubao-seed-2-0-lite-260215", undefined, { vision: true }),
          model("ark-code-latest", undefined, { model_kind: "routing" }),
        ],
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
          model("step-router-v1", undefined, { model_kind: "routing" }),
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
  last_error_details?: ProviderOperationError;
  model_discovery?: ModelDiscoveryState;
  settings: Record<string, unknown>;
  default_model?: string;
  default_model_status?: "available" | "unavailable" | "unset";
}

interface ProviderModelData extends Record<string, unknown> {
  model_id: string;
  display_name: string;
  source: string;
  capabilities: ModelCapability;
  catalog_capabilities?: ModelCapability;
  user_capability_overrides?: Record<string, unknown>;
  manually_added?: boolean;
  last_seen_at?: string;
  last_sync_at?: string;
  remote_presence?: "visible" | "not_listed" | "unknown";
  capability_provenance: {
    source: "catalog" | "conservative_unknown" | "user";
    catalog_reviewed_at?: string;
    remote_model_id_seen_at?: string;
    user_overridden_at?: string;
  };
}

function normalizedProviderModel(
  row: Resource<ProviderModelData> & ProviderModelData,
): Resource<ProviderModelData> & ProviderModelData {
  return {
    ...row,
    capabilities: normalizeModelCapabilities(row.capabilities),
    ...(row.catalog_capabilities
      ? {
          catalog_capabilities: normalizeModelCapabilities(
            row.catalog_capabilities,
          ),
        }
      : {}),
  };
}

interface DiscoveryResult {
  ids: string[];
  status: "succeeded" | "empty";
  attemptedAt: string;
}

export class ProviderService {
  private readonly store: ResourceStore;
  private readonly cipher: CredentialCipher;
  constructor(
    private readonly db: Database,
    secret: string,
  ) {
    this.store = new ResourceStore(db);
    this.cipher = new CredentialCipher(secret);
  }

  catalog(): ProviderDefinition[] {
    return Object.values(PROVIDER_CATALOG);
  }

  inputTokenCountingModels(minimumContextWindow = 1_000_000) {
    return this.catalog().flatMap((definition) =>
      definition.models
        .filter(
          (item) =>
            Number(item.capabilities.context_window ?? 0) >=
              minimumContextWindow &&
            item.capabilities.input_token_counting.status === "qualified",
        )
        .map((item) => ({
          provider: definition.id,
          provider_name: definition.name,
          model_id: item.id,
          display_name: item.display_name,
          context_window_tokens: item.capabilities.context_window!,
          context_window_type: item.capabilities.context_window_type,
          max_input_tokens: item.capabilities.max_input_tokens,
          max_output_tokens: item.capabilities.max_output_tokens,
          input_token_counting: item.capabilities.input_token_counting,
          capability_reviewed_at: item.capability_reviewed_at,
        })),
    );
  }

  private definition(id: string): ProviderDefinition {
    const normalized = Object.values(PROVIDER_CATALOG).find(
      (item) => item.id === id || item.aliases?.includes(id),
    );
    if (!normalized) throw new ValidationError(`unknown provider: ${id}`);
    return normalized;
  }

  async create(
    input: Record<string, unknown>,
  ): Promise<Resource<ConnectionData> & ConnectionData> {
    const definition = this.definition(String(input.provider));
    const endpointProfile = String(
      input.endpoint_profile ?? definition.default_profile,
    );
    const profile = definition.profiles[endpointProfile];
    const custom = definition.id === "custom_openai_compatible";
    if (!custom && (input.custom_base_url || input.custom_protocol))
      throw new ValidationError(
        "custom_base_url and custom_protocol are only valid for custom_openai_compatible",
      );
    if (!custom && !profile)
      throw new ValidationError(
        `unknown endpoint profile ${endpointProfile} for provider ${definition.id}`,
      );
    if (custom && (!input.custom_base_url || !input.custom_protocol))
      throw new ValidationError(
        "custom_base_url and custom_protocol are required",
      );
    const baseUrl = custom
      ? validatedBaseUrl(input.custom_base_url)
      : profile!.base_url;
    const protocol = custom
      ? validatedProtocol(input.custom_protocol)
      : profile!.protocol;
    const apiKey = input.api_key ? String(input.api_key) : undefined;
    const apiKeyEnv = input.api_key_env ? String(input.api_key_env) : undefined;
    if (!apiKey && !apiKeyEnv)
      throw new ValidationError("api_key or api_key_env is required");
    if (apiKey && apiKeyEnv)
      throw new ValidationError(
        "api_key and api_key_env are mutually exclusive",
      );
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
      settings: validatedProviderSettings(input.settings),
      default_model_status: "unset",
    };
    return this.store.create({
      kind: "provider_connection",
      name: String(input.name),
      data,
      status: "configured",
    });
  }

  async list() {
    return this.store.list<ConnectionData>("provider_connection");
  }
  async page(options: PageOptions & { status?: string } = {}) {
    return this.store.page<ConnectionData>("provider_connection", options);
  }
  async get(id: string) {
    return this.store.get<ConnectionData>("provider_connection", id);
  }

  async delete(id: string) {
    const current = await this.get(id);
    const referenced = await this.db.query<{ id: string }>(
      `SELECT id FROM resources WHERE kind='agent_deployment'
       AND data->'config'->'provider'->>'connection_id'=$1 LIMIT 1`,
      [current.id],
    );
    if (referenced.rows.length)
      throw new ConflictError(
        `Provider connection ${current.id} is referenced by an Agent deployment`,
      );
    const models = await this.store.list("provider_model", {
      parentId: current.id,
      limit: 2_000,
    });
    for (const model of models)
      await this.store.delete("provider_model", model.id);
    await this.store.delete("provider_connection", current.id);
  }

  async verifyStoredCredentialEncryption(): Promise<number> {
    const connections = (
      await this.db.query<{ id: string; data: ConnectionData }>(
        "SELECT id,data FROM resources WHERE kind='provider_connection'",
      )
    ).rows.map((row) => ({ id: row.id, ...row.data }));
    let verified = 0;
    for (const connection of connections) {
      const hasCiphertext = Boolean(connection.api_key_ciphertext);
      const hasChecksum = Boolean(connection.api_key_checksum);
      if (hasCiphertext !== hasChecksum)
        throw new ValidationError(
          `provider ${connection.id} has an incomplete encrypted credential`,
        );
      if (!hasCiphertext) continue;
      this.cipher.decrypt(
        Buffer.from(connection.api_key_ciphertext!, "base64"),
        connection.api_key_checksum!,
      );
      verified += 1;
    }
    return verified;
  }

  async update(id: string, input: Record<string, unknown>) {
    const current = await this.get(id);
    if (input.api_key && input.api_key_env)
      throw new ValidationError(
        "api_key and api_key_env are mutually exclusive",
      );
    const definition = this.definition(current.provider);
    const profileName = String(
      input.endpoint_profile ?? current.endpoint_profile,
    );
    const profile = definition.profiles[profileName];
    const custom = definition.id === "custom_openai_compatible";
    if (!custom && (input.custom_base_url || input.custom_protocol))
      throw new ValidationError(
        "custom_base_url and custom_protocol are only valid for custom_openai_compatible",
      );
    if (custom && input.endpoint_profile)
      throw new ValidationError(
        "custom_openai_compatible does not use endpoint profiles",
      );
    if (!custom && input.endpoint_profile && !profile)
      throw new ValidationError(
        `unknown endpoint profile ${profileName} for provider ${definition.id}`,
      );
    const patch: Partial<ConnectionData> = {};
    if (input.endpoint_profile) {
      patch.endpoint_profile = profileName;
      patch.base_url = profile!.base_url;
      patch.protocol = profile!.protocol;
    }
    if (input.custom_base_url)
      patch.base_url = validatedBaseUrl(input.custom_base_url);
    if (input.custom_protocol)
      patch.protocol = validatedProtocol(input.custom_protocol);
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
    if (input.default_model) {
      const modelId = String(input.default_model);
      const active = await this.listModels(id);
      if (!active.some((item) => item.model_id === modelId))
        throw new ValidationError(
          `default model ${modelId} is not active for Provider connection ${id}`,
        );
      patch.default_model = modelId;
      patch.default_model_status = "available";
    }
    if (input.settings) {
      patch.settings = validatedProviderSettings({
        ...current.settings,
        ...(input.settings as Record<string, unknown>),
      });
    }
    return this.store.update<ConnectionData>("provider_connection", id, {
      name: input.name ? String(input.name) : undefined,
      status: input.status ? String(input.status) : undefined,
      data: patch,
    });
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

  private async providerCountJson(
    url: string,
    init: RequestInit,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(INPUT_TOKEN_COUNT_TIMEOUT_MS),
      });
    } catch {
      throw new InputTokenCountingProviderError(
        "Provider input Token count request failed",
      );
    }
    if (!response.ok)
      throw new InputTokenCountingProviderError(
        `Provider input Token count request failed with HTTP ${response.status}`,
        response.status === 429 ? 429 : response.status >= 500 ? 503 : 502,
      );
    return jsonBody(response);
  }

  private async captureAiSdkWireRequest(
    protocol: "anthropic" | "google_gemini",
    connection: ConnectionData,
    modelId: string,
    request: ModelRequest,
  ): Promise<CapturedWireRequest> {
    let captured: CapturedWireRequest | undefined;
    const captureFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const outgoing = new Request(input, init);
      const raw = await outgoing.clone().text();
      const parsed = raw ? (JSON.parse(raw) as unknown) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Provider request body was not an object");
      captured = {
        url: outgoing.url,
        headers: new Headers(outgoing.headers),
        body: parsed as Record<string, unknown>,
      };
      throw new Error("OMOIKANE_PROVIDER_REQUEST_CAPTURED");
    };
    const providerModel =
      protocol === "anthropic"
        ? createAnthropic({
            apiKey: "capture-only",
            baseURL: connection.base_url,
            fetch: captureFetch,
          })(modelId)
        : createGoogleGenerativeAI({
            apiKey: "capture-only",
            baseURL: connection.base_url,
            fetch: captureFetch,
          })(modelId);
    try {
      await withTrace(new NoopTrace(), () =>
        aisdk(providerModel).getResponse({
          ...request,
          signal: undefined,
        }),
      );
    } catch {
      // The capture transport deliberately stops before external I/O.
    }
    if (!captured)
      throw new InputTokenCountingProviderError(
        "Could not compile the assembled input into the Provider request",
      );
    return captured;
  }

  private async captureOpenAiChatWireRequest(
    modelId: string,
    request: ModelRequest,
  ): Promise<CapturedWireRequest> {
    let captured: CapturedWireRequest | undefined;
    const captureFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const outgoing = new Request(input, init);
      const raw = await outgoing.clone().text();
      const parsed = raw ? (JSON.parse(raw) as unknown) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Provider request body was not an object");
      captured = {
        url: outgoing.url,
        headers: new Headers(outgoing.headers),
        body: parsed as Record<string, unknown>,
      };
      throw new Error("OMOIKANE_PROVIDER_REQUEST_CAPTURED");
    };
    const client = new OpenAI({
      apiKey: "capture-only",
      baseURL: "http://127.0.0.1:1/v1",
      fetch: captureFetch,
      maxRetries: 0,
    });
    const provider = new OpenAIProvider({
      openAIClient: client,
      useResponses: false,
    });
    try {
      const model = await provider.getModel(modelId);
      await withTrace(new NoopTrace(), () =>
        model.getResponse({ ...request, signal: undefined }),
      );
    } catch {
      // The capture transport deliberately stops before external I/O.
    } finally {
      await provider.close();
    }
    if (!captured)
      throw new InputTokenCountingProviderError(
        "Could not compile the assembled input into OpenAI-compatible messages",
      );
    return captured;
  }

  private async countOpenAiResponsesInput(
    connection: ConnectionData,
    modelId: string,
    request: ModelRequest,
  ): Promise<number> {
    const client = new OpenAI({
      apiKey: this.key(connection),
      baseURL: connection.base_url,
      maxRetries: 0,
    });
    const requestData = new InputCountingOpenAIResponsesModel(
      client,
      modelId,
    ).buildCountRequest(request);
    const supportedFields = new Set([
      "conversation",
      "input",
      "instructions",
      "model",
      "parallel_tool_calls",
      "personality",
      "previous_response_id",
      "reasoning",
      "text",
      "tool_choice",
      "tools",
      "truncation",
    ]);
    const countRequest = Object.fromEntries(
      Object.entries(requestData).filter(
        ([key, value]) => supportedFields.has(key) && value !== undefined,
      ),
    );
    try {
      const result = await client.responses.inputTokens.count(
        countRequest as never,
        { timeout: INPUT_TOKEN_COUNT_TIMEOUT_MS, maxRetries: 0 },
      );
      return countFrom(result.input_tokens, "input_tokens");
    } catch (error) {
      if (error instanceof InputTokenCountingProviderError) throw error;
      const status = Number((error as { status?: unknown }).status);
      throw new InputTokenCountingProviderError(
        Number.isFinite(status)
          ? `Provider input Token count request failed with HTTP ${status}`
          : "Provider input Token count request failed",
        status === 429 ? 429 : status >= 500 ? 503 : 502,
      );
    }
  }

  private async countAnthropicInput(
    connection: ConnectionData,
    modelId: string,
    request: ModelRequest,
  ): Promise<number> {
    const wire = await this.captureAiSdkWireRequest(
      "anthropic",
      connection,
      modelId,
      request,
    );
    const supportedFields = new Set([
      "model",
      "messages",
      "system",
      "tools",
      "tool_choice",
      "thinking",
      "output_config",
    ]);
    const body = Object.fromEntries(
      Object.entries(wire.body).filter(
        ([key, value]) => supportedFields.has(key) && value !== undefined,
      ),
    );
    const beta = wire.headers.get("anthropic-beta");
    const result = await this.providerCountJson(
      `${connection.base_url}/messages/count_tokens`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.key(connection),
          "anthropic-version":
            wire.headers.get("anthropic-version") ?? "2023-06-01",
          ...(beta ? { "anthropic-beta": beta } : {}),
        },
        body: JSON.stringify(body),
      },
    );
    return countFrom(result.input_tokens, "input_tokens");
  }

  private async countGeminiInput(
    connection: ConnectionData,
    modelId: string,
    request: ModelRequest,
  ): Promise<number> {
    const wire = await this.captureAiSdkWireRequest(
      "google_gemini",
      connection,
      modelId,
      request,
    );
    const result = await this.providerCountJson(
      `${connection.base_url}/models/${encodeURIComponent(modelId)}:countTokens`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.key(connection),
        },
        body: JSON.stringify({ generateContentRequest: wire.body }),
      },
    );
    return countFrom(result.totalTokens, "totalTokens");
  }

  private async countOfficialLocalTokenizerInput(
    modelId: string,
    request: ModelRequest,
    capability: InputTokenCountingCapability,
  ): Promise<number> {
    if (!capability.tokenizer_id || !capability.tokenizer_revision)
      throw new InputTokenCountingProviderError(
        `model ${modelId} does not declare an immutable official Tokenizer`,
        422,
      );
    if (localTokenizerRequestHasMultimodalInput(request))
      throw new InputTokenCountingProviderError(
        `model ${modelId} local Tokenizer supports text input only`,
        422,
      );
    const wire = await this.captureOpenAiChatWireRequest(modelId, request);
    try {
      return await countWithOfficialTokenizer(wire.body, {
        tokenizer_id: capability.tokenizer_id,
        tokenizer_revision: capability.tokenizer_revision,
      });
    } catch (error) {
      throw new InputTokenCountingProviderError(
        error instanceof Error
          ? `official local Tokenizer failed: ${error.message}`
          : "official local Tokenizer failed",
        503,
      );
    }
  }

  async countModelInputTokens(
    connection: ConnectionData,
    modelId: string,
    request: ModelRequest,
    capability: InputTokenCountingCapability,
  ): Promise<ProviderInputTokenCount> {
    if (capability.status !== "qualified" || !capability.method)
      throw new InputTokenCountingProviderError(
        `model ${modelId} does not have qualified input Token counting`,
        422,
      );
    const inputTokens =
      capability.method === "openai_responses_input_tokens"
        ? await this.countOpenAiResponsesInput(connection, modelId, request)
        : capability.method === "anthropic_messages_count_tokens"
          ? await this.countAnthropicInput(connection, modelId, request)
          : capability.method === "gemini_count_tokens"
            ? await this.countGeminiInput(connection, modelId, request)
            : capability.method === "official_local_tokenizer"
              ? await this.countOfficialLocalTokenizerInput(
                  modelId,
                  request,
                  capability,
                )
              : undefined;
    if (inputTokens === undefined)
      throw new InputTokenCountingProviderError(
        `input Token counting adapter is unavailable for ${capability.method}`,
        422,
      );
    return { input_tokens: inputTokens };
  }

  compactionIssuerFingerprint(
    connection: ConnectionData,
    modelId: string,
  ): string {
    return hashJson({
      provider: connection.provider,
      protocol: connection.protocol,
      base_url: connection.base_url,
      model: modelId,
      credential: this.cipher.fingerprint(this.key(connection)),
    });
  }

  async compactResponses(
    connection: ConnectionData,
    modelId: string,
    input: unknown[],
    options: { instructions?: string; signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    if (connection.protocol !== "responses")
      throw new ValidationError(
        `provider ${connection.provider} does not use the Responses protocol`,
      );
    const client = new OpenAI({
      apiKey: this.key(connection),
      baseURL: connection.base_url,
      maxRetries: 0,
    });
    return (await client.responses.compact(
      {
        model: modelId,
        input: input as never,
        ...(options.instructions ? { instructions: options.instructions } : {}),
      },
      options.signal ? { signal: options.signal } : undefined,
    )) as unknown as Record<string, unknown>;
  }

  private async dedicatedAudioModel(
    connectionId: string,
    modelId: string,
    task: "transcription" | "speech_synthesis",
  ) {
    const connection = await this.get(connectionId);
    if (connection.provider !== "xiaomi_mimo")
      throw new ValidationError(
        `provider ${connection.provider} does not implement the MiMo audio adapter`,
      );
    const selected = (await this.listModels(connectionId)).find(
      (item) => item.model_id === modelId,
    );
    if (!selected)
      throw new ValidationError(
        `model ${modelId} is not active for Provider connection ${connectionId}`,
      );
    const capability = selected.capabilities as ModelCapability;
    if (capability.tasks[task] !== "dedicated")
      throw new ValidationError(
        `model ${modelId} does not provide dedicated ${task}`,
      );
    return connection;
  }

  private async mimoAudioCompletion(
    connectionId: string,
    modelId: string,
    task: "transcription" | "speech_synthesis",
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const connection = await this.dedicatedAudioModel(
      connectionId,
      modelId,
      task,
    );
    let response: Response;
    try {
      response = await fetch(`${connection.base_url}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.key(connection)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...body, model: modelId, stream: false }),
        signal: AbortSignal.timeout(MIMO_AUDIO_TIMEOUT_MS),
      });
    } catch (error) {
      const timeout =
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError");
      throw new ProviderInvocationError(
        timeout
          ? "Provider audio request timed out"
          : "Provider audio request failed",
        503,
      );
    }
    if (!response.ok) {
      if (response.status === 429)
        throw new ProviderInvocationError(
          "Provider rate-limited the audio request",
          429,
        );
      throw new ProviderInvocationError(
        `Provider audio request failed with HTTP ${response.status}`,
        response.status >= 500 ? 503 : 502,
      );
    }
    return boundedJsonResponse(response);
  }

  async transcribeAudio(
    connectionId: string,
    input: {
      model: string;
      audio: { data: string; format: "mp3" | "wav" };
      language: "auto" | "zh" | "en";
    },
  ): Promise<{
    model: string;
    text: string;
    usage?: Record<string, unknown>;
  }> {
    const mimeType = input.audio.format === "mp3" ? "audio/mpeg" : "audio/wav";
    const result = await this.mimoAudioCompletion(
      connectionId,
      input.model,
      "transcription",
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: {
                  data: `data:${mimeType};base64,${input.audio.data}`,
                },
              },
            ],
          },
        ],
        asr_options: { language: input.language },
      },
    );
    const choices = Array.isArray(result.choices) ? result.choices : [];
    const first = choices[0] as Record<string, unknown> | undefined;
    const message =
      first?.message && typeof first.message === "object"
        ? (first.message as Record<string, unknown>)
        : undefined;
    if (typeof message?.content !== "string")
      throw new ProviderInvocationError(
        "Provider transcription response did not contain text",
      );
    return {
      model: input.model,
      text: message.content,
      ...(result.usage &&
      typeof result.usage === "object" &&
      !Array.isArray(result.usage)
        ? { usage: result.usage as Record<string, unknown> }
        : {}),
    };
  }

  async synthesizeSpeech(
    connectionId: string,
    input: {
      model: string;
      input: string;
      voice?: string;
      format: "wav" | "mp3";
      instructions?: string;
    },
  ): Promise<{
    model: string;
    audio: { data: string; format: "wav" | "mp3"; mime_type: string };
    usage?: Record<string, unknown>;
  }> {
    const result = await this.mimoAudioCompletion(
      connectionId,
      input.model,
      "speech_synthesis",
      {
        messages: [
          ...(input.instructions
            ? [{ role: "user", content: input.instructions }]
            : []),
          { role: "assistant", content: input.input },
        ],
        audio: {
          format: input.format,
          ...(input.voice ? { voice: input.voice } : {}),
        },
      },
    );
    const choices = Array.isArray(result.choices) ? result.choices : [];
    const first = choices[0] as Record<string, unknown> | undefined;
    const message =
      first?.message && typeof first.message === "object"
        ? (first.message as Record<string, unknown>)
        : undefined;
    const audio =
      message?.audio && typeof message.audio === "object"
        ? (message.audio as Record<string, unknown>)
        : undefined;
    if (typeof audio?.data !== "string" || !audio.data)
      throw new ProviderInvocationError(
        "Provider speech response did not contain audio",
      );
    return {
      model: input.model,
      audio: {
        data: audio.data,
        format: input.format,
        mime_type: input.format === "mp3" ? "audio/mpeg" : "audio/wav",
      },
      ...(result.usage &&
      typeof result.usage === "object" &&
      !Array.isArray(result.usage)
        ? { usage: result.usage as Record<string, unknown> }
        : {}),
    };
  }

  private discoveryOptions(connection: ConnectionData) {
    const settings = validatedProviderSettings(connection.settings);
    return {
      timeoutMs: Number(
        settings.model_discovery_timeout_ms ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
      ),
      maxRetries: Number(
        settings.model_discovery_max_retries ?? DEFAULT_DISCOVERY_MAX_RETRIES,
      ),
    };
  }

  private discoveryError(error: unknown): ProviderDiscoveryError {
    if (error instanceof ProviderDiscoveryError) return error;
    const value =
      error && typeof error === "object"
        ? (error as Record<string, unknown>)
        : {};
    const status = Number(value.status ?? value.statusCode);
    if (status === 401 || status === 403)
      return new ProviderDiscoveryError(
        "Provider rejected the credential during model discovery",
        "authentication",
        status,
      );
    if (status === 429)
      return new ProviderDiscoveryError(
        "Provider rate-limited model discovery",
        "rate_limit",
        status,
        true,
      );
    if ([404, 405, 501].includes(status))
      return new ProviderDiscoveryError(
        "Provider does not expose a compatible model discovery endpoint",
        "endpoint_unsupported",
        status,
      );
    if (status >= 500)
      return new ProviderDiscoveryError(
        "Provider was unavailable during model discovery",
        "provider_unavailable",
        status,
        [502, 503, 504].includes(status),
      );
    const name = error instanceof Error ? error.name : "";
    if (
      name === "AbortError" ||
      name.includes("Timeout") ||
      name.includes("Connection") ||
      error instanceof TypeError
    )
      return new ProviderDiscoveryError(
        "Provider model discovery network request failed",
        "network",
        undefined,
        true,
      );
    return new ProviderDiscoveryError(
      "Provider model discovery failed",
      "unknown",
    );
  }

  private operationError(error: unknown): ProviderOperationError {
    const normalized = this.discoveryError(error);
    return {
      category: normalized.category,
      operation: "model_discovery",
      retryable: normalized.retryable,
      observed_at: new Date().toISOString(),
      ...(normalized.statusCode ? { http_status: normalized.statusCode } : {}),
      message: normalized.message,
    };
  }

  private async fetchDiscoveryJson(
    url: URL,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw this.discoveryError(error);
    }
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
      const retryAfterMs = Number.isFinite(seconds)
        ? Math.max(0, seconds * 1_000)
        : undefined;
      const category =
        response.status === 401 || response.status === 403
          ? "authentication"
          : response.status === 429
            ? "rate_limit"
            : [404, 405, 501].includes(response.status)
              ? "endpoint_unsupported"
              : response.status >= 500
                ? "provider_unavailable"
                : "unknown";
      throw new ProviderDiscoveryError(
        `Provider model discovery failed with HTTP ${response.status}`,
        category,
        response.status,
        response.status === 429 || [502, 503, 504].includes(response.status),
        retryAfterMs,
      );
    }
    try {
      const body = await response.json();
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error("response is not an object");
      return body as Record<string, unknown>;
    } catch {
      throw new ProviderDiscoveryError(
        "Provider returned invalid JSON for model discovery",
        "invalid_response",
      );
    }
  }

  private async discoverModelsOnce(
    connection: ConnectionData,
    key: string,
    timeoutMs: number,
  ): Promise<string[]> {
    const ids: string[] = [];
    if (connection.protocol === "anthropic") {
      let afterId: string | undefined;
      for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
        const url = new URL(`${connection.base_url}/models`);
        url.searchParams.set("limit", "1000");
        if (afterId) url.searchParams.set("after_id", afterId);
        const body = await this.fetchDiscoveryJson(
          url,
          { "x-api-key": key, "anthropic-version": "2023-06-01" },
          timeoutMs,
        );
        if (!Array.isArray(body.data))
          throw new ProviderDiscoveryError(
            "Provider model discovery response is missing data",
            "invalid_response",
          );
        const pageIds = body.data
          .map((item) =>
            item && typeof item === "object"
              ? String((item as Record<string, unknown>).id ?? "")
              : "",
          )
          .filter(Boolean);
        ids.push(...pageIds);
        if (body.has_more !== true) break;
        const next = String(body.last_id ?? pageIds.at(-1) ?? "");
        if (!next || next === afterId)
          throw new ProviderDiscoveryError(
            "Provider model discovery pagination did not advance",
            "invalid_response",
          );
        afterId = next;
        if (page === MAX_DISCOVERY_PAGES - 1)
          throw new ProviderDiscoveryError(
            "Provider model discovery exceeded the page limit",
            "invalid_response",
          );
      }
    } else if (connection.protocol === "google_gemini") {
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
        const url = new URL(`${connection.base_url}/models`);
        url.searchParams.set("key", key);
        url.searchParams.set("pageSize", "1000");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const body = await this.fetchDiscoveryJson(url, {}, timeoutMs);
        if (body.models !== undefined && !Array.isArray(body.models))
          throw new ProviderDiscoveryError(
            "Provider model discovery response has invalid models",
            "invalid_response",
          );
        ids.push(
          ...((body.models as unknown[] | undefined) ?? [])
            .map((item) =>
              item && typeof item === "object"
                ? String((item as Record<string, unknown>).name ?? "").replace(
                    /^models\//,
                    "",
                  )
                : "",
            )
            .filter(Boolean),
        );
        const next = String(body.nextPageToken ?? "");
        if (!next) break;
        if (next === pageToken)
          throw new ProviderDiscoveryError(
            "Provider model discovery pagination did not advance",
            "invalid_response",
          );
        pageToken = next;
        if (page === MAX_DISCOVERY_PAGES - 1)
          throw new ProviderDiscoveryError(
            "Provider model discovery exceeded the page limit",
            "invalid_response",
          );
      }
    } else {
      const client = new OpenAI({
        apiKey: key,
        baseURL: connection.base_url,
        maxRetries: 0,
        timeout: timeoutMs,
      });
      for await (const item of client.models.list()) {
        if (item.id) ids.push(item.id);
        if (ids.length > 10_000)
          throw new ProviderDiscoveryError(
            "Provider model discovery exceeded the model limit",
            "invalid_response",
          );
      }
    }
    return [...new Set(ids)];
  }

  private async discoverModels(
    connection: ConnectionData,
  ): Promise<DiscoveryResult> {
    const key = this.key(connection);
    const { timeoutMs, maxRetries } = this.discoveryOptions(connection);
    let lastError: ProviderDiscoveryError | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const ids = await this.discoverModelsOnce(connection, key, timeoutMs);
        return {
          ids,
          status: ids.length ? "succeeded" : "empty",
          attemptedAt: new Date().toISOString(),
        };
      } catch (error) {
        lastError = this.discoveryError(error);
        if (!lastError.retryable || attempt === maxRetries) throw lastError;
        const delay = Math.min(
          5_000,
          lastError.retryAfterMs ?? 250 * 2 ** attempt,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError!;
  }

  private legacyUserOverride(
    current: (Resource<ProviderModelData> & ProviderModelData) | undefined,
  ): Record<string, unknown> | undefined {
    if (!current) return undefined;
    if (current.user_capability_overrides)
      return validatedCapabilityOverride(current.user_capability_overrides);
    if (current.source !== "user") return undefined;
    const legacy = { ...current.capabilities } as Record<string, unknown>;
    delete legacy.capability_source;
    delete legacy.capability_status;
    return validatedCapabilityOverride(legacy);
  }

  private modelData(
    modelId: string,
    known: ProviderModelDefinition | undefined,
    current: (Resource<ProviderModelData> & ProviderModelData) | undefined,
    options: { remoteVisible: boolean; catalogFallback: boolean; now: string },
  ): ProviderModelData {
    const base = known?.capabilities ?? unknownModelCapabilities();
    const userOverride = this.legacyUserOverride(current);
    const capabilities = userOverride
      ? validatedCapabilityMerge(base, userOverride)
      : base;
    const manuallyAdded = Boolean(
      current?.manually_added || current?.source === "user",
    );
    const sourceParts = [
      known ? "catalog" : "",
      options.remoteVisible ? "remote" : "",
      manuallyAdded || userOverride ? "user" : "",
    ].filter(Boolean);
    return {
      model_id: modelId,
      display_name: String(
        current?.display_name ?? known?.display_name ?? modelId,
      ),
      source: sourceParts.join("+") || "remote",
      capabilities,
      ...(known ? { catalog_capabilities: known.capabilities } : {}),
      ...(userOverride ? { user_capability_overrides: userOverride } : {}),
      ...(manuallyAdded ? { manually_added: true } : {}),
      ...(options.remoteVisible ? { last_seen_at: options.now } : {}),
      last_sync_at: options.now,
      remote_presence: options.remoteVisible
        ? "visible"
        : options.catalogFallback
          ? "unknown"
          : "not_listed",
      capability_provenance: {
        source: userOverride
          ? "user"
          : known
            ? "catalog"
            : "conservative_unknown",
        ...(known ? { catalog_reviewed_at: known.capability_reviewed_at } : {}),
        ...(options.remoteVisible
          ? { remote_model_id_seen_at: options.now }
          : {}),
        ...(userOverride
          ? {
              user_overridden_at: String(
                current?.capability_provenance?.user_overridden_at ??
                  options.now,
              ),
            }
          : {}),
      },
    };
  }

  async syncModels(
    id: string,
  ): Promise<Array<Resource<ProviderModelData> & ProviderModelData>> {
    const connection = await this.get(id);
    const definition = this.definition(connection.provider);
    const discovery = await this.discoverModels(connection);
    return this.db.transaction(async (tx) => {
      await tx.query(
        "SELECT id FROM resources WHERE id=$1 AND kind='provider_connection' FOR UPDATE",
        [id],
      );
      const existing = await this.store.list<ProviderModelData>(
        "provider_model",
        { parentId: id, limit: 2_000 },
        tx,
      );
      const byModel = new Map(
        existing.map((item) => [String(item.model_id), item]),
      );
      const remoteIds = new Set(discovery.ids);
      const effectiveIds = discovery.ids.length
        ? [...remoteIds]
        : definition.models.map((item) => item.id);
      const effectiveSet = new Set(effectiveIds);
      for (const item of existing) {
        if (effectiveSet.has(item.model_id)) continue;
        const manuallyAdded = Boolean(
          item.manually_added ||
          item.source === "user" ||
          item.source.includes("+user"),
        );
        await this.store.update<ProviderModelData>(
          "provider_model",
          item.id,
          {
            status: manuallyAdded ? "active" : "unavailable",
            data: {
              last_sync_at: discovery.attemptedAt,
              remote_presence: "not_listed",
            },
          },
          tx,
        );
      }
      for (const modelId of effectiveIds) {
        const known = definition.models.find((item) => item.id === modelId);
        const current = byModel.get(modelId);
        const data = this.modelData(modelId, known, current, {
          remoteVisible: remoteIds.has(modelId),
          catalogFallback: discovery.status === "empty",
          now: discovery.attemptedAt,
        });
        if (current)
          await this.store.update<ProviderModelData>(
            "provider_model",
            current.id,
            { status: "active", name: data.display_name, data },
            tx,
          );
        else
          await this.store.create<ProviderModelData>(
            {
              kind: "provider_model",
              parentId: id,
              name: data.display_name,
              data,
            },
            tx,
          );
      }
      const active = await this.store.list<ProviderModelData>(
        "provider_model",
        { parentId: id, status: "active", limit: 2_000 },
        tx,
      );
      const activeIds = new Set(active.map((item) => item.model_id));
      const defaultModel =
        connection.default_model ??
        definition.models.find((item) => activeIds.has(item.id))?.id ??
        active[0]?.model_id;
      const defaultStatus = defaultModel
        ? activeIds.has(defaultModel)
          ? "available"
          : "unavailable"
        : "unset";
      const modelDiscovery: ModelDiscoveryState = {
        status: discovery.status,
        source: discovery.ids.length ? "remote" : "catalog_fallback",
        remote_model_count: discovery.ids.length,
        effective_model_count: active.length,
        attempted_at: discovery.attemptedAt,
      };
      await this.store.update<ConnectionData>(
        "provider_connection",
        id,
        {
          status: "active",
          data: {
            last_validated_at: discovery.attemptedAt,
            last_error: undefined,
            last_error_details: undefined,
            model_discovery: modelDiscovery,
            default_model: defaultModel,
            default_model_status: defaultStatus,
          },
        },
        tx,
      );
      return active;
    });
  }

  private async ensureCatalogModels(
    connection: Resource<ConnectionData> & ConnectionData,
  ) {
    const definition = this.definition(connection.provider);
    if (!definition.models.length) return [];
    if (
      connection.model_discovery?.status === "succeeded" &&
      connection.model_discovery.remote_model_count > 0
    )
      return [];
    return this.db.transaction(async (tx) => {
      await tx.query(
        "SELECT id FROM resources WHERE id=$1 AND kind='provider_connection' FOR UPDATE",
        [connection.id],
      );
      const existing = await this.store.list<ProviderModelData>(
        "provider_model",
        { parentId: connection.id, limit: 2_000 },
        tx,
      );
      const byModel = new Map(existing.map((item) => [item.model_id, item]));
      const now = new Date().toISOString();
      for (const item of definition.models) {
        const current = byModel.get(item.id);
        const data = this.modelData(item.id, item, current, {
          remoteVisible: false,
          catalogFallback: true,
          now,
        });
        if (current)
          await this.store.update<ProviderModelData>(
            "provider_model",
            current.id,
            { status: "active", name: data.display_name, data },
            tx,
          );
        else
          await this.store.create<ProviderModelData>(
            {
              kind: "provider_model",
              parentId: connection.id,
              name: data.display_name,
              data,
            },
            tx,
          );
      }
      const active = await this.store.list<ProviderModelData>(
        "provider_model",
        { parentId: connection.id, status: "active", limit: 2_000 },
        tx,
      );
      const defaultModel =
        connection.default_model ??
        definition.models.find((item) =>
          active.some((candidate) => candidate.model_id === item.id),
        )?.id;
      const defaultStatus = defaultModel ? "available" : "unset";
      await this.store.update<ConnectionData>(
        "provider_connection",
        connection.id,
        {
          data: {
            default_model: defaultModel,
            default_model_status: defaultStatus,
            ...(connection.model_discovery
              ? {
                  model_discovery: {
                    ...connection.model_discovery,
                    source: "catalog_fallback",
                    effective_model_count: active.length,
                  },
                }
              : {}),
          },
        },
        tx,
      );
      return active;
    });
  }

  async listModels(connectionId: string) {
    const rows = await this.store.list<ProviderModelData>("provider_model", {
      parentId: connectionId,
      status: "active",
      limit: 2_000,
    });
    if (rows.length) return rows.map(normalizedProviderModel);
    return (await this.ensureCatalogModels(await this.get(connectionId))).map(
      normalizedProviderModel,
    );
  }

  async pageModels(connectionId: string, options: PageOptions = {}) {
    await this.listModels(connectionId);
    const page = await this.store.page<ProviderModelData>("provider_model", {
      ...options,
      parentId: connectionId,
      status: "active",
    });
    return { ...page, data: page.data.map(normalizedProviderModel) };
  }

  async addModel(connectionId: string, input: Record<string, unknown>) {
    const connection = await this.get(connectionId);
    const modelId = String(input.model_id);
    if (!modelId) throw new ValidationError("model_id is required");
    const definition = this.definition(connection.provider);
    const known = definition.models.find((item) => item.id === modelId);
    const incoming = validatedCapabilityOverride(input.capabilities);
    return this.db.transaction(async (tx) => {
      await tx.query(
        "SELECT id FROM resources WHERE id=$1 AND kind='provider_connection' FOR UPDATE",
        [connectionId],
      );
      const current = (
        await this.store.list<ProviderModelData>(
          "provider_model",
          { parentId: connectionId, limit: 2_000 },
          tx,
        )
      ).find((item) => item.model_id === modelId);
      const previous = this.legacyUserOverride(current) ?? {};
      const combined = validatedCapabilityOverride({
        ...previous,
        ...incoming,
        ...(previous.reasoning || incoming.reasoning
          ? {
              reasoning: {
                ...((previous.reasoning as Record<string, unknown>) ?? {}),
                ...((incoming.reasoning as Record<string, unknown>) ?? {}),
              },
            }
          : {}),
        ...(previous.context_compaction || incoming.context_compaction
          ? {
              context_compaction: {
                ...((previous.context_compaction as Record<string, unknown>) ??
                  {}),
                ...((incoming.context_compaction as Record<string, unknown>) ??
                  {}),
              },
            }
          : {}),
        ...(previous.tasks || incoming.tasks
          ? {
              tasks: {
                ...((previous.tasks as Record<string, unknown>) ?? {}),
                ...((incoming.tasks as Record<string, unknown>) ?? {}),
              },
            }
          : {}),
      });
      const now = new Date().toISOString();
      const hasOverride = Object.keys(combined).length > 0;
      const base = known?.capabilities ?? unknownModelCapabilities();
      const capabilities = hasOverride
        ? validatedCapabilityMerge(base, combined)
        : base;
      const source = [
        known ? "catalog" : "",
        current?.last_seen_at ? "remote" : "",
        "user",
      ]
        .filter(Boolean)
        .join("+");
      const data: ProviderModelData = {
        model_id: modelId,
        display_name: String(
          input.display_name ??
            current?.display_name ??
            known?.display_name ??
            modelId,
        ),
        source,
        capabilities,
        ...(known ? { catalog_capabilities: known.capabilities } : {}),
        ...(hasOverride ? { user_capability_overrides: combined } : {}),
        manually_added: true,
        ...(current?.last_seen_at
          ? { last_seen_at: current.last_seen_at }
          : {}),
        last_sync_at: String(current?.last_sync_at ?? now),
        remote_presence: current?.remote_presence ?? "unknown",
        capability_provenance: {
          source: hasOverride
            ? "user"
            : known
              ? "catalog"
              : "conservative_unknown",
          ...(known
            ? { catalog_reviewed_at: known.capability_reviewed_at }
            : {}),
          ...(current?.last_seen_at
            ? { remote_model_id_seen_at: current.last_seen_at }
            : {}),
          ...(hasOverride ? { user_overridden_at: now } : {}),
        },
      };
      const saved = current
        ? await this.store.update<ProviderModelData>(
            "provider_model",
            current.id,
            { status: "active", name: data.display_name, data },
            tx,
          )
        : await this.store.create<ProviderModelData>(
            {
              kind: "provider_model",
              parentId: connectionId,
              name: data.display_name,
              data,
            },
            tx,
          );
      if (!connection.default_model)
        await this.store.update<ConnectionData>(
          "provider_connection",
          connectionId,
          {
            data: {
              default_model: modelId,
              default_model_status: "available",
            },
          },
          tx,
        );
      return saved;
    });
  }

  async validate(id: string) {
    try {
      const models = await this.syncModels(id);
      const connection = await this.get(id);
      return {
        valid: true,
        model_count: models.length,
        models,
        discovery: connection.model_discovery,
        default_model: connection.default_model,
        default_model_status: connection.default_model_status,
      };
    } catch (error) {
      const current = await this.get(id);
      const details = this.operationError(error);
      const active = await this.store.list<ProviderModelData>(
        "provider_model",
        { parentId: id, status: "active", limit: 2_000 },
      );
      const discovery: ModelDiscoveryState = {
        status:
          details.category === "endpoint_unsupported"
            ? "unsupported"
            : "failed",
        source: active.length ? "catalog_fallback" : "none",
        remote_model_count: 0,
        effective_model_count: active.length,
        attempted_at: details.observed_at,
      };
      await this.store.update<ConnectionData>("provider_connection", id, {
        status: current.status,
        data: {
          last_error: details.message,
          last_error_details: details,
          model_discovery: discovery,
        },
      });
      return {
        valid: false,
        error: details.message,
        error_details: details,
        discovery,
      };
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
    const openAIClient = new OpenAI({
      apiKey,
      baseURL: connection.base_url,
      // Retry decisions belong to the Agents SDK Runtime policy. Leaving the
      // transport default enabled would make ambiguous retries invisible.
      maxRetries: 0,
    });
    return new OpenAIProvider({
      openAIClient,
      useResponses: connection.protocol === "responses",
    }).getModel(modelId);
  }

  async resolveConfig(config: Record<string, unknown>): Promise<
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
    const connection = await this.get(connectionId);
    const modelId = String(config.model ?? connection.default_model ?? "");
    if (!modelId) throw new ValidationError("agent config requires a model");
    const models = await this.listModels(connectionId);
    const selectedModel = models.find((item) => item.model_id === modelId);
    if (!selectedModel)
      throw new ValidationError(
        `model ${modelId} is not active for Provider connection ${connectionId}; synchronize models or add it explicitly`,
      );
    const capability = selectedModel.capabilities as ModelCapability;
    if (
      capability.model_kind === "transcription" ||
      capability.model_kind === "speech_synthesis"
    )
      throw new ValidationError(
        `model ${modelId} is a dedicated ${capability.model_kind} model and cannot back an Agent deployment`,
      );
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
