# Developer guide

This is the end-to-end guide for integrating one local business system with Omoikane. For ownership, persistence, and explicit product boundaries, read [Architecture and state ownership](ARCHITECTURE.md).

## 1. Start the Runtime

Requirements: Node.js 22 or newer. Docker is needed only for the optional PostgreSQL integration suite.

```bash
npm install
cp .env.example .env
npm run dev
```

One process starts the REST/SSE API, Run worker pool, maintenance loop, embedded PGlite database, and local file services.

| Variable                                | Meaning                                                               |
| --------------------------------------- | --------------------------------------------------------------------- |
| `OMOIKANE_DATA_DIR`                     | root for the default database, local files, and credential key        |
| `OMOIKANE_HOST`, `OMOIKANE_PORT`        | bind address and port; defaults to `127.0.0.1:8000`                   |
| `OMOIKANE_CORS_ORIGINS`                 | comma-separated browser-origin allowlist                              |
| `OMOIKANE_RUN_CONCURRENCY`              | in-process Run worker count; default `4`                              |
| `OMOIKANE_DATABASE_URL`                 | optional PGlite or PostgreSQL override                                |
| `OMOIKANE_AUTO_MIGRATE`                 | initialize a new database; never upgrades an existing database        |
| `OMOIKANE_ALLOW_REMOTE`                 | required to bind outside loopback                                     |
| `OMOIKANE_TERMINAL_PAYLOAD_TTL_SECONDS` | retention for terminal input, output, context, and detailed errors    |
| `OMOIKANE_EVENT_TTL_SECONDS`            | retention for terminal Run Events                                     |
| `OMOIKANE_ARTIFACT_TTL_SECONDS`         | retention for temporary Artifacts                                     |
| `OMOIKANE_ARTIFACT_MAX_FILE_BYTES`      | maximum bytes in one Artifact; default `100000000`                    |
| `OMOIKANE_ARTIFACT_MAX_TOTAL_BYTES`     | maximum active Artifact bytes; default `1000000000`                   |
| `OMOIKANE_SSE_MAX_CONNECTIONS`          | total SSE connection limit; default `64`                              |
| `OMOIKANE_SSE_MAX_CONNECTIONS_PER_RUN`  | connection limit for one Run; default `8`                             |
| `OMOIKANE_SSE_POLL_FALLBACK_MS`         | database safety poll without a local wake; default `1000` ms          |
| `OMOIKANE_TRACING_EXPORTER`             | `disabled` (default), `openai`, or `custom:<registered-key>`          |
| `OMOIKANE_TRACING_API_KEY_ENV`          | dedicated OpenAI Trace key variable; default `OPENAI_TRACING_API_KEY` |
| `OMOIKANE_LOG_LEVEL`                    | `debug`, `info`, `warn`, `error`, or `silent`                         |

The API has no login or service token because it is designed for one trusted local integration. Do not expose it directly to an untrusted network.

Verify compatibility before using a Runtime from an application:

```ts
import { OmoikaneClient } from "omoikane/client";

const client = new OmoikaneClient({ baseUrl: "http://127.0.0.1:8000" });
await client.handshake();
```

### API contract and validation

`GET /openapi.json` returns the complete OpenAPI 3.1 document. REST validators, OpenAPI request schemas, and endpoint-specific types exported by `omoikane/client` and `omoikane/contracts` use the same Zod schema source.

Runtime-owned request envelopes are strict. A misspelled or unknown top-level field, missing ID, invalid enum, wrong JSON type, malformed path/query/header value, or unexpected body on a bodyless command returns HTTP 422:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "request validation failed",
    "request_id": "...",
    "details": {
      "issues": [
        {
          "path": "deployment_id",
          "code": "invalid_type",
          "message": "Invalid input: expected string, received undefined"
        }
      ]
    }
  }
}
```

Issues include paths, codes, and explanations, but never echo received values or credentials. Semantic errors, such as an unknown Provider or unsupported monetary limit, keep their specific message in the same error envelope.

Strict envelopes do not make Omoikane the owner of business schemas. Run `context`, model input items and conversation entries, Function Tool arguments, Tool JSON Schema, Provider-specific passthrough settings, reconciliation output/error, and other documented dynamic payloads remain open objects. Runtime-owned Provider discovery settings and model capability overrides have strict Schemas; validate business-owned values in the business system or Tool implementation that owns them.

Top-level Runtime lists use bounded keyset pagination. Provider Connections, Provider models, Deployments, Runs, Function Tools, MCP servers, Skills, Skill versions, Approvals, and Run Artifacts accept `limit` plus an opaque `cursor` and return `{ data, next_cursor }`. Resource lists also accept `status`; Runs additionally accept `deployment_id`, `external_session_id`, and `parent_run_id`; Artifacts require `run_id` and optionally accept a lifecycle `status`. Preserve the same filters while following a cursor: cursors are scoped to the endpoint and filter set, and an incompatible or malformed cursor returns HTTP 422. Run Events keep their natural per-Run `after` sequence cursor.

## 2. Configure a Provider first

List built-in Provider definitions, then create a connection:

```bash
curl http://127.0.0.1:8000/v1/provider-definitions

