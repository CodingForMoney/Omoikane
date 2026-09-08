# Architecture and state ownership

## Product boundary

Omoikane is a persistent execution engine, not a platform control plane. One process serves one local business system and one namespace. There are no Tenant, User, Actor, authentication, organization, or cross-customer isolation concepts in its API or current schema.

The ownership rule is:

> Generic execution state required for reliable Agent operation belongs to Omoikane. State whose meaning, permission, lifecycle, or correctness depends on the domain belongs to the business system.

| State                                                       | Owner           |
| ----------------------------------------------------------- | --------------- |
| Provider/model configuration                                | Omoikane        |
| Immutable Agent Deployment                                  | Omoikane        |
| Tool, MCP, and Skill definitions                            | Omoikane        |
| Run queue/status/lease/retry/cancel                         | Omoikane        |
| Approval checkpoint and SDK RunState                        | Omoikane        |
| Tool idempotency, MCP Run snapshots, and ambiguous result   | Omoikane        |
| Short-lived Event, Usage detail, and Artifact               | Omoikane        |
| Worker/maintenance status and metadata-only execution Trace | Omoikane        |
| User identity and business authorization                    | Business system |
| Canonical conversation and messages                         | Business system |
| Long-term memory or experience                              | Business system |
| Business records, notifications, releases, permanent files  | Business system |

## Local topology

```text
Business system
      |
      | REST / SSE on loopback
      v
+-------------------------------------------+
| One Omoikane process                      |
| API + Provider/Agent/Tool/MCP/Skill       |
| Run queue + Worker pool + maintenance     |
| Approval + Compaction + Artifact + Usage  |
| Runtime status + metadata-only Tracing    |
+-------------------------------------------+
      |                         |
      v                         v
PGlite by default          Local Artifact files
PostgreSQL optional        Immutable Skill bundles
```

The default Worker pool has four slots. A separate maintenance loop reclaims expired leases, expires approvals, and applies retention. This is one service topology; there is no standalone Worker executable or generation router.

## Run lifecycle

```text
queued -> running -> completed | failed | cancelled
                    |
                    +-> waiting_approval -> queued
                    |
                    +-> waiting_reconciliation
```

Queued Runs are claimed transactionally and receive a monotonically increasing `execution_attempt`. A running Run renews its lease. After process loss, a Run with no uncertain Tool side effect is returned to the queue. The `run.requeued` Event declares `execution_semantics: at_least_once`, `model_replay_possible: true`, and invalidates provisional output from the preceding attempt.

Every side-effecting Function Tool and MCP Tool is approval-gated. The approval stores the OpenAI Agents SDK `RunState` before dispatch, so reconciliation resumes the exact same Tool call and idempotency key. If the external effect or its local result commit is uncertain, the execution becomes `unknown` and the Run waits for explicit reconciliation instead of repeating it.

Run state transitions and ordered Events share a database transaction. The Runtime persists input, caller conversation, context, output, and SDK approval state as JSONB so the local process can recover after restart.

Recovery guarantees are deliberately explicit:

| Boundary                                | Semantics                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| Run execution after Worker loss         | at least once; model work and cost may repeat                                            |
| Run terminal state + matching Event     | one local database transaction                                                           |
| Side-effecting Tool                     | approval checkpoint + idempotency journal; unknown outcomes require reconciliation       |
| Model retry inside one attempt          | at most one by default, and only for HTTP 429 or Provider-confirmed replay-safe failures |
| Timeout, ambiguous network failure, 5xx | no automatic model replay                                                                |
| SSE Event delivery                      | at least once across reconnect; deduplicate by per-Run `seq`                             |

The Runtime writes `model.request_started`, `model.request_completed`, and `model.request_failed` Events without request or response content. A started request with no matching completion after process loss is evidence that Provider work may have happened. Omoikane does not claim exactly-once model execution.

REST resource lists use bounded `(created_at,id)` keyset pagination. `GET /v1/runs` returns control-plane summaries rather than stored execution payloads. SSE remains database-backed and replayable by per-Run sequence, but idle streams wait on an in-process notification registered after transaction commit, with a low-frequency database fallback. Total and per-Run connection limits protect the single local process. There is no Redis, distributed Event Bus, or cross-instance stream coordination.

Temporary Run Artifacts use a filesystem/SQL recovery protocol because those two stores cannot share one transaction. Upload streams to a private staging file, persists size and SHA-256, atomically renames the file, and then exposes the metadata as `active`. Deletion first records `deleting` and is idempotently completed by maintenance or startup recovery. Startup also reconciles interrupted `staging` records, verifies active files, and removes orphans. TTL is enforced on every read/list as well as by maintenance. Per-file and total active-byte limits bound local memory and disk exposure; permanent files remain business-owned.

