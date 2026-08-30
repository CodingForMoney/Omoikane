# Omoikane

Omoikane is a durable, local TypeScript Agent Runtime built on the OpenAI Agents SDK. One Runtime instance belongs to one business system. It provides reusable Agent execution infrastructure without becoming the business system's user, conversation, memory, workflow, or domain-data service.

## Responsibility boundary

Omoikane owns the infrastructure state required to execute and recover a Run:

- Provider Connections and discovered model capabilities;
- immutable Agent Deployments compiled from `AGENT.md` or JSON;
- Function Tool, MCP, and `SKILL.md` definitions;
- durable Runs, leases, retries, cancellations, approvals, SDK checkpoints, and Tool reconciliation;
- short-lived Events, detailed Usage, execution payloads, and Run Artifacts.

The business system owns users and authorization, canonical conversations, domain records, long-term memory, notifications, rollout decisions, and permanent files. It supplies relevant conversation and context to every Run and persists the accepted result.

## Install and start

Requirements: Node.js 22 or newer.

```bash
npm install omoikane
npx omoikane-runtime
```

The local defaults are:

- REST/SSE at `http://127.0.0.1:8000`;
- embedded PGlite under `./var/omoikane`;
- Artifacts and Skill bundles under `./var`;
- four in-process Run workers;
- metadata-only tracing disabled unless a Runtime exporter is selected;
- unauthenticated loopback access.

A non-loopback bind is rejected unless `OMOIKANE_ALLOW_REMOTE=true`. PostgreSQL is optional. Provider keys can be read from environment variables; directly submitted keys are protected by a private local credential key.

The complete OpenAPI 3.1 contract is served at `GET /openapi.json`. Runtime validation, exported npm request types, and OpenAPI are derived from the same Zod schemas. Runtime control envelopes reject unknown fields; explicitly dynamic business values such as Run `context`, model input items, Function Tool arguments, and JSON Schema remain open.

## Minimal workflow

Configure a Provider, deploy an Agent, then create a self-contained Run:

```ts
import { OmoikaneClient } from "omoikane/client";

const client = new OmoikaneClient({
  baseUrl: "http://127.0.0.1:8000",
});

const provider = await client.createProvider({
  name: "MiMo",
  provider: "xiaomi_mimo",
  endpoint_profile: "token_plan_cn",
  api_key_env: "MIMO_API_KEY",
});

const deployment = await client.deployDefinition(`---
apiVersion: agentsdk/v1
kind: Agent
metadata:
  slug: research-assistant
  name: Research Assistant
spec:
  provider:
    connection_id: ${provider.id}
  model: mimo-v2.5
---
You are a careful research assistant.`);

const run = await client.createRun({
  deployment_id: String(deployment.id),
  external_session_id: "business-conversation-42",
  conversation: previousModelItems,
  input: "Continue the analysis.",
  context: { business_object_id: "company-42" },
});

for await (const event of client.streamRun(String(run.id))) {
  console.log(event.type, event.data);
}

const completed = await client.getRun(String(run.id));
saveToBusinessStore(completed.output, completed.new_items);
```

`external_session_id` is correlation metadata only. Omoikane never loads prior messages from it.

## Capability summary

| Area       | Current capability                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| Runtime    | durable queue, leases, retry/cancel, restart recovery, paged Run listing, ordered Events, bounded REST/SSE             |
| Agents     | immutable `AGENT.md`/JSON Deployments, model settings, Handoffs                                                        |
| Providers  | built-in catalog, model sync/capabilities, qualified complete-input Token counting, MiMo V2.5 ASR/TTS adapters         |
| Tools      | Function Tools; Runtime-managed MCP Tools with policy, snapshots, approvals, and reconciliation                        |
| Skills     | immutable bundles, explicit version binding, checksum verification, instruction injection                              |
| Context    | caller-supplied conversation; native/portable temporary Projection; no Session or memory store                         |
| Output     | validated structured output; typed pluggable Input/Output Guardrails with safe output buffering                        |
| Execution  | Function Tools and MCP Tools; paged, checksummed, quota-bounded temporary Run Artifacts; no supported built-in Sandbox |
| Operations | PGlite snapshot/restore/safe upgrade, optional PostgreSQL, Usage, Runtime status, metadata-only SDK tracing            |

The MCP product contract intentionally covers Runtime-managed Tools, not a general-purpose MCP Host. Resources, Prompts, client callbacks, OAuth ownership, and Provider-hosted MCP are outside the current boundary rather than incomplete Tool support. Context compaction remains lossy and its reliability boundary is documented explicitly.

Complete-input Token counting is capability-gated per model. Omoikane uses Provider count endpoints where available and pinned official open-source chat serializers and Tokenizers for qualified MiMo, DeepSeek, and Qwen models. Local Tokenizer counting covers text requests only and fails closed for unsupported modalities or unavailable assets; see the Provider guide for the exact model list and accuracy class.

There are deliberately no users, tenants, authentication tokens, managed Sessions, long-term memories, supported Sandbox/model-directed shell execution, Webhooks, release channels, or permanent business file storage. Experimental Sandbox code remains in the repository for possible future evaluation, but it is not a product capability or compatibility commitment.

For PGlite maintenance, stop the Runtime and use `omoikane upgrade --check`, `omoikane backup`, `omoikane backup-verify <snapshot>`, `omoikane restore <snapshot> <empty-data-dir>`, and `omoikane upgrade`. An existing database is never silently upgraded at Runtime startup. PostgreSQL upgrades require an existing `pg_dump` file through `--postgres-backup`; restore remains an operator action using PostgreSQL's official tools.

## Validation

```bash
npm run check
npm test
npm run check:docs
npm run build
```

Optional supported suites cover PostgreSQL recovery, live Providers, MiMo ASR/TTS round trips, MiMo 100K portable compaction, and Codex Bridge native compaction plus continuation. They read secrets only from ignored environment files or the process environment.

## Documentation map

Each document has one job; implementation status is not duplicated across topic guides.

| Document                                                 | Purpose                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Developer guide](docs/DEVELOPER_GUIDE.md)               | end-to-end installation, configuration, API use, recovery, tests, and troubleshooting |
| [Architecture and state ownership](docs/ARCHITECTURE.md) | product boundary, topology, lifecycle, persistence, retention, and trust model        |
| [Provider and model catalog](docs/PROVIDERS.md)          | protocols, model capabilities, modalities, audio, Token counting, and credentials     |
| [Context compaction](docs/CONTEXT_COMPACTION.md)         | compaction contract, algorithm, API, reliability boundary, and evaluation             |

License: MIT.