curl -X POST 'http://127.0.0.1:8000/v1/provider-connections' \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"MiMo Token Plan",
    "provider":"xiaomi_mimo",
    "endpoint_profile":"token_plan_cn",
    "api_key_env":"MIMO_API_KEY"
  }'
```

Creation validates the connection and synchronizes visible models unless `?sync_models=false` is supplied. The remote model list is merged with Omoikane's capability catalog because most `/models` responses do not include reliable input/output modalities, task support, context-window, output-limit, structured-output, or Reasoning Effort metadata. Synchronization is atomic, paginated and bounded; it reports `succeeded`, `empty`, `unsupported`, or `failed`, retains disappeared model records as unavailable, preserves explicit user overrides, and never silently replaces an unavailable default model. Each effective model record declares `model_kind`, `input_modalities`, `output_modalities`, and explicit image-understanding/STT/TTS task fields. See [Provider and model catalog](PROVIDERS.md#model-modalities-and-tasks).

The npm client exposes `listProviders`, `getProvider`, `updateProvider`, `validateProvider`, `listProviderModels`, and `addProviderModel` in addition to `createProvider`. Arbitrary base URLs and protocols are accepted only for `custom_openai_compatible`; known Provider endpoint profiles cannot be rewritten through custom URL fields.

Use `api_key_env` for normal local operation. The named environment variable must exist in the Runtime process, not only in the calling shell or browser. A directly submitted `api_key` is encrypted with the Runtime's local credential key.

MiMo connections also expose dedicated, non-streaming ASR and TTS operations. They reuse the same Token Plan or PAYG credential and do not persist audio or transcripts:

```ts
import { readFile, writeFile } from "node:fs/promises";

const wav = await readFile("question.wav");
const transcription = await client.transcribeAudio(provider.id, {
  model: "mimo-v2.5-asr",
  audio: { data: wav.toString("base64"), format: "wav" },
  language: "auto",
});

const speech = await client.createSpeech(provider.id, {
  model: "mimo-v2.5-tts",
  input: `You said: ${transcription.text}`,
  voice: "mimo_default",
  format: "wav",
  instructions: "Speak clearly and naturally.",
});
await writeFile("reply.wav", Buffer.from(speech.audio.data, "base64"));
```

The equivalent REST routes are `POST /v1/provider-connections/:connectionId/audio/transcriptions` and `POST /v1/provider-connections/:connectionId/audio/speech`. The former accepts canonical Base64 MP3/WAV plus `auto`, `zh`, or `en`; the latter accepts up to 32,000 characters, optional voice/instructions, and WAV or MP3 output. Dedicated `transcription` and `speech_synthesis` models are deliberately rejected as Agent Deployment backends.

## 3. Register capabilities

Register Function Tools through `POST /v1/tools`. Each stored implementation key must match a TypeScript implementation registered in the Runtime process. Tool metadata describes input schema and side-effect behavior. Setting `side_effecting: true` always implies approval, even if `requires_approval` is omitted, because the persisted approval checkpoint is required for safe restart and reconciliation.

Register MCP endpoints through `POST /v1/mcp-servers`; stdio, SSE compatibility, and Streamable HTTP transports are supported. Health-check an endpoint before deploying an Agent. stdio processes receive a minimal base environment plus explicit `endpoint.env` and resolved `secret_refs`; they do not inherit all Runtime credentials.

```yaml
apiVersion: omoikane/v1
kind: McpServer
metadata:
  slug: business-tools
  name: Business Tools
spec:
  transport: stdio
  endpoint:
    command: node
    args: [server.js]
    cwd: /absolute/path/to/project
  secret_refs:
    env.BUSINESS_TOKEN: BUSINESS_MCP_TOKEN
  policy:
    allowed_tools: [get_account, create_review]
    approval:
      mode: selected
      tools: [create_review]
    side_effecting_tools: [create_review]
    connect_timeout_ms: 10000
    call_timeout_ms: 60000
    max_output_bytes: 262144
```

For HTTP transports, use `endpoint.url` and targets such as `headers.Authorization` in `secret_refs`. Values are environment-variable names, not credentials. Unknown configuration and policy fields are rejected. Existing flat `transport`/`endpoint_config` records and `approval_required` lists remain accepted for compatibility and are normalized to this contract.

Omoikane connects and discovers Tools with the OpenAI Agents SDK, validates names and schemas, filters the exposed set, and converts each effective MCP Tool to a managed Function Tool. Policy is enforced again at invocation. Side-effecting Tools always require approval even when `approval.mode` is `never`. Calls have an aborting timeout and a serialized UTF-8 output limit. Oversized content is not stored; only size, SHA-256, and the stable error are recorded.

Each Run stores an immutable MCP Tool/policy snapshot and fingerprint. Approval resume therefore rebuilds the same Tool graph even if the server record changes. Tool name collisions across Function Tools or MCP servers fail Agent construction. An Agent reference may narrow, but never broaden, the server policy:

```yaml
mcp_servers:
  - server_id: business-tools
    policy_override:
      allowed_tools: [get_account]
      approval:
        mode: always
      call_timeout_ms: 30000
