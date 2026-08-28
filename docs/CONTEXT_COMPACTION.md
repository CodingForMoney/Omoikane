# Context compaction

## Contract and ownership

Context Compaction converts caller-owned model input into a smaller, temporary Projection:

```text
(items or prior Projection, current input, complete model request, policy)
  -> Projection v4 + validation + metrics
```

It does not store a canonical conversation, write long-term memory, infer user preferences, or mutate the business transcript. The business system remains the source of truth. Omoikane stores only the Projection and small execution-control state needed to finish or recover a Run.

This implementation combines deterministic history reduction before model summarization, structured checkpoints with exact evidence, and repeated-checkpoint lineage. It deliberately does not use a memory flush: memory and compaction have different ownership and reliability requirements.

## When compaction runs

Compaction is evaluated before the first model call and again before every later model call in the same Agent run. Planning includes:

- input items and current user input;
- system instructions;
- Function and MCP Tool schemas;
- handoff schemas;
- structured-output schema;
- configured or reserved output tokens;
- a safety margin.

The Runtime uses a UTF-8 heuristic initially, then calibrates it against Provider-reported input usage during the Run. It starts at the high watermark, treats the emergency watermark as critical, and targets the low watermark. A context-overflow response may trigger one forced compaction and one replay only when a streamed request produced no output.

```yaml
model_context_window: 1048576
compaction:
  enabled: true
  strategy: auto
  high_watermark_ratio: 0.82
  low_watermark_ratio: 0.55
  emergency_watermark_ratio: 0.96
  reserved_output_tokens: 16384
  safety_margin_tokens: 2048
  preserve_recent_tokens: 16000
  chunk_tokens: 32000
  max_checkpoint_tokens: 8000
  max_attempts_per_run: 2
  keep_recent_tool_results: 6
  prune_tool_result_chars: 1500
  min_tool_prune_reclaim_tokens: 4096
  max_tool_ledger_entries: 64
```

Known models receive reviewed context/output defaults from the Provider catalog. A Deployment may override `model_context_window`, but an override cannot enlarge the remote model's actual limit.

## Strategies

### Native Responses compaction

`native` calls `POST /responses/compact`. `auto` selects it only when the chosen model explicitly declares `context_compaction.method = responses_compact`; this currently includes known OpenAI and local Codex Bridge Responses models.

Omoikane requires a `response.compaction` envelope, one non-empty final encrypted `compaction` item, and exact preservation of all returned user messages. It rejects ineffective or unsafe-sized output. The opaque item is never decrypted, summarized, converted to Portable format, or edited.

Projection v4 binds a native checkpoint to a fingerprint of protocol, Provider, base URL, model, and local credential identity. It is rejected when replayed through a different issuer. `auto` falls back to Portable only for a declared endpoint/capability incompatibility or malformed/ineffective native result. It does not hide authentication, authorization, quota, cancellation, timeout, network, or server failures behind a fallback.

### Portable structured checkpoint

Portable compaction performs these operations:

1. Normalize model items and group atomic units. A function call and all of its Tool outputs are never split across the checkpoint boundary.
2. Deterministically prune eligible old or duplicate large Tool results. Recent unique results remain verbatim; replacements retain size, digest, and SHA-256 evidence.
3. Keep a bounded recent raw tail and select the older prefix.
4. Chunk the prefix without splitting normal turns or Tool transactions. Oversized atomic units are segmented only for summarization, not for the final projection boundary.
5. Ask the configured model for strict semantic JSON. Every fact must cite an existing `source_ref`; prompt content is treated as untrusted data.
6. Merge every chunk hierarchically, retaining original source references.
7. Independently extract exact identifiers, bounded recent user excerpts, and a Tool call/result ledger from source items.
8. Validate schema, citations, anchors, excerpts, Tool integrity, source checksum, token target, and measurable reduction. Any failure leaves the input untouched and fails closed.