Every Run has a stable Omoikane `trace_id`. When Runtime-global tracing is enabled, each execution attempt gets a separate OpenAI Agents SDK Trace ID recorded in `run.started`. SDK Trace metadata contains only the Run ID, stable Run Trace ID, execution attempt, Deployment ID, Provider, and model. It deliberately excludes `external_session_id`. Input/output, Tool arguments/results, rejected Guardrail output, and credentials are disabled at both the Runtime Runner and SDK global logging layers.

The model-event adapter consumes the OpenAI Agents SDK's Provider-independent
`output_text_delta` envelope and, for information the SDK does not normalize,
the nested raw `model.event` envelope. Request controls are selected from the
model capability record and translated to Responses reasoning, Chat
Completions Provider fields, Anthropic thinking, or Gemini thinking config.
OpenAI-compatible aliases and Mistral thinking chunks are normalized before
the SDK continues consuming the same chunk, preserving reasoning-item continuity
through Function Tool turns.

The Event layer publishes only catalog-allowlisted public reasoning-summary
deltas and completed snapshots. Completed streamed text is authoritative over
accumulated deltas, which are authoritative over an explicit `summary_text`
fallback in a completed Responses reasoning item. Provider-private
`reasoning_text`, `reasoning_content`, thinking blocks, and encrypted data are
never copied into a Runtime Event. When a Provider emits a visible trace, the
adapter publishes only
`model.reasoning_metadata_started`, throttled cumulative `progress`, and a
content-free `completed` snapshot. Counts are derived from deltas; a repeated
`done` body is ignored unless no deltas arrived. Provider-reported Reasoning
Tokens are used when available and are never estimated. Normalization state is
scoped to one Run execution attempt and discarded on requeue.

Input and Output Guardrails execute through the OpenAI Agents SDK lifecycle,
while their typed local implementation registry, timeout/failure policy,
structured audit Events, and delivery safety belong to Omoikane. Input checks
finish before a model request starts. If a reachable Agent has an Output
Guardrail, the Runtime withholds model text, reasoning summaries, message items, and
`agent.completed` output until the final output passes. Accepted buffered text
and completed public reasoning summaries commit atomically with the terminal Event;
rejected content never enters the Run Event stream. Content-free reasoning
activity metadata can stream before Guardrail completion because it cannot
reveal the checked output or private reasoning text. Function/MCP Tool arguments and outputs remain governed by Tool
schema, approval, and execution policy rather than Output Guardrails.

## Conversation and memory

A Run is self-contained:

```json
{
  "deployment_id": "...",
  "external_session_id": "correlation-only",
  "conversation": [],
  "input": "...",
  "context": {}
}
```

There is no Session or Memory repository. Compaction transforms caller-supplied items into a temporary Projection; it does not change the business transcript or write long-term memory. Business memory can be supplied through `context`, a Function Tool, or MCP after the business system applies its own permission, freshness, and relevance rules.

## Retention

| Class                                    | Default                                    |
| ---------------------------------------- | ------------------------------------------ |
| Active Run/checkpoint                    | retained until resolved or terminal        |
| Terminal payload and detailed errors     | purged after 24 hours                      |
| Events for terminal Runs                 | deleted after 7 days                       |
| Active Artifact bytes                    | unavailable at TTL; deleted by maintenance |
| Artifact lifecycle tombstones            | purged one Artifact TTL after transition   |
| Run control metadata and aggregate Usage | retained for operation                     |

The business system must copy accepted results and files before TTL expiry.

## Local trust model

The API is unauthenticated and binds to loopback by default. Remote binding requires an explicit unsafe override and must be placed behind the business system's trusted boundary. CORS origins are allowlisted.

Provider keys are protected against accidental database-only disclosure. Omoikane does not claim to protect local data after the host or Runtime process is compromised. Run-level application encryption, cloud KMS, keyrings, tenants, and end-user authorization are non-goals.

The OpenAI Agents SDK installs an OpenAI Trace exporter when imported, but Omoikane replaces that global processor before any Run starts. Tracing is disabled by default. Export to OpenAI requires an explicit Runtime setting and dedicated key; custom exporters must be registered in the same process. Export is bounded and batched, failure never changes Run status, and shutdown flushes pending items. Logs use allowlisted correlation/status fields and do not serialize raw exceptions, Provider bodies, Tool content, or credentials.

stdio MCP servers receive a minimal environment, not the Runtime's Provider keys or database settings. Static MCP credentials must be injected explicitly with `secret_refs`.