```

Allowlist merging uses intersection; side-effect and selected-approval sets use union; approval can only become stricter; timeouts and output limits use the lower value.

The REST inspection surface is:

- `GET/POST /v1/mcp-servers`, `GET/PATCH/DELETE /v1/mcp-servers/:id`;
- `POST /v1/mcp-servers/:id/health` for discovered/effective/blocked Tools and the current fingerprint;
- `GET /v1/mcp-servers/:id/tools` for effective schemas;
- `POST /v1/mcp-servers/:id/tools/:tool/call` for non-side-effecting, non-approval test calls only.

### MCP capability boundary

Omoikane is an MCP Tools Runtime, not a general-purpose MCP Host. The capability response deliberately reports `runtime_managed_mcp_tools: true`, `mcp_resources: false`, and `provider_hosted_mcp: false`.

| MCP capability                       | Product contract                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Tools over stdio/Streamable HTTP/SSE | Supported with discovery, filtering, approval, timeout, output limits, immutable Run binding, journaling, and recovery            |
| Resources, Resource Templates, Read  | Not exposed; a demand-gated read-only extension is possible because the Agents SDK transport wrappers already provide these calls |
| Prompts                              | Not supported; Agent instructions remain owned by immutable `AGENT.md` Deployments                                                |
| Roots                                | Not supported; Omoikane does not expose local directory authority to MCP servers                                                  |
| Sampling                             | Not supported; an MCP server cannot initiate model work outside the durable Run execution contract                                |
| Elicitation                          | Not supported; business identity, user interaction, and UI state remain business-system concerns                                  |
| Tasks                                | Not supported; MCP task state does not replace or bypass Omoikane Runs                                                            |
| OAuth discovery/refresh              | Not owned by the Runtime; the business system supplies credentials through explicit `secret_refs`                                 |
| Provider-hosted MCP                  | Not the cross-Provider backend; OpenAI-specific use may be added later only as an explicit adapter                                |

If a business integration needs Resources, add only bounded list/template/read APIs with timeout, size, URI, and content-type validation. Resource content must not be injected automatically into Agent context: the business system or an explicit Agent binding must select it. The other capabilities require a new ownership, approval, persistence, or isolation design and are not missing parts of the current MCP Tools contract.

Import trusted `SKILL.md` trees with `POST /v1/skills/import`, or upload a bundle through `POST /v1/skills/bundles`. Import rejects traversal, absolute and ambiguous paths, symlinks, non-canonical Base64, duplicate/case-colliding paths, and bundles over 500 files, 64 MiB total, 16 MiB per file, or 1 MiB for `SKILL.md`. Every version stores an ordered file index and SHA-256 content hash. A later source-tree mutation is detected before a Run uses it.

Versions imported by an earlier Omoikane build are first verified with the legacy hash algorithm; after a successful check, the Runtime backfills only the new file-index metadata. It never rewrites the Skill content during this compatibility upgrade.

Bind the returned immutable **Skill version ID**, never a Skill slug or implicit `latest` version:

```yaml
skills:
  - version_id: 019f...exact-version-id
```

The currently supported Skill contract is instruction-only: Omoikane verifies the exact immutable version and injects its `SKILL.md` instructions into the Agent. Bundle files may be retained and checksummed, but the supported Runtime does not materialize them into a command workspace or execute Skill entrypoints.

Workspace requirements, command requirements, network requirements, executable entrypoints, `sandbox_exec`, and the `omoikane.workspace` extension are experimental implementation details and are not part of the supported product contract. A business system that needs executable Skill assets should expose them through its own Function Tool or MCP service and own the required isolation policy.

MCP configuration is trusted local Runtime configuration. A stdio MCP process is not isolated merely because it uses MCP, and Omoikane currently provides no supported Sandbox. Run untrusted MCP implementations behind an isolation boundary owned by the business system. Runtime-managed Tools work with MiMo and other Providers through ordinary Function Calling as well as OpenAI models.

## 4. Deploy an Agent

An `AGENT.md` contains role-specific instructions and capability bindings. Shared defaults and business policy belong in deployment compilation settings or the calling business system, not in every role document.

```markdown
---
apiVersion: agentsdk/v1
kind: Agent
metadata:
  slug: analyst
  name: Analyst
spec:
  provider:
    connection_id: provider-connection-id
  model: mimo-v2.5
  tools: []
  mcp_servers: []
  skills: []
  model_settings:
    reasoning_effort: high