The semantic checkpoint contains `active_task`, `goal`, constraints, decisions, completed actions, current state, open questions, errors, artifacts, and critical facts. Deterministic evidence reduces model-summary loss but does not make the summary lossless.

Repeated compaction writes `generation` and `parent_checkpoint_id`. A new checkpoint summarizes the prior checkpoint as data plus newly eligible raw turns; it never treats a previous checkpoint as long-term memory.

## Projection v4

Important fields are:

```json
{
  "version": 4,
  "id": "...",
  "strategy": "portable",
  "revision": 2,
  "source": {
    "from_index": 0,
    "to_index": 41,
    "item_count": 42,
    "checksum": "..."
  },
  "compatibility": {
    "protocol": "portable",
    "model": "mimo-v2.5",
    "issuer_verified": true
  },
  "checkpoint": {
    "schema_version": 4,
    "checkpoint_id": "...",
    "parent_checkpoint_id": "...",
    "generation": 2,
    "semantic": {},
    "anchors": [],
    "user_excerpts": [],
    "tool_ledger": []
  },
  "items": [],
  "validation": {},
  "recovery_ref": { "run_id": "..." },
  "checksum": "..."
}
```

Every newly created Projection also contains `validation.semantic_risk`. This is an explainable risk signal, not a model-generated confidence score:

```json
{
  "assurance": "degraded",
  "risk_reasons": [
    "lossy_model_generated_checkpoint",
    "semantic_evaluation_is_release_evidence_not_online_proof"
  ],
  "recommended_action": "continue_with_business_validation",
  "evaluation_key": {
    "provider": "xiaomi_mimo",
    "model": "mimo-v2.5",
    "protocol": "responses",
    "strategy": "portable",
    "projection_version": 4
  }
}
```

Generation 1 recommends normal continuation with business validation. Generations 2 and 3 recommend that the caller make source items available for consequential work. More than three Portable generations are outside the currently qualified test envelope and recommend a fresh Run. Exceeding the deterministic anchor, excerpt, or Tool-ledger capacity also reports `deterministic_evidence_capacity_exceeded` and asks the caller for source items. The signal never retrieves history itself, blocks an otherwise valid Projection, or claims that a particular Projection is semantically complete. Older persisted v4 Projections remain readable without this additive field.

`checksum` covers the projected items. `source.checksum` identifies the exact source prefix being replaced. Version 3 Projections remain readable for compatibility, but only version 4 contains issuer, evidence, lineage, and validation metadata.

## API usage

Create a Projection from raw items:

```http
POST /v1/context/compact
Content-Type: application/json

{
  "deployment_id": "deployment-id",
  "items": [{"role":"user","content":"..."}],
  "current_input": "next request",
  "strategy": "auto",
  "force": false
}
```

For repeated compaction, send `projection` instead of `items`. To start a Run from an existing Projection, send `projection` instead of `conversation` to `POST /v1/runs`. The two fields are mutually exclusive. This retains all v4 compatibility and lineage metadata instead of reducing a Projection to its `items` array.

Run-time projection changes are persisted atomically with their `context.compacted` Event. `runs.compaction_state_json` records revision, attempt count, last input checksum, calibration state, and verification state so a process restart does not lose the execution decision. Terminal payload cleanup removes this state with the Projection.

## Reliability boundary

Compaction is production-usable infrastructure, but it is not perfectly trustworthy:

- Native compaction is opaque. Omoikane can prove envelope, issuer, size, and continuation properties, not its semantic contents.
- Portable compaction is inspectable and evidence-bearing but still model-generated and lossy.
- Provider tokenization is approximated before the first measured call.
- A source transcript can contain adversarial or ambiguous content that a summary mishandles.

Therefore preserve the full transcript in the business system, keep consequential state in structured business records or Tools, verify critical identifiers before side effects, and never use a Projection as the only legal, financial, medical, or audit record.

## Semantic effect evaluation

