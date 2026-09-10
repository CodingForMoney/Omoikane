# Provider and model catalog

> Implementation source of truth: `src/providers.ts`. Catalog last reviewed: 2026-09-10.

This document describes Provider definitions, protocols, model discovery, reasoning capabilities, structured output, context defaults, and credentials. For the creation workflow, see [Configure a Provider first](DEVELOPER_GUIDE.md#2-configure-a-provider-first).

## Resource model

```text
Provider Definition
  └── Endpoint Profile + Protocol + Known Model Capabilities
Provider Connection
  └── selected Provider/Profile + encrypted key or environment reference
Provider Model
  └── model ID + kind/modalities/tasks/context/reasoning/structured/compaction/Token-count capabilities
Agent Deployment
  └── connection ID + model ID + optional capability overrides
```

A Provider Definition is a versioned code catalog entry. A Provider Connection is stored local configuration. A Provider Model is a discovered or manually added model record under that connection. An immutable Agent Deployment binds a connection and active model without copying the API key. Model records retain catalog capabilities, stable user overrides, effective capabilities, discovery presence, and capability provenance separately.

Users normally select a known Provider and supply a key. Arbitrary URLs are intentionally limited to `custom_openai_compatible`, which accepts an explicit `custom_base_url` and `custom_protocol`.

## Protocol adapters

| Protocol           | Runtime adapter                                          |
| ------------------ | -------------------------------------------------------- |
| `responses`        | OpenAI Agents `OpenAIProvider` using the Responses API   |
| `chat_completions` | OpenAI Agents `OpenAIProvider` using Chat Completions    |
| `anthropic`        | OpenAI Agents AI SDK adapter with the Anthropic provider |
| `google_gemini`    | OpenAI Agents AI SDK adapter with Google Generative AI   |

The catalog currently contains 28 Provider definitions. They cover OpenAI, Anthropic, Google, xAI, Mistral, Cohere, Groq, Together, OpenRouter, Perplexity, Cerebras, MiMo, DeepSeek, Qwen, Zhipu, Kimi, Volcano Ark, Baidu, Tencent, MiniMax, SiliconFlow, StepFun, Baichuan, 01.AI, iFlytek, ModelScope, and local Codex Bridge.

Catalog presence means Omoikane knows how to configure the endpoint. It does not guarantee that every model or optional capability has been live-tested.

DeepSeek V4.1 Flash uses the canonical API model ID `deepseek-flash`. It is a 1M-context, text-and-image-input model with a 384K maximum output and native Responses, JSON/structured-output, Tool-call, and reasoning support. DeepSeek has retired V4 Flash and V4 Flash Vision Exp; the legacy IDs `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are retained as temporary Provider aliases and point to V4.1 Flash. Omoikane keeps those IDs for compatibility but selects `deepseek-flash` by default. DeepSeek also announced that `deepseek-v4-pro` will route to V4.1 Flash after 2026-09-14 12:00 Beijing time until V4.1 Pro is released. Sources: [official release](https://deepseek.com/news/deepseek-v4-1-flash/), [API model table](https://api-docs.deepseek.com/quick_start/pricing/), and [open model/Prompt Encoder](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash).

## Model synchronization

On connection creation or an explicit sync request, Omoikane discovers models through the protocol-specific endpoint:

- OpenAI-compatible endpoints: `GET /models`;
- Anthropic: Anthropic `/models`;
- Gemini: Google `/models`;
- a successful empty result remains explicitly `empty` and uses the catalog as a labeled fallback;
- an unsupported or failed endpoint remains explicitly `unsupported` or `failed`. A later model-list request can still materialize catalog defaults without claiming remote confirmation.

A discovery response reliably establishes only the model IDs currently visible to that key. Most endpoints omit accurate context-window, maximum-output, modalities, task support, structured-output, and Reasoning Effort information. Omoikane therefore merges discovered IDs with versioned catalog capability data and caller overrides.

Discovery is bounded and read-only: the default request timeout is 15 seconds, safe failures are retried at most twice with bounded backoff and `Retry-After`, and Anthropic/Gemini pagination is followed with a 100-page ceiling. The OpenAI client handles its protocol pagination with implicit transport retries disabled. Override the local discovery bounds per Connection only when necessary:

```json
{
  "settings": {
    "model_discovery_timeout_ms": 15000,
    "model_discovery_max_retries": 2
  }
}
```

The complete result is committed in one database transaction. Models absent from a successful non-empty remote result become `unavailable` and disappear from the active selection list, but their historical records are retained. An explicitly added model remains active and is marked `remote_presence: not_listed`. A missing default model is not silently replaced: the Connection reports `default_model_status: unavailable`, and new resolution fails until the caller selects another active model. The sole exception is a catalog-declared Provider alias replacement; synchronization migrates that stale default to the active canonical ID.

Newly discovered unknown models receive conservative capabilities (text input/output only; Tools, legacy `vision`, and Streaming are false; all task capabilities are `none`; `capability_status` is `unknown`) until they are cataloged or explicitly overridden. User overrides are stored separately and survive later synchronization. Capability input is Schema-validated, including modalities, task consistency, nested Reasoning, and native-compaction contracts.

Connection validation returns structured discovery state and safe error metadata. It distinguishes authentication, rate limiting, unsupported endpoints, Provider unavailability, invalid responses, and network failures without storing response bodies or credentials. A successful empty `/models` response validates endpoint access but does not claim that catalog models were remotely observed.

Model generation does not inherit the OpenAI transport client's implicit retries. Omoikane disables those retries and lets the OpenAI Agents SDK apply one visible, bounded Runtime retry by default. Only HTTP 429 or Provider advice with `replaySafety: safe` is accepted; timeout, ambiguous network, 5xx, stateful, and already-started stream failures are not automatically replayed. This avoids hiding duplicate Provider work behind an adapter.

## Model modalities and tasks

Every Provider Model exposes machine-readable model type, input/output modalities, and task capabilities:

```json
{
  "model_kind": "agent",
  "input_modalities": ["text", "image", "audio", "video"],
  "output_modalities": ["text"],
  "tasks": {
    "image_understanding": "native",
    "transcription": "general",
    "speech_synthesis": "none"
  }
}
```

`general` transcription means a general multimodal model can accept audio and return text; it does not promise a dedicated timestamped transcription API. `dedicated` is reserved for task-specific STT/TTS models. The deprecated `vision` Boolean remains in responses for compatibility and is always equal to `tasks.image_understanding === "native"`. New integrations must use `input_modalities`, `output_modalities`, and `tasks`.

The current catalog includes dedicated MiMo V2.5 ASR and TTS models backed by explicit Provider adapters. No other Provider receives STT/TTS merely because it is multimodal or OpenAI-compatible. Dedicated audio models cannot back an Agent Deployment; use the audio endpoints described below.

| Provider                | Model                         | Kind               | Input                     | Output | Image understanding | STT       | TTS       |
| ----------------------- | ----------------------------- | ------------------ | ------------------------- | ------ | ------------------- | --------- | --------- |
| OpenAI                  | `gpt-6-astra`                 | `agent`            | text, image               | text   | native              | —         | —         |
| OpenAI                  | `gpt-5.6-sol`                 | `agent`            | text, image               | text   | native              | —         | —         |
| OpenAI                  | `gpt-5.6-terra`               | `agent`            | text, image               | text   | native              | —         | —         |
| OpenAI                  | `gpt-5.6-luna`                | `agent`            | text, image               | text   | native              | —         | —         |
| OpenAI                  | `gpt-5.4`                     | `agent`            | text, image               | text   | native              | —         | —         |
| OpenAI                  | `gpt-5.4-mini`                | `agent`            | text, image               | text   | native              | —         | —         |
| Codex Bridge (local)    | `gpt-6-astra`                 | `agent`            | text, image               | text   | native              | —         | —         |
| Codex Bridge (local)    | `gpt-5.6-sol`                 | `agent`            | text, image               | text   | native              | —         | —         |
| Codex Bridge (local)    | `gpt-5.6-luna`                | `agent`            | text, image               | text   | native              | —         | —         |
| Anthropic Claude        | `claude-opus-5`               | `agent`            | text, image               | text   | native              | —         | —         |
| Anthropic Claude        | `claude-sonnet-5`             | `agent`            | text, image               | text   | native              | —         | —         |
| Anthropic Claude        | `claude-opus-4-6`             | `agent`            | text, image               | text   | native              | —         | —         |
| Anthropic Claude        | `claude-sonnet-4-6`           | `agent`            | text, image               | text   | native              | —         | —         |
| Anthropic Claude        | `claude-haiku-4-5-20251001`   | `agent`            | text, image               | text   | native              | —         | —         |
| Google Gemini           | `gemini-3.1-pro-preview`      | `agent`            | text, image, audio, video | text   | native              | general   | —         |
| Google Gemini           | `gemini-3-flash-preview`      | `agent`            | text, image, audio, video | text   | native              | general   | —         |
| Google Gemini           | `gemini-3.1-flash-lite`       | `agent`            | text, image, audio, video | text   | native              | general   | —         |
| Cohere                  | `command-a-plus-05-2026`      | `agent`            | text, image               | text   | native              | —         | —         |
| Cohere                  | `command-a-03-2025`           | `agent`            | text                      | text   | —                   | —         | —         |
| xAI Grok                | `grok-4.3`                    | `agent`            | text, image               | text   | native              | —         | —         |
| xAI Grok                | `grok-4.5`                    | `agent`            | text, image               | text   | native              | —         | —         |
| xAI Grok                | `grok-build-0.1`              | `agent`            | text, image               | text   | native              | —         | —         |
| Mistral AI              | `mistral-large-latest`        | `agent`            | text, image               | text   | native              | —         | —         |
| Mistral AI              | `mistral-small-latest`        | `agent`            | text, image               | text   | native              | —         | —         |
| Mistral AI              | `codestral-latest`            | `agent`            | text                      | text   | —                   | —         | —         |
| Groq                    | `openai/gpt-oss-120b`         | `agent`            | text                      | text   | —                   | —         | —         |
| Groq                    | `qwen/qwen3.6-27b`            | `agent`            | text, image               | text   | native              | —         | —         |
| Groq                    | `minimaxai/minimax-m2.7`      | `agent`            | text                      | text   | —                   | —         | —         |
| Together AI             | `openai/gpt-oss-120b`         | `agent`            | text                      | text   | —                   | —         | —         |
| Together AI             | `openai/gpt-oss-20b`          | `agent`            | text                      | text   | —                   | —         | —         |
| Perplexity              | `sonar`                       | `agent`            | text, image               | text   | native              | —         | —         |
| Perplexity              | `sonar-pro`                   | `agent`            | text, image               | text   | native              | —         | —         |
| Cerebras Inference      | `gpt-oss-120b`                | `agent`            | text                      | text   | —                   | —         | —         |
| Xiaomi MiMo             | `mimo-v2.5`                   | `agent`            | text, image, audio, video | text   | native              | general   | —         |
| Xiaomi MiMo             | `mimo-v2.5-pro`               | `agent`            | text                      | text   | —                   | —         | —         |
| Xiaomi MiMo             | `mimo-v2.5-asr`               | `transcription`    | audio                     | text   | —                   | dedicated | —         |
| Xiaomi MiMo             | `mimo-v2.5-tts`               | `speech_synthesis` | text                      | audio  | —                   | —         | dedicated |
| DeepSeek                | `deepseek-flash`              | `agent`            | text, image               | text   | native              | —         | —         |
| DeepSeek                | `deepseek-v4-pro`             | `agent`            | text                      | text   | —                   | —         | —         |
| DeepSeek                | `deepseek-v4-flash`           | `agent`            | text, image               | text   | native              | —         | —         |
| DeepSeek                | `deepseek-v4-flash-vision-exp` | `agent`           | text, image               | text   | native              | —         | —         |
| Alibaba Qwen            | `qwen3.8-max`                 | `agent`            | text, image               | text   | native              | —         | —         |
| Alibaba Qwen            | `qwen3.7-max`                 | `agent`            | text, image               | text   | native              | —         | —         |
| Alibaba Qwen            | `qwen3.7-plus`                | `agent`            | text, image               | text   | native              | —         | —         |
| Alibaba Qwen            | `qwen3.6-flash`               | `agent`            | text, image               | text   | native              | —         | —         |
| Zhipu GLM               | `glm-5.2`                     | `agent`            | text                      | text   | —                   | —         | —         |
| Zhipu GLM               | `glm-5.1`                     | `agent`            | text                      | text   | —                   | —         | —         |
| Zhipu GLM               | `glm-5`                       | `agent`            | text                      | text   | —                   | —         | —         |
| Zhipu GLM               | `glm-4.7`                     | `agent`            | text                      | text   | —                   | —         | —         |
| Moonshot / Kimi         | `kimi-k2.7-code`              | `agent`            | text                      | text   | —                   | —         | —         |
| Moonshot / Kimi         | `kimi-k2.6`                   | `agent`            | text, image               | text   | native              | —         | —         |
| Moonshot / Kimi         | `kimi-k2.5`                   | `agent`            | text, image               | text   | native              | —         | —         |
| Volcengine Ark / Doubao | `doubao-seed-2-0-lite-260215` | `agent`            | text, image               | text   | native              | —         | —         |
| Volcengine Ark / Doubao | `ark-code-latest`             | `routing`          | text                      | text   | —                   | —         | —         |
| Baidu Qianfan           | `ernie-4.5-turbo-128k`        | `agent`            | text                      | text   | —                   | —         | —         |
| Baidu Qianfan           | `ernie-x1.1-preview`          | `agent`            | text                      | text   | —                   | —         | —         |
| Tencent Hunyuan         | `hunyuan-turbos-latest`       | `agent`            | text                      | text   | —                   | —         | —         |
| Tencent Hunyuan         | `hunyuan-lite`                | `agent`            | text                      | text   | —                   | —         | —         |
| Tencent Hunyuan         | `hunyuan-vision`              | `agent`            | text, image               | text   | native              | —         | —         |
| Tencent Hunyuan         | `hunyuan-t1-latest`           | `agent`            | text                      | text   | —                   | —         | —         |
| MiniMax                 | `MiniMax-M2.7`                | `agent`            | text                      | text   | —                   | —         | —         |
| MiniMax                 | `MiniMax-M2.5`                | `agent`            | text                      | text   | —                   | —         | —         |
| MiniMax                 | `MiniMax-M2.1`                | `agent`            | text                      | text   | —                   | —         | —         |
| StepFun                 | `step-3.5-flash`              | `agent`            | text                      | text   | —                   | —         | —         |
| StepFun                 | `step-3.5-flash-2603`         | `agent`            | text                      | text   | —                   | —         | —         |
| StepFun                 | `step-router-v1`              | `routing`          | text                      | text   | —                   | —         | —         |
| Baichuan                | `Baichuan3-Turbo-128k`        | `agent`            | text                      | text   | —                   | —         | —         |
| Baichuan                | `Baichuan3-Turbo`             | `agent`            | text                      | text   | —                   | —         | —         |
| 01.AI                   | `yi-lightning`                | `agent`            | text                      | text   | —                   | —         | —         |
| 01.AI                   | `yi-large`                    | `agent`            | text                      | text   | —                   | —         | —         |
| iFlytek Spark           | `4.0Ultra`                    | `agent`            | text                      | text   | —                   | —         | —         |
| iFlytek Spark           | `spark-x`                     | `agent`            | text                      | text   | —                   | —         | —         |

Providers with an empty fixed catalog (`openrouter`, `siliconflow`, `modelscope`, and `custom_openai_compatible`) expose remotely discovered models as conservative unknowns until a caller supplies an explicit validated capability override.

### MiMo dedicated audio adapters

Omoikane exposes two stateless, connection-scoped operations:

- `POST /v1/provider-connections/:connectionId/audio/transcriptions` calls `mimo-v2.5-asr` with Base64 MP3/WAV input and returns text;
- `POST /v1/provider-connections/:connectionId/audio/speech` calls `mimo-v2.5-tts` with text, optional instructions/voice, and returns Base64 WAV/MP3 audio.

Both Token Plan and PAYG MiMo profiles use their existing connection credential. Internally, MiMo audio uses its OpenAI-compatible `/chat/completions` extension rather than OpenAI's `/audio/transcriptions` or `/audio/speech` routes. Omoikane therefore constructs and validates the MiMo-specific message/audio envelope instead of passing it through the Agent model adapter.

These operations are currently non-streaming and hold no Session or conversation state. The Provider models can stream natively, but Omoikane advertises `streaming: false` for these effective adapters until bounded SSE audio forwarding and cancellation are part of the public Runtime contract. Audio bytes and transcripts are not stored by this path; the caller owns any permanent recording, transcript, playback file, consent, and retention policy.

## Reasoning

Reasoning support and Reasoning Effort are different capabilities. Some models reason but expose no Effort selector; some return a public summary, some return a Provider-visible reasoning trace, and some keep reasoning private. A UI must use the selected model's complete capability record:

```json
{
  "supported": true,
  "activation": "optional",
  "visibility": "provider_trace",
  "controls": {
    "toggle": true,
    "effort": true,
    "budget_tokens": false,
    "summary": false
  },
  "effort_values": ["none", "low", "medium", "high"],
  "summary_values": [],
  "request_adapters": ["chat_reasoning_effort"],
  "response_adapter": "chat_reasoning_fields",
  "replay": "reasoning_item"
}
```

The UI rules are direct: show the master reasoning switch only when `controls.toggle` is true, Effort only when `controls.effort` is true, the Token budget only when `controls.budget_tokens` is true, and Summary only when `controls.summary` is true. The server rejects undeclared controls and values rather than forwarding guesses.

Agent configuration uses Provider-independent fields:

```yaml
model_settings:
  reasoning_enabled: true
  reasoning_effort: high
  reasoning_budget_tokens: 4096
  reasoning_summary: auto
```

Specify only controls advertised by the chosen model. Before execution, Omoikane maps them to OpenAI `reasoning`, root `reasoning_effort`, Anthropic `thinking`, Gemini `thinkingConfig`, `enable_thinking`, `reasoning_format`, `reasoning_split`, or the corresponding Provider request shape. `value_map` handles Providers whose labels differ.

| Output semantics                                   | Providers/models in the fixed catalog                                                                                                                                                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public summary                                     | OpenAI GPT-6 Astra and GPT-5.4/5.6; Codex Bridge GPT-6 Astra and GPT-5.6; all cataloged Claude models; all cataloged Gemini models                                                                                                |
| Content-free metadata for a Provider-visible trace | Cohere Command A+; Mistral Small; Groq reasoning models; Together GPT-OSS; Cerebras GPT-OSS; MiMo 2.5/Pro; DeepSeek V4/V4.1; Qwen 3.7/3.8; GLM; Kimi; Doubao Seed 2.0 Lite; ERNIE X1.1; Hunyuan T1; MiniMax M2.x; StepFun 3.5; Spark-X |
| Private reasoning, controls only                   | xAI Grok 4.3 and 4.5                                                                                                                                                                                                              |
| Service reasoning steps                            | Perplexity Sonar Pro                                                                                                                                                                                                              |

The Effort selector is available only for OpenAI/Codex, Gemini, xAI Grok 4.3/4.5, Mistral Small, Groq GPT-OSS/Qwen, Together GPT-OSS, Cerebras GPT-OSS, MiMo 2.5/Pro, DeepSeek V4/V4.1, GLM 5.2, and StepFun 3.5 Flash 2603. DeepSeek exposes `none`, `low`, `high`, and `max`; thinking is enabled by default. Direct OpenAI GPT-6 Astra accepts `low`, `medium`, `high`, `xhigh`, and `max`; the Codex Bridge profile additionally accepts `none`. Codex Bridge exposes only the `auto` public-summary setting. Models such as Claude, Qwen's direct API, Kimi, MiniMax, ERNIE X1.1, and Spark-X still have reasoning support but deliberately expose no fake Effort choices.

Reasoning capability records may additionally declare
`raw_trace_metadata` and `native_summary` as
`supported`, `not_observed`, or `unknown`. The former means Omoikane has
an allowlisted content-free metadata extractor for that wire shape; it
does not mean Raw CoT text is part of the public Runtime contract. Live testing
currently marks `mimo-v2.5` as Raw CoT metadata-capable and its native public
summary as `not_observed`.

OpenAI-compatible reasoning aliases (`reasoning`, `reasoning_content`, `reasoning_details`) and Mistral thinking chunks are normalized before the OpenAI Agents SDK resumes consuming the streamed chunk. This preserves reasoning items required for in-Run tool-call continuity. Omoikane removes Provider-private reasoning text from Events, terminal `new_items`, and public Run records, and emits only counts, timing, completion state, and Provider-reported reasoning-token usage. A temporary SDK approval-resume checkpoint may contain Provider reasoning data because exact tool continuation requires it; that checkpoint is local, never returned by the public API, and is deleted when the Run becomes terminal. Anthropic and Gemini public summaries are normalized from the AI SDK reasoning stream into `model.reasoning_summary_*` Events.

Unknown models discovered through OpenRouter, SiliconFlow, ModelScope, or a custom compatible endpoint remain conservative unknowns. Add an explicit capability override only after verifying that model's request and response shape; Omoikane never infers reasoning support from a model name.

## Structured output

Structured output is recorded per model as `none`, `native`, or `prompt`; it is not inferred from the endpoint protocol alone:

- `none` applies to dedicated non-Agent models such as ASR/TTS and cannot back an Agent Deployment;
- `native` sends the exact Agent `output_schema` through the OpenAI Agents SDK as strict JSON Schema output, then validates the returned value locally;
- `prompt` does not send an unsupported native output parameter. Omoikane injects an exact-JSON instruction into the system instructions, parses the final text, and validates it locally against the same schema.

Both modes have the same acceptance rule: a Run completes only after local JSON Schema validation succeeds. Prompt mode has weaker generation reliability because a model may ignore the instruction, but it never turns malformed or schema-invalid output into a successful Run. Omoikane deliberately performs no JSON repair and no automatic validation retry; either could silently change meaning or repeat Tool side effects.

Unknown models discovered from `/models` default to `prompt` and otherwise conservative capabilities until their behavior is verified and added to the catalog or explicitly overridden. The current catalog marks the supported OpenAI and local Codex Bridge Responses models as `native`; MiMo and all other unverified models use `prompt`. Callers can inspect the selected Provider Model capability instead of assuming that OpenAI-compatible means native support.

Codex Bridge must preserve collected `response.output_item.done` items in the terminal `response.completed.response.output`. An older Bridge build that streams correct deltas but returns an empty terminal `output` causes the OpenAI Agents SDK to continue until `max_turns`; use the locally verified Bridge fix or a release containing that normalization.

## Native context compaction

Native context compaction is a model capability and is never inferred from `protocol = responses` alone:

```json
{
  "context_compaction": {
    "supported": true,
    "method": "responses_compact"
  }
}
```

The catalog enables it for known OpenAI Responses models and the supported local Codex Bridge models. Unknown models and generic OpenAI-compatible Providers default to unsupported until verified. Codex Bridge v0.1.5 or later is required for this contract; GPT-6 Astra specifically requires Codex Bridge v0.1.7 or later. The Bridge must implement `POST /v1/responses/compact` and accept the returned `compaction` item on a later `POST /v1/responses` request.

Model discovery does not establish this capability. The Omoikane `auto` strategy uses the catalog declaration and falls back to portable checkpoint compaction on a compatible native failure. Explicit `native` mode fails when the capability or endpoint is unavailable. See [Context compaction](CONTEXT_COMPACTION.md).

## Complete input Token counting

`input_token_counting` declares whether Omoikane can reliably count the complete logical model input assembled by the OpenAI Agents SDK. A qualified declaration has `scope: assembled_model_input`, a method, an accuracy class, and a review date. Unknown, remotely discovered, manually added, and custom OpenAI-compatible models default to `unavailable`; capability overrides cannot promote them to qualified.

The qualified set uses either a Provider count endpoint or an immutable official open-source Tokenizer plus the model's complete chat/Tool serialization:

| Provider     | Qualified models                                                            | Method                                              | Accuracy            | Input scope |
| ------------ | --------------------------------------------------------------------------- | --------------------------------------------------- | ------------------- | ----------- |
| OpenAI       | `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.4`    | OpenAI Responses input Tokens                       | authoritative exact | model       |
| Anthropic    | `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-6`, `claude-sonnet-4-6`  | Anthropic Messages count Tokens                     | Provider estimate   | model       |
| Google       | `gemini-3.1-pro-preview`, `gemini-3-flash-preview`, `gemini-3.1-flash-lite` | Gemini count Tokens                                 | Provider estimate   | model       |
| Xiaomi MiMo  | `mimo-v2.5`, `mimo-v2.5-pro`                                                | pinned official chat template and Tokenizer         | verified local      | text only   |
| DeepSeek     | `deepseek-flash` and temporary V4 Flash aliases                             | pinned official V4.1 Prompt Encoder and Tokenizer   | verified local      | text only   |
| Alibaba Qwen | `qwen3.8-max`                                                               | pinned official Qwen3.8 chat template and Tokenizer | verified local      | text only   |

For local counting, Omoikane first asks the OpenAI Agents SDK to compile the complete logical input into OpenAI-compatible messages and Tools. It then serializes system instructions, history, current input, Tool/Handoff schemas, Tool calls/results, and prompt-based structured-output instructions with the official model template before tokenization. Tokenizer repositories and Git revisions are returned in the capability and count response. Assets are downloaded from Hugging Face by immutable revision on first use and cached in memory; download or template failure is closed. These paths are `verified_local`, not Provider billing authority. Multimodal input is rejected because an open text Tokenizer cannot reproduce Provider-side image, audio, or video accounting.

DeepSeek V4 Pro counting is no longer advertised because its API ID enters a time-dependent retirement/routing transition on 2026-09-14; Omoikane will not claim one immutable serializer for two possible serving models. GLM `glm-5.2`, xAI `grok-4.3`, the older Qwen catalog IDs, and other models remain unavailable until their exact model has a complete request counter or immutable public serialization. Z.AI's published `/tokenizer` contract currently names older GLM versions, while xAI's public Tokenizer accepts bare text rather than messages and Tools. Codex Bridge exposes only a conservative compatibility estimate and its 258,400-Token context is below this list's threshold. Omoikane never substitutes `UTF-8 bytes / 3` or a bare-text Tokenizer for a complete request count.

`GET /v1/input-token-counting/models` returns only qualified catalog models with `context_window >= 1,000,000`. It is a support catalog, not proof that a Provider Connection has been configured or that the model is visible to a particular key. Use the connection-specific model list for availability.

## Context-window defaults

Known values initialize Agent configuration and context-compaction thresholds. A user can still override `model_context_window` for a Deployment.

| Provider      | Model examples                                                | Default context tokens | Note                                   |
| ------------- | ------------------------------------------------------------- | ---------------------: | -------------------------------------- |
| OpenAI        | `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` |              1,050,000 | catalog default                        |
| OpenAI        | `gpt-5.4`                                                     |              1,050,000 | catalog default                        |
| OpenAI        | `gpt-5.4-mini`                                                |                400,000 | catalog default                        |
| Codex Bridge  | supported Codex models                                        |            **258,400** | explicit local Bridge contract         |
| Xiaomi MiMo   | `mimo-v2.5`, `mimo-v2.5-pro`                                  |              1,048,576 | Token Plan and PAYG profiles           |
| Xiaomi MiMo   | `mimo-v2.5-asr`, `mimo-v2.5-tts`                              |                  8,192 | dedicated non-Agent audio adapters     |
| Anthropic     | cataloged Claude Opus/Sonnet models                           |        1,000,000 input | input-window value                     |
| Anthropic     | cataloged Claude Haiku model                                  |          200,000 input | input-window value                     |
| Google        | cataloged Gemini 3 models                                     |        1,000,000 input | output limit stored separately         |
| xAI           | `grok-4.3`                                                    |              1,000,000 | catalog default                        |
| xAI           | `grok-4.5`                                                    |                500,000 | catalog default                        |
| Mistral       | large/small latest                                            |                256,000 | catalog default                        |
| Groq          | `openai/gpt-oss-120b` and related                             |                131,072 | output limits vary                     |
| DeepSeek      | `deepseek-flash` (V4.1), V4 aliases and V4 Pro                |              1,000,000 | maximum output stored as 384,000       |
| Alibaba Qwen  | cataloged Qwen 3 models                                       |              1,000,000 | catalog default                        |
| Zhipu         | `glm-5.2`                                                     |              1,000,000 | other cataloged GLM models may be 200K |
| Moonshot/Kimi | cataloged K2 models                                           |                262,144 | catalog default                        |
| MiniMax       | cataloged M2 models                                           |                204,800 | catalog default                        |
| StepFun       | Step 3.5 Flash                                                |                262,144 | catalog default                        |
| Cohere        | Command A Plus                                                |                128,000 | Command A is cataloged separately      |

Resolution is:

```text
effective context window = Agent override ?? catalog default ?? 128000
```

An override supports custom deployments and catalog lag; it is not proof that the remote endpoint accepts that length. Maximum output and context window are separate fields. `context_window_type` distinguishes total context from maximum input where the Provider exposes that difference.

## Credential handling

Prefer `api_key_env`, which resolves the real value from the local Runtime process. If a caller submits `api_key` directly, the Runtime encrypts it with AES-256-GCM using a local credential key. The key is generated at `./var/credential.key` by default and can be relocated with `OMOIKANE_CREDENTIAL_FILE`. API responses return only a key hint.

This protects against accidental API disclosure and a database file copied without its credential key. It is not a host-compromise boundary: an attacker that can read both local files or the Runtime process can obtain the Provider credential. Omoikane does not implement cloud KMS, online key rotation, or application-level encryption for Run payloads.

Keep `.env` ignored. Examples contain placeholders only. Release validation must scan source, logs, snapshots, npm tarballs, and Git history for real credentials.

## Catalog maintenance rules

1. Prefer Provider documentation and live endpoint behavior over third-party aggregators.
2. Record the per-model review date when changing capability defaults. Persisted model records expose that date through `capability_provenance.catalog_reviewed_at`.
3. Test UI modalities/tasks, Effort visibility, structured-output mode, native-compaction selection, server validation, context defaults, and compaction thresholds together.
4. Do not infer context or Effort solely from a newly discovered model name.
5. Treat catalog age and live adapter conformance as release evidence, not as proof that a Provider will never change. Refresh evidence when a Provider becomes a real business dependency or changes behavior.