MCP Tools are Runtime-managed rather than delegated to a Provider-hosted MCP feature. Omoikane uses the OpenAI Agents SDK transports and conversion primitives, then applies its own allowlist, approval, timeout, output-size, execution-journal, collision, and per-Run Tool-schema/policy snapshot rules. Remote HTTP MCP may additionally use the SDK's standards-based OAuth client through a Runtime-owned persistence adapter. Endpoints and credentials remain operational server configuration, so they must not change while dependent Runs are nonterminal. This keeps the contract consistent across OpenAI, MiMo, and other Providers. MCP endpoint configuration is trusted local configuration; URL/domain policy is not an isolation boundary.

OAuth client registrations, access/refresh tokens, PKCE verifier, state, and discovery cache are stored in one AES-256-GCM encrypted record per MCP server. The public MCP resource stores only non-secret OAuth policy and environment-variable names. Dynamic registration supports public and confidential clients; URL-based Client IDs publish a metadata document through the Runtime; pre-registered client secrets remain environment-only. Authorization must be started explicitly while refresh is attempted only after a protected server rejects the current token. In explicit scope mode, authorization redirects and returned token scopes are checked against the configured set (`offline_access` is the sole protocol-maintenance allowance). Automatic mode follows server metadata and therefore forces approval on every Tool call. Endpoint or OAuth configuration changes delete the prior credential record. Callback state expires after 15 minutes and is issuer-bound by persisted discovery metadata. Local disconnect deletes the encrypted record; it does not claim provider-side revocation.

The supported boundary is MCP Tools, not a general-purpose MCP Host. Resources/Templates/Read are a possible demand-gated read-only extension but are not automatically injected into model context. Prompts would conflict with Deployment-owned instructions; Roots would grant filesystem authority; Sampling would permit server-initiated model work; Elicitation would require business user interaction; and Tasks would duplicate durable Runs. OAuth is limited to the outbound remote-Tool connection lifecycle described above; it does not add Runtime users or business identity authorization.

Skill definitions and their immutable file indexes belong to Omoikane because exact version binding and checksum verification are generic execution infrastructure. Skill content and version selection belong to the business system. The supported contract injects `SKILL.md` instructions; it does not provide executable Skill workspaces or automatically run bundled entrypoints.

Omoikane currently provides no supported built-in Sandbox or model-directed shell execution. Function Tool and MCP implementations run inside boundaries selected by the integrating business system, which must externally isolate untrusted code. Experimental Process/Docker Sandbox code remains in the repository only as a future option and is not part of the public product contract.

## Upgrade migration

Runtime startup always checks that recorded migrations are a contiguous prefix known to the binary. A new database can be initialized automatically; an existing database with pending migrations refuses to start until the offline safe-upgrade command runs. This prevents an application restart from silently combining schema mutation with normal Run processing.

PGlite safe upgrade is `preflight -> offline snapshot -> checksum verification -> ordered migration -> post-verification`. The snapshot contains generic execution state, the file-backed Runtime credential key, Skill bundles, and temporary Artifacts. Restore is allowed only into a missing or empty target and verifies database compatibility plus Provider credential, MCP OAuth state, Skill, and Artifact readability. The CLI coordinates these operations with the Runtime lock. Rollback means restoring the pre-upgrade snapshot; there are no destructive down migrations.

PostgreSQL uses the same migration preflight and post-verification, but backup and restore remain delegated to `pg_dump` and `pg_restore`. Before an existing PostgreSQL schema is changed, Omoikane requires a non-empty external backup file and records its checksum as evidence. It does not claim to validate the dump's logical completeness.

Migration `0005` collapses legacy tenant namespaces, removes unused cloud/control-plane tables and fields, and keeps only the single-instance schema. Before changing anything, it detects duplicate resource slugs, Run idempotency keys, and Tool idempotency keys across old namespaces. Any conflict aborts the migration transaction; Omoikane never chooses or overwrites a winner automatically.

Migration `0006` converts Usage to a Provider-reported Token contract: `reported`, `partial`, or `missing`, with `null` Token counts for missing reports and one cumulative snapshot per Run. Monetary pricing and budget calculation are deliberately outside the Runtime.

Migration `0007` adds immutable MCP Tool/policy bindings per Run and MCP execution provenance, side-effect, output-size, and output-hash fields.

Migration `0008` adds small per-Run compaction control state so projection revision, retry suppression, and measured-token verification survive process restart. It does not add Session, transcript, or memory storage.

Migration `0009` adds the durable Run execution-attempt counter used to delimit replayed provisional Events.

Migration `0010` adds the Run/status keyset index used by bounded Artifact listing. The lifecycle itself reuses the existing durable `status`, checksum, size, and expiry fields.

Migration `0011` adds encrypted per-server MCP OAuth state and normalizes existing MCP resources to explicit `auth.type: none`.

Earlier migrations remain in the package so existing databases can upgrade in order. A new database ends at schema head `0011`.