Omoikane evaluates downstream behavior rather than asking a second model whether a summary “looks good.” The versioned synthetic corpus at `evals/compaction/corpus-v1.json` contains 16 scenarios and 22 deterministic Probes covering:

- exact identifiers, paths, versions, dates, quantities, and Artifact lineage;
- final state after supersession, negation, hard constraints, decisions, and rationale;
- completed versus unresolved work;
- Tool transactions, code failures, and exact Tool results;
- Chinese/English mixed text;
- quoted prompt injection, hostile Tool payloads, irrelevant distractors, and absent facts.

Probe answers use strict structured output and are scored without an LLM judge. Release gates require critical-fact recall of at least 99%, exact identifiers and constraints at 100%, task success at least 95%, no known false facts, no stale superseded facts, and no more than a two-percentage-point drop between generations. A finite corpus establishes regression evidence and an operating envelope; it cannot prove correctness for every future conversation.

The opt-in Harness pads facts across approximately 48K estimated tokens, compacts once or repeatedly, runs Probes in bounded strict-Schema batches, and emits a JSON qualification report. Results are test artifacts and are not written to the Runtime database:

```bash
# MiMo Portable, one generation
npm run eval:compaction

# MiMo Portable, three generations, full report outside the repository
OMOIKANE_COMPACTION_EVAL_GENERATIONS=3 \
OMOIKANE_COMPACTION_EVAL_OUTPUT=/tmp/omoikane-compaction-eval.json \
npm run eval:compaction

# local Codex Bridge Native
OMOIKANE_COMPACTION_EVAL_PROVIDER=codex_bridge \
OMOIKANE_COMPACTION_EVAL_MODEL=gpt-5.6-sol \
OMOIKANE_COMPACTION_EVAL_STRATEGY=native \
OMOIKANE_COMPACTION_EVAL_API_KEY_ENV=CODEX_BRIDGE_API_KEY \
npm run eval:compaction
```

The default MiMo command reads `MIMO_API_KEY`; the Codex Bridge command reads `CODEX_BRIDGE_API_KEY` or the existing local Bridge configuration. Credentials are never included in the report. Provider/model/protocol/strategy/version tuples are evaluated separately because evidence from one tuple does not qualify another.

The 2026-08-28 release qualification recorded in `evals/compaction/qualification-baselines.json` produced:

| Subject | Generations | Result | Token reduction | Semantic result |
| --- | ---: | --- | --- | --- |
| MiMo `mimo-v2.5`, Portable | 3 | passed | 48,890 → 4,283 in generation 1; later generations remained below 4,700 | 22/22 each generation; maximum score drop 0 |
| Codex Bridge `gpt-5.6-sol`, Native | 1 | passed | 48,890 → 2,444 | 22/22; false/stale fact rates 0 |

The broader corpus exposed and now guards two defects that the former marker-only tests missed: Tool `call_id` anchors were incorrectly validated as message text, and repeated Portable compaction rejected inherited source references and failed to carry deterministic evidence forward. Portable compaction now inherits prior source refs, anchors, user excerpts, and Tool ledger entries. A structurally invalid generated checkpoint receives one explicit validation-repair attempt; the metric `summary_validation_retries` records whether it was used.

## Verification

The offline suite covers v4 schema/citation validation, atomic Tool transactions, deterministic pruning, exact evidence, cross-generation evidence inheritance, bounded checkpoint repair, semantic scoring, release thresholds, native issuer/fallback rules, per-call overflow retry, threshold planning, ineffective output, Run persistence, and checksum integrity.

Optional live suites cover MiMo portable 100K input and Codex Bridge native compaction plus continuation:

```bash
npm run test:e2e:compaction-100k
npm run test:e2e:codex-bridge-compaction
```

These paid tests and the semantic Harness read credentials only from the process environment or ignored local configuration and never print them. Re-run qualification when the corpus, Provider, model, protocol adapter, compaction strategy, checkpoint schema, Agents SDK, or Runtime version changes.
