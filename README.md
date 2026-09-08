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

The supported npm integration surfaces are intentionally small:

- `omoikane/client` is the recommended and only normal dependency of a business application;
- `omoikane/runtime` is for the local Runtime wrapper that registers business-owned Function Tool, Guardrail, or Trace implementations before calling `startRuntime()`;
- `omoikane/deployment` exposes the same declarative deployment operation used by `omoikane apply`;
- `omoikane/contracts` contains shared REST contracts for infrastructure adapters.

The root `omoikane` export remains available for pre-1.0 compatibility and advanced maintenance code, but new application code should not depend on its internal service classes.

The local defaults are:

- REST/SSE at `http://127.0.0.1:8000`;
- embedded PGlite under `./var/omoikane`;
- Artifacts and Skill bundles under `./var`;
- four in-process Run workers;
- metadata-only tracing disabled unless a Runtime exporter is selected;
- unauthenticated loopback access.

A non-loopback bind is rejected unless `OMOIKANE_ALLOW_REMOTE=true`. PostgreSQL is optional. Provider keys can be read from environment variables; directly submitted keys are protected by a private local credential key.

The complete OpenAPI 3.1 contract is served at `GET /openapi.json`. Runtime validation, exported npm request types, and OpenAPI are derived from the same Zod schemas. Runtime control envelopes reject unknown fields; explicitly dynamic business values such as Run `context`, model input items, Function Tool arguments, and JSON Schema remain open.

## Recommended project workflow

Create a business-owned integration project and declaratively apply its Provider and Agent resources:

```bash
npx omoikane init ./agent-runtime
cd ./agent-runtime
# edit omoikane.yaml and agents/assistant/AGENT.md
npx omoikane apply ./omoikane.yaml
```

`omoikane.yaml` references credentials by environment-variable name and never accepts a plaintext Provider key. `apply` synchronizes new Provider models by default, creates immutable Tool and Skill definitions, updates MCP configuration, validates Agents, and reuses an existing Deployment with the same `config_hash`. Its JSON result contains the exact Deployment IDs for the business system to promote through its own configuration.

If the project has custom in-process extensions, build and run the generated `runtime/server.ts` wrapper instead of the stock executable:

```ts
import { registerToolImplementation, startRuntime } from "omoikane/runtime";

registerToolImplementation("business.lookup", async (args, context) => {
  return lookupAuthorizedBusinessData(args, context);
});

await startRuntime();
```

The business application then creates a self-contained Run through the client package:

```ts
import { OmoikaneClient } from "omoikane/client";

const client = new OmoikaneClient({
  baseUrl: "http://127.0.0.1:8000",
});

const run = await client.createRun(
  {
    deployment_id: configuredDeploymentId,
    external_session_id: "business-conversation-42",
    conversation: previousModelItems,
    input: "Continue the analysis.",
    context: { business_object_id: "company-42" },
  },
  {
    // Stable across every retry of this business operation.
    idempotencyKey: "message:business-conversation-42:8841",
  },
);

for await (const event of client.streamRun(String(run.id))) {
  console.log(event.type, event.data);
}

const completed = await client.getRun(String(run.id));
saveToBusinessStore(completed.output, completed.new_items);
```

`external_session_id` is correlation metadata only. Omoikane never loads prior messages from it.

### Reasoning models

Reasoning is capability-driven rather than assumed from a Provider protocol. Each
Provider Model reports whether reasoning is available, how it is activated,
whether the model accepts an Effort, Token-budget, or Summary control, and what
kind of output is observable. Configure only controls advertised by that model:

```yaml
model_settings:
  reasoning_enabled: true
  reasoning_effort: high
  reasoning_summary: auto
```

Omoikane translates these generic settings to the selected Provider's request
shape. Public summaries are emitted as `model.reasoning_summary_*` Events.
Provider-visible private traces produce content-free
`model.reasoning_metadata_*` Events; their text is not part of the public
Runtime contract. See the [reasoning capability matrix](docs/PROVIDERS.md#reasoning)
for model-specific controls and output behavior.

## Capability summary

| Area       | Current capability                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Runtime    | durable queue, leases, retry/cancel, restart recovery, paged Run listing, ordered Events, bounded REST/SSE                         |
| Agents     | immutable `AGENT.md`/JSON Deployments, model settings, Handoffs                                                                    |
| Providers  | built-in catalog, model sync/capabilities, qualified complete-input Token counting, MiMo V2.5 ASR/TTS adapters                     |
| Tools      | Function Tools; Runtime-managed MCP Tools with OAuth, policy, snapshots, approvals, reconciliation, and model-free read invocation |
| Skills     | immutable bundles, explicit version binding, checksum verification, instruction injection                                          |
| Context    | caller-supplied conversation; native/portable temporary Projection; no Session or memory store                                     |
| Output     | validated structured output; public reasoning summaries; content-free Raw CoT metadata; typed Input/Output Guardrails              |
| Execution  | Function Tools and MCP Tools; paged, checksummed, quota-bounded temporary Run Artifacts; no supported built-in Sandbox             |
| Operations | PGlite snapshot/restore/safe upgrade, optional PostgreSQL, Usage, Runtime status, metadata-only SDK tracing                        |

The MCP product contract covers Runtime-managed Tools, including generic OAuth discovery, public/confidential/URL-based OAuth clients, browser authorization, encrypted token refresh, disconnect for remote HTTP servers, and generic write-scope protection. Resources, Prompts, Elicitation, and Provider-hosted MCP remain outside the current boundary.

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