---

You are an evidence-driven analyst. Separate facts, inference, and unknowns.
```

```bash
npx omoikane validate ./agents/analyst/AGENT.md
npx omoikane deploy-agent ./agents/analyst/AGENT.md
```

The resulting Deployment is immutable and has a canonical `config_hash`. Changing instructions, model, capability bindings, Guardrails, output schema, context settings, or limits creates a new Deployment. The business system controls which Deployment ID is active.

Reasoning Effort is validated against the selected model. The Agent can override a known context-window default with `model_context_window`; this affects context planning and compaction but cannot make a Provider accept a larger request.

### Count a complete model input

For a qualified large-context model, count the complete input without creating a Run or invoking model generation:

```ts
const supported = await client.inputTokenCountingModels();

const count = await client.countInputTokens(String(deployment.id), {
  conversation: previousModelItems,
  input: "Select the relevant knowledge.",
  context: { business_object_id: "company-42" },
});

if (count.input_tokens > count.maximum_input_tokens * 0.95) {
  // Apply the business system's fallback policy.
}
```

The REST operations are `GET /v1/input-token-counting/models` and `POST /v1/deployments/:deploymentId/input-token-count`. The list contains only catalog models with at least 1,000,000 context Tokens and `input_token_counting.status = qualified`; it does not imply that a matching Provider Connection exists. The count request accepts the same `input`, `conversation`/`projection`, and model-visible context envelope as a Run, with `conversation` and `projection` mutually exclusive.

Omoikane asks the OpenAI Agents SDK to assemble system instructions, immutable Skill instructions, history, current input, Function/MCP Tool schemas, Handoffs, and structured-output configuration. It then calls the selected Provider's official count endpoint or, for explicitly cataloged open models, applies a pinned official chat/Tool serializer and Tokenizer. Runtime-only `context` data is not counted unless an Agent feature actually injects it into the model input. MCP discovery may open the configured read-only Tool-list connection, but the operation creates no Run, Event, Artifact, MCP Run binding, or model generation request.

The response returns `input_tokens`, context-window type and size, output reservation, `maximum_input_tokens`, method, accuracy, and count timestamp. For a total context window, the maximum input is the configured context window minus Deployment `maxTokens` or the catalog output limit; an input-window model uses its declared maximum input directly. Counting a supplied Projection validates and uses its items. The operation never invokes automatic compaction to manufacture a different input.

Failure is closed: an unqualified model, failed Provider count endpoint, unavailable official Tokenizer asset, or unsupported multimodal local-count request returns an error and never falls back to the compaction subsystem's rough byte-based estimator. Qualified Provider and local-Tokenizer models are documented in [Complete input Token counting](PROVIDERS.md#complete-input-token-counting).

Model retries use a conservative Runtime policy. The default is one retry, accepted only for HTTP 429 or a Provider adapter that explicitly marks replay as safe. Timeouts, ambiguous connection failures, 5xx responses, stateful replay without safety evidence, and a stream that emitted any Event are not retried automatically. Configure only the bounded JSON settings, never a callback:

```yaml
model_settings:
  retry:
    max_retries: 1 # 0..3
    backoff:
      initial_delay_ms: 250
      max_delay_ms: 2000
      multiplier: 2
      jitter: true
```

## 5. Create and stream a Run

Every Run is self-contained. Supply the canonical prior model items and any business-authorized context explicitly:

```ts
const run = await client.createRun({
  deployment_id: deploymentId,
  external_session_id: businessConversationId,
  conversation: priorModelItems,
  input: "Prepare the next answer.",
  context: { business_object_id: "company-42", authorized_facts: facts },
  limits: {
    max_turns: 20,
    max_tool_calls: 50,
    max_duration_seconds: 900,
  },
});

for await (const event of client.streamRun(String(run.id))) {
  render(event);
}

