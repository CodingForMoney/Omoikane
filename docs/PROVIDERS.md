# Provider and model catalog

> Implementation source of truth: `src/providers.ts`. Catalog last reviewed: 2026-08-28.

This document describes Provider definitions, protocols, model discovery, Reasoning Effort, structured output, context defaults, and credentials. For the creation workflow, see [Configure a Provider first](DEVELOPER_GUIDE.md#2-configure-a-provider-first).

## Resource model

```text
Provider Definition
  └── Endpoint Profile + Protocol + Known Model Capabilities
Provider Connection
  └── selected Provider/Profile + encrypted key or environment reference
Provider Model
  └── model ID + context/output/reasoning/vision/structured/compaction capabilities
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

## Model synchronization

On connection creation or an explicit sync request, Omoikane discovers models through the protocol-specific endpoint:

- OpenAI-compatible endpoints: `GET /models`;
- Anthropic: Anthropic `/models`;
- Gemini: Google `/models`;
- a successful empty result remains explicitly `empty` and uses the catalog as a labeled fallback;
- an unsupported or failed endpoint remains explicitly `unsupported` or `failed`. A later model-list request can still materialize catalog defaults without claiming remote confirmation.

A discovery response reliably establishes only the model IDs currently visible to that key. Most endpoints omit accurate context-window, maximum-output, vision, structured-output, and Reasoning Effort information. Omoikane therefore merges discovered IDs with versioned catalog capability data and caller overrides.

Discovery is bounded and read-only: the default request timeout is 15 seconds, safe failures are retried at most twice with bounded backoff and `Retry-After`, and Anthropic/Gemini pagination is followed with a 100-page ceiling. The OpenAI client handles its protocol pagination with implicit transport retries disabled. Override the local discovery bounds per Connection only when necessary:

```json
{
  "settings": {
    "model_discovery_timeout_ms": 15000,
    "model_discovery_max_retries": 2
  }
}
```

The complete result is committed in one database transaction. Models absent from a successful non-empty remote result become `unavailable` and disappear from the active selection list, but their historical records are retained. An explicitly added model remains active and is marked `remote_presence: not_listed`. A missing default model is not silently replaced: the Connection reports `default_model_status: unavailable`, and new resolution fails until the caller selects another active model.

Newly discovered unknown models receive conservative capabilities (`tools`, `vision`, and `streaming` are false, with `capability_status: unknown`) until they are cataloged or explicitly overridden. User overrides are stored separately and survive later synchronization. Capability input is Schema-validated, including nested Reasoning and native-compaction contracts.

Connection validation returns structured discovery state and safe error metadata. It distinguishes authentication, rate limiting, unsupported endpoints, Provider unavailability, invalid responses, and network failures without storing response bodies or credentials. A successful empty `/models` response validates endpoint access but does not claim that catalog models were remotely observed.

Model generation does not inherit the OpenAI transport client's implicit retries. Omoikane disables those retries and lets the OpenAI Agents SDK apply one visible, bounded Runtime retry by default. Only HTTP 429 or Provider advice with `replaySafety: safe` is accepted; timeout, ambiguous network, 5xx, stateful, and already-started stream failures are not automatically replayed. This avoids hiding duplicate Provider work behind an adapter.

## Reasoning Effort

Reasoning Effort is a model capability, not a uniform property of the OpenAI, Anthropic, or Gemini protocols. A UI must read the selected model's capability record:

```json
{
  "supported": true,
  "effort_values": ["none", "low", "medium", "high"],
  "adapter": "reasoning_effort"
}
```

If `supported` is false, do not show an Effort selector. The server rejects values not declared by that model. Agent configuration uses one platform field:

```yaml
model_settings:
  reasoning_effort: high
```

Before execution, Omoikane maps this to the selected adapter's SDK model settings and applies a `value_map` when the Provider uses different names.

## Structured output

Structured output is recorded per model as `native` or `prompt`; it is not inferred from the endpoint protocol alone:

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

The catalog enables it for known OpenAI Responses models and the supported local Codex Bridge models. Unknown models and generic OpenAI-compatible Providers default to unsupported until verified. Codex Bridge v0.1.5 or later is required: it must implement `POST /v1/responses/compact` and accept the returned `compaction` item on a later `POST /v1/responses` request.

Model discovery does not establish this capability. The Omoikane `auto` strategy uses the catalog declaration and falls back to portable checkpoint compaction on a compatible native failure. Explicit `native` mode fails when the capability or endpoint is unavailable. See [Context compaction](CONTEXT_COMPACTION.md).

## Context-window defaults

Known values initialize Agent configuration and context-compaction thresholds. A user can still override `model_context_window` for a Deployment.

| Provider      | Model examples                                 | Default context tokens | Note                                   |
| ------------- | ---------------------------------------------- | ---------------------: | -------------------------------------- |
| OpenAI        | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` |              1,050,000 | catalog default                        |
| OpenAI        | `gpt-5.4`                                      |              1,050,000 | catalog default                        |
| OpenAI        | `gpt-5.4-mini`                                 |                400,000 | catalog default                        |
| Codex Bridge  | supported Codex models                         |            **258,400** | explicit local Bridge contract         |
| Xiaomi MiMo   | `mimo-v2.5`, `mimo-v2.5-pro`                   |              1,048,576 | Token Plan and PAYG profiles           |
| Anthropic     | cataloged Claude Opus/Sonnet models            |        1,000,000 input | input-window value                     |
| Anthropic     | cataloged Claude Haiku model                   |          200,000 input | input-window value                     |
| Google        | cataloged Gemini 3 models                      |        1,000,000 input | output limit stored separately         |
| xAI           | `grok-4.3`                                     |              1,000,000 | catalog default                        |
| xAI           | `grok-4.5`                                     |                500,000 | catalog default                        |
| Mistral       | large/small latest                             |                256,000 | catalog default                        |
| Groq          | `openai/gpt-oss-120b` and related              |                131,072 | output limits vary                     |
| DeepSeek      | cataloged v4 models                            |              1,000,000 | catalog default                        |
| Alibaba Qwen  | cataloged Qwen 3 models                        |              1,000,000 | catalog default                        |
| Zhipu         | `glm-5.2`                                      |              1,000,000 | other cataloged GLM models may be 200K |
| Moonshot/Kimi | cataloged K2 models                            |                262,144 | catalog default                        |
| MiniMax       | cataloged M2 models                            |                204,800 | catalog default                        |
| StepFun       | Step 3.5 Flash                                 |                262,144 | catalog default                        |
| Cohere        | Command A Plus                                 |                128,000 | Command A is cataloged separately      |

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
3. Test UI Effort visibility, structured-output mode, native-compaction selection, server validation, context defaults, and compaction thresholds together.
4. Do not infer context or Effort solely from a newly discovered model name.
5. Treat catalog age and live adapter conformance as release evidence, not as proof that a Provider will never change. Refresh evidence when a Provider becomes a real business dependency or changes behavior.