const completed = await client.getRun(String(run.id));
saveToBusinessStore(completed.output, completed.new_items);
```

Recover or inspect Runtime work without loading execution payloads:

```ts
let cursor: string | undefined;
do {
  const page = await client.listRuns({
    status: "waiting_approval",
    limit: 50,
    cursor,
  });
  for (const summary of page.data) console.log(summary.id, summary.status);
  cursor = page.next_cursor ?? undefined;
} while (cursor);
```

`RunSummary` deliberately excludes input, conversation, context, output, new model items, Tool values, SDK checkpoints, and detailed errors. Fetch one Run explicitly when its governed execution result is required.

The client supplies an `Idempotency-Key`. Repeating the same key with the same effective request returns the original Run; changing the request returns a conflict. `external_session_id` is correlation metadata and never causes Omoikane to load previous messages.

SSE Event sequence numbers are ordered per Run and replayable through `Last-Event-ID` while Event retention remains active. A transaction wakes local SSE waiters only after its Event commit; a low-frequency database poll remains as a correctness fallback. The TypeScript client reconnects a truncated or retryable HTTP stream from the last sequence number, rejects a sequence gap, deduplicates replayed Events by `seq`, and uses jittered exponential retry bounded at five seconds. The server applies stream backpressure, caps total and per-Run connections, returns retryable HTTP 429 with `Retry-After` at capacity, and sends an internal `stream.end` control frame when the current Run state closes the stream. Always fetch the Run for its terminal result and copy accepted results to the business store before TTL cleanup.

`run.started.data.execution_attempt` delimits provisional output. If a Worker lease expires, `run.requeued` invalidates provisional model/reasoning deltas from that attempt; the next `run.started` begins a new attempt. A process loss can repeat model work and Provider token usage, so Omoikane promises at-least-once Run execution, not exactly-once model calls.

`GET /v1/runs/:runId/usage` returns one cumulative Usage snapshot for the Run, including per-request entries when the SDK adapter exposes them. Token values are copied from the Provider/SDK; Omoikane does not estimate monetary cost.

`reporting_status` distinguishes the data contract:

- `reported`: token counts were reported;
- `partial`: only some model responses or internally inconsistent totals were reported;
- `missing`: the Provider/adapter omitted Usage, so token fields are `null`, not zero.

Cache and Reasoning Token details are preserved when available. Tokenization and detail fields can differ between Providers, so cross-Provider totals are operational observations rather than a normalized billing ledger. Omoikane rejects `pricing` and `max_cost_usd`; configure monetary quotas, subscriptions, discounts, and billing alerts with the Provider or business system.

## 6. Resume approvals and reconcile uncertain Tools

An approval-required Function Tool persists the OpenAI Agents SDK RunState and moves the Run to `waiting_approval`:

```http
POST /v1/approvals/:approvalId/approve
POST /v1/approvals/:approvalId/reject
```

Approval resumes the same durable Run. Expired approval requests are rejected by maintenance.

`waiting_reconciliation` means a process disappeared, a side-effecting Function/MCP Tool failed after dispatch, or its result commit was uncertain. Read `GET /v1/runs/:runId/tool-executions`, verify the external system, and resolve the execution through `POST /v1/tool-executions/:executionId/resolve` with `status` (`completed` or `failed`), the verified output/error, and a required `reason`. Once every ambiguous execution is resolved, the Run returns to the queue and resumes the persisted approval checkpoint. Never blindly retry an ambiguous side effect.

The npm API exposes `DeterministicFaultInjector` only as a programmatic test hook on `Container.create({ faultInjector })`; there is no REST or environment switch. The recovery suite injects failures before/after terminal commit, before approval and maintenance commit, around model dispatch/results, after Tool effects, and before SSE delivery. It also closes and reopens a persistent PGlite database. PostgreSQL tests kill a claiming Worker process and verify lease recovery and Tool uncertainty handling.

## 7. Use structured output and Guardrails

Declare an object-root JSON Schema on the Agent:

```yaml
output_schema:
  type: object
  properties:
    answer:
      type: string
    confidence:
      type: number
      minimum: 0
      maximum: 1
  required: [answer, confidence]
  additionalProperties: false
```

Deployment compiles the schema and rejects invalid definitions or a non-object root. At execution time Omoikane reads the selected model capability:

- `native`: the exact schema is passed to the OpenAI Agents SDK as strict structured output and the result is validated again locally;
- `prompt`: the schema is injected as an exact-JSON system contract, the final text is parsed, and the parsed value is validated locally. No unsupported native parameter is sent to the Provider.

A Run is `completed` only when local validation succeeds. Invalid JSON or a schema mismatch produces a terminal `failed` Run with code `structured_output_invalid`; `details.stage` is `parse` or `schema`, and schema issues contain only `path`, `keyword`, and `message`. Omoikane does not repair JSON or automatically retry a validation failure because repair can change semantics and a retry can repeat Tool side effects.

For a structured Run, `model.output_delta` Events are provisional; `message_output_created` and `agent.completed` store only a pending marker, not the unvalidated value. Treat only a `run.completed` Event with `structured_output_validated: true` and the terminal Run `output` as accepted. See [Provider and model catalog](PROVIDERS.md#structured-output) for capability rules.

Use `npm run test:e2e:structured-output` for the opt-in live conformance check. It tests MiMo when `MIMO_API_KEY` is available and local Codex Bridge when `CODEX_BRIDGE_API_KEY` or its normal `~/.cb/config.json` credential is available. The test never prints either credential.

Guardrails use the OpenAI Agents SDK Input/Output Guardrail lifecycle and an
Omoikane-owned typed implementation registry. Configure one or more checks on
an Agent Deployment:

```yaml
guardrails:
  input:
    - id: blocked-input
      implementation_key: builtin.regex
      config:
        deny_patterns: ["forbidden input"]
      timeout_ms: 1000
      on_error: block
  output:
    - id: blocked-output
      implementation_key: builtin.regex
      config:
        deny_patterns: ["forbidden output"]
```

`id`, `implementation_key`, configuration shape, duplicate IDs, regular
expressions, timeouts, and failure policy are validated before deployment.
`timeout_ms` defaults to 1000 and is bounded to 1–60000. `on_error` defaults to
`block`; choose `allow` only when the business explicitly accepts fail-open
behavior. Existing `input_deny_patterns` and `output_deny_patterns` definitions
remain accepted and are stored in the canonical form above.

Register a business-owned TypeScript implementation before deploying an Agent
that references it:

```ts
import { registerGuardrailImplementation } from "omoikane";

registerGuardrailImplementation(
  "business.account-policy",
  async ({ stage, value, runtime, config, signal }) => {
    const permitted = await checkBusinessPolicy({
      stage,
      value,
      accountId: String(runtime.account_id),
      config,
      signal,
    });
    return permitted
      ? { decision: "allow" }
      : {
          decision: "block",
          code: "account_policy_denied",
          message: "content was rejected by account policy",
        };
  },
);
```

Registration must happen inside the Runtime process. The stock
`omoikane-runtime` executable contains only `builtin.regex`; a project that uses
custom implementations starts a small wrapper which registers its handlers,
then creates `Container` and serves `createApp(container)`. This is the same
process-level extension model used by custom Function Tool implementations.

The decision contract is deliberately only `allow` or `block`; Guardrails do
not rewrite model input or output. A block produces stable terminal codes
`input_guardrail_blocked` or `output_guardrail_blocked`, with the business
decision code under `details.policy_code`. A timed-out or invalid/failing
implementation produces `guardrail_timeout` or
`guardrail_execution_failed`. Events `guardrail.started`,
`guardrail.passed`, `guardrail.blocked`, and `guardrail.failed` contain identity,
duration, decision, code, and bounded implementation metadata, but Omoikane
never adds the checked input or output. Custom `message` and `metadata` fields
are trusted application data and must not contain content or secrets.

Input checks are blocking and all finish before the first model request. When
any reachable Agent has an Output Guardrail, Omoikane switches the whole Run to strict output
delivery: it does not publish or store model text, reasoning deltas, final
message items, or `agent.completed` output before the SDK accepts the final
output. Accepted text is then emitted as buffered `model.output_delta` Events in
the same database transaction as `run.completed`; rejected text is never added
to Run Events. Tool call arguments and Tool outputs have their own policy and
approval contract and are not inspected by Output Guardrails.

These hooks let the business system own PII or domain policy without embedding
that policy in Omoikane. They do not replace business authorization, Tool input
validation, or Tool approval. Tool Guardrails and Omoikane-managed remote
policy callbacks are not part of the current contract.

## 8. Compact context

Automatic compaction evaluates the complete model request before the first and every subsequent model call: caller input, instructions, Tools, handoffs, output schema, output reserve, and safety margin. It produces a temporary Projection and small recoverable Run control state, but never writes long-term memory or changes the canonical transcript. The same transformation is available through `POST /v1/context/compact` for preview, dry run, or explicit use.

Deployment `compaction.strategy` defaults to `auto`. Known OpenAI and Codex Bridge Responses models use Provider-native `POST /responses/compact`; unsupported models use Omoikane's portable evidence-bearing checkpoint. Choose `native` to require the native endpoint or `portable` to disable it. A native Projection contains an opaque encrypted `compaction` item and an issuer fingerprint; preserve it unchanged and replay it only through the compatible Provider endpoint/model.

Projection v4 preserves semantic source references, exact anchors, bounded user excerpts, Tool ledger, repeated-compaction lineage, compatibility metadata, and validation results. New Projections expose `validation.semantic_risk` with explicit reasons, a Provider/model/strategy evaluation key, and a caller action; it is deliberately not a fabricated numeric confidence score. `POST /v1/context/compact` accepts either raw `items` or a prior `projection`; `POST /v1/runs` accepts either `conversation` or `projection`. Prefer the full Projection so compatibility and lineage are not discarded.

Compaction is lossy. Preserve the full transcript in the business system and keep consequential facts in structured domain fields or Tools. See [Context compaction](CONTEXT_COMPACTION.md) for settings, response shape, test coverage, and reliability limits.

## 9. Transfer temporary Artifacts

Omoikane does not currently support a built-in Sandbox or model-directed shell execution. Function Tool and MCP implementations execute within their own process or service boundary; the business system must isolate any untrusted implementation externally. Experimental Process/Docker Sandbox code in the repository is retained for possible future work but is undocumented, unsupported, and excluded from the product compatibility contract.

Artifacts are local, Run-scoped transfer and debugging files with checksum, lineage, size, and TTL. Upload with `POST /v1/artifacts?run_id=...`; list with `GET /v1/artifacts?run_id=...`; inspect, download, or delete by Artifact ID. The npm client exposes `uploadArtifact`, `listArtifacts`, `getArtifact`, `downloadArtifact`, and `deleteArtifact`.

Uploads stream into a private staging file and become visible only after size, checksum, per-file limit, and total active-byte limit checks pass. The persisted lifecycle is `staging -> active -> deleting -> deleted`, with `corrupt` used when stored bytes are missing or fail verification. Startup reconciles interrupted uploads/deletions and removes orphan files. Metadata reads and lists hide expired active rows immediately; download verifies the recorded size and SHA-256 before returning bytes. Errors use `artifact_too_large`, `artifact_capacity_exceeded`, or `artifact_corrupt` where applicable.

`GET /v1/runtime/status` reports active Artifact bytes plus configured per-file and total limits. Omoikane does not provide permanent storage: the business system must download and retain every file it needs before `expires_at`.

## 10. Operate storage and upgrades

PGlite is the official default. PostgreSQL is optional when a local integration needs its operational properties. Both use the same ordered migrations and durable Run semantics.

The maintenance loop:

- renews and reclaims Run leases;
- expires unresolved approvals;
- removes expired Artifact files and terminal execution detail;
- retains enough Run control metadata and aggregate Usage for local operation.

Migration `0005` collapses legacy namespaces and removes cloud/control-plane state. It aborts if old namespaces contain conflicting resource slugs or idempotency keys; resolve those records deliberately and rerun. Migration `0006` removes monetary Usage semantics, makes missing Token fields nullable, and keeps one cumulative Usage snapshot per Run. Omoikane never chooses conflicting migration data automatically.

### Compatibility gate

Every startup performs a read-only migration preflight. Unknown future versions and discontinuous histories are rejected. `OMOIKANE_AUTO_MIGRATE=true` initializes only a database with no migration table; it does not silently change an existing database. If migrations are pending, stop the Runtime and use the explicit safe-upgrade workflow.

The CLI Runtime, backup, restore, and upgrade commands use a local lock. The operation fails if the same data directory is active. Programmatic `Container.create()` does not claim this process lock because an embedding application owns its lifecycle; the embedding application must stop all access before calling maintenance functions.

### PGlite snapshot and restore

With the Runtime stopped:

```bash
npx omoikane upgrade --check
npx omoikane backup /safe/location/omoikane-before-change
npx omoikane backup-verify /safe/location/omoikane-before-change
npx omoikane restore /safe/location/omoikane-before-change /new/empty/data-dir
```

The backup command writes to a new directory atomically and verifies every regular file with SHA-256. Its versioned manifest records the Runtime version, applied and target migrations, and exclusions. It contains the offline PGlite directory, local `credential.key` when file-backed, immutable Skill bundles, and the Artifact directory. It excludes Sandbox workspaces, caches/logs, environment Provider keys, and business-owned conversations or memory that Omoikane never stored.

Restore accepts only a missing or empty destination and never overwrites an active data directory. It verifies the manifest and checksums, migration compatibility, encrypted Provider credential readability, Skill file indexes, Artifact metadata/bytes, and relocates absolute Skill bundle paths. A snapshot created with `OMOIKANE_CREDENTIAL_SECRET` instead of a key file requires that same environment secret during restore. Restore preserves the snapshot's schema version; run `upgrade` afterward if it is older than the current head.

Do not edit a snapshot or treat its checksum manifest as protection against a malicious party who can rewrite both files and manifest. This is corruption detection for trusted local storage, not a signed or encrypted archive.

A file-backed snapshot contains `credential.key` alongside the database ciphertext, so it can recover directly submitted Provider keys. Store the snapshot with the same local access restrictions as the live Runtime data directory.

### Safe upgrade

```bash
npx omoikane upgrade --check
npx omoikane upgrade --backup /safe/location/explicit-pre-upgrade-copy
```

For an existing PGlite database with pending migrations, `upgrade` performs preflight, creates and verifies a pre-upgrade snapshot, applies ordered migrations, and verifies the resulting head. Without `--backup`, it creates a timestamped sibling under `omoikane-backups`. A new uninitialized database needs no snapshot. `omoikane migrate` and `omoikane-migrate` are aliases for this safe workflow.

Migrations are forward-only. A failed upgrade is not followed by an automatic restore or down migration: preserve the failed directory for diagnosis, then restore the verified pre-upgrade snapshot into an empty directory and point `OMOIKANE_DATA_DIR` at it.

### PostgreSQL

Omoikane does not implement a second logical dump format. Create and validate a backup with the PostgreSQL tools appropriate for the installed server version, then provide the non-empty dump as upgrade evidence:

```bash
pg_dump --format=custom --file=/safe/location/omoikane.dump "$OMOIKANE_DATABASE_URL"
npx omoikane upgrade --check
npx omoikane upgrade --postgres-backup /safe/location/omoikane.dump
```

Omoikane records the dump path, size, modification time, and SHA-256 in the command result before migrating. It does not prove that a plain file is a restorable PostgreSQL dump; test `pg_restore` and perform rollback with PostgreSQL's official tools under the business system's operational policy.

## 11. Observe the Runtime safely

Observability is Runtime-global infrastructure, not part of an Agent role or Deployment. New `AGENT.md`, overrides, compilation defaults, and JSON Deployments containing `tracing` are rejected. If an older database already contains that historical field, the Runner ignores it; it cannot enable or disable export for one Agent.

Tracing is off by default. Importing the OpenAI Agents SDK normally installs its OpenAI exporter, so Omoikane explicitly disables tracing, shuts down that processor, and replaces it before any Run starts. To opt in to OpenAI tracing:

```bash
export OPENAI_TRACING_API_KEY='...'
export OMOIKANE_TRACING_EXPORTER=openai
export OMOIKANE_TRACING_API_KEY_ENV=OPENAI_TRACING_API_KEY
```

This key is separate from Provider Connections. Selecting MiMo, Codex Bridge, Anthropic, or another model Provider never causes traces to be sent to OpenAI. A custom in-process integration registers a `TracingExporter` with `registerTraceExporter("name", factory)` before `Container.create()`, then selects `OMOIKANE_TRACING_EXPORTER=custom:name`. The stock executable cannot load project-specific custom code; use the same small Runtime wrapper pattern as custom Function Tools and Guardrails.

Trace content is always `metadata_only`; there is no full-content switch. Omoikane sets both the SDK global sensitive-data logger and each Runner to exclude model input/output, Tool arguments/results, rejected Guardrail output, and credentials. Trace metadata contains `run_id`, stable `run_trace_id`, `execution_attempt`, `deployment_id`, `provider`, and `model`. It never automatically includes `external_session_id`. Each attempt's SDK Trace ID is stored in the corresponding `run.started` Event.

Exporter calls are batched in a bounded queue. Export failures are isolated from Runs and degrade only observability status. `Container.close()` flushes and shuts down the processor. `ready` means the local exporter invocation has not raised an observable error; the SDK OpenAI exporter does not provide an end-to-end delivery receipt.

Inspect the bounded operational view without reading execution content:

```bash
curl http://127.0.0.1:8000/v1/runtime/status
```

`OmoikaneClient.runtimeStatus()` returns process uptime, configured/active Worker counts, queue counts by Run status, active/configured SSE limits, maintenance timestamps, and Trace exporter state. This endpoint does not expose Provider keys, inputs, outputs, Tool values, or exception text. Runtime-generated failure logs likewise contain only allowlisted identity/status metadata and a sanitized error type; detailed business/provider failures remain in their governed Run or Provider API contracts.

Built-in Prometheus metrics, OTLP configuration, dashboards, and durable Trace storage are intentionally absent. Add a custom exporter or an external local-process collector only when an integration has a concrete operational requirement.

## 12. Validate changes

```bash
npm run check
npm test
npm run check:docs
npm run build
```

The opt-in `npm run test:e2e:mimo-audio` check synthesizes a short WAV with `mimo-v2.5-tts`, sends the returned bytes through `mimo-v2.5-asr`, and verifies a non-empty round-trip transcript. It reads `MIMO_API_KEY` from the ignored `.env` file and never prints the credential.

The offline suite includes malformed request tables, unknown-field rejection, credential non-reflection, dynamic-payload compatibility, both MCP request formats, and an assertion that every documented operation is emitted from the shared OpenAPI contract.

Run the supported optional integration suite when changing its area:

```bash
npm run test:postgres:docker
```

Live MiMo tests read `MIMO_API_KEY` only from ignored `.env` files or the process environment. The 100K compaction benchmark makes several paid calls and should be run deliberately.

For release qualification of compaction semantics, run `npm run eval:compaction`. The Harness uses the versioned synthetic corpus, strict structured Probe batches, deterministic fact/constraint/false-state scoring, and optional multi-generation comparison. Use `OMOIKANE_COMPACTION_EVAL_GENERATIONS=3` for the qualified Portable envelope and select Codex Bridge through the environment variables documented in [Context compaction](CONTEXT_COMPACTION.md). Reports are local test artifacts, not Runtime state.

## 13. Troubleshoot

| Symptom                                               | Meaning or action                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `provider credential environment variable is missing` | expose the referenced variable to the Runtime process                   |
| no Reasoning Effort selector                          | the selected model does not declare compatible Effort values            |
| `waiting_reconciliation`                              | inspect the external side effect and resolve its durable Tool execution |
| terminal output disappeared                           | the TTL elapsed; persist accepted output in the business system         |
| `cannot merge legacy namespaces`                      | resolve the listed old cross-namespace collision before upgrading       |
| untrusted Tool or MCP implementation                  | isolate it outside Omoikane; no built-in Sandbox is currently supported |
| tracing reports `degraded`                            | inspect the custom/export destination; Runs continue independently      |

Capability boundaries and operational caveats are documented in the relevant sections above rather than maintained as a separate progress document.
