# Omoikane

Omoikane 是一个完全使用 TypeScript 实现、通过 npm 分发的持久化 Agent Runtime。它基于 OpenAI Agents SDK TypeScript，把 Agent loop、Tools、MCP、Handoff、Guardrails、结构化输出和 Streaming 变成可供多个业务平台复用的独立服务。

当前源码包版本：Omoikane `0.0.2`；`@openai/agents` `0.17.0`；Node.js 22+；REST/Event Schema v1；数据库迁移 `0001`。文档描述当前仓库源码；同版本号的已发布 npm tarball 不一定包含尚未发布的仓库修复和测试。

## 能力

- `AGENT.md` 角色定义、全局默认、平台策略、不可变 Agent Version；
- 持久化 Runner、Worker lease、取消、超时、人工审批与加密 RunState 恢复；
- Function Tools、MCP stdio/SSE/Streamable HTTP、多 Agent handoff；
- PostgreSQL 或开发用 PGlite Session、原始聊天记录、REST/SSE 事件重放；
- Provider 注册、密钥加密/环境变量引用、模型同步、已知上下文和 Reasoning Effort 能力；
- `SKILL.md` Bundle、长期经验记忆、可逆 Context Compaction；
- Local/Docker Sandbox、Local/S3 Artifact、Usage/Price/Cost、HMAC Webhook；
- Project Release/Channel 和随 npm 包提供的 TypeScript Client。

准确的完成度与边界见[架构与能力矩阵](docs/ARCHITECTURE.md)，尚未完成的生产工作见[生产就绪清单](docs/PRODUCTION_READINESS.md)。尤其需要注意：开发环境的 Local Sandbox 不是安全隔离；当前记忆检索是基础实现；Portable Compaction 已实现，Provider 原生 Compaction 尚未接入；Redis 目前不是事件事实来源。

## 快速开始

```bash
nvm use
npm ci
cp .env.example .env
npm run dev
```

默认地址为 `http://127.0.0.1:8000`。开发默认使用 PGlite、本地 Artifact 和内嵌 Worker。若将 API 与 Worker 分开：

```bash
npm run build
AGENT_EMBEDDED_WORKER=false npm start
npm run worker
npm run webhook-worker
```

生产部署使用：

```bash
export AGENT_RUN_STATE_SECRET='replace-with-a-long-random-secret'
docker compose up --build
```

## npm 使用

安装 Runtime 和 Client：

```bash
npm install omoikane
```

使用轻量 HTTP/SSE Client：

```ts
import { OmoikaneClient } from "omoikane/client";

const client = new OmoikaneClient({
  baseUrl: "http://127.0.0.1:8000",
  tenantId: "investment-platform",
});

await client.handshake();
const session = await client.createSession();
const run = await client.createRun({
  agent_version_id: process.env.OMOIKANE_AGENT_VERSION_ID!,
  session_id: String(session.id),
  input: "Analyze this company.",
});

for await (const event of client.streamRun(String(run.id))) {
  console.log(event.type, event.data);
}
```

在 Runtime 进程内注册受控 Function Tool：

```ts
import { registerToolImplementation } from "omoikane";

registerToolImplementation("business.lookup", async ({ id }, context) => {
  return { id, tenant: context.tenant_id };
});
```

业务项目不应访问 Omoikane 数据库，也不应依赖内部模块；稳定边界是 REST/SSE 与 `omoikane/client`。

## Agent 定义

```md
---
apiVersion: agentsdk/v1
kind: Agent
metadata:
  slug: analyst
  name: Investment Analyst
  description: Produces evidence-based investment analysis.
spec:
  provider:
    connection_id: replace-with-provider-connection-id
  model: mimo-v2.5
  model_settings:
    reasoning_effort: high
    max_tokens: 8192
  tools: []
  skills: []
  memory:
    enabled: true
  compaction:
    enabled: true
---

You are an investment analyst. Separate facts, assumptions, and conclusions.
```

Provider 必须先创建；Agent Version 只引用连接和模型，不保存 API Key。已知模型会带出默认上下文窗口，用户仍可在 Agent 中用 `model_context_window` 覆盖。

## CLI

```bash
npx omoikane init ./my-agent-project
npx omoikane validate ./my-agent-project/agents/assistant/AGENT.md
npx omoikane deploy-agent ./my-agent-project/agents/assistant/AGENT.md
npx omoikane provider-add --name MiMo --provider xiaomi_mimo --api-key-env MIMO_API_KEY
npx omoikane run --agent-version <id> --input "Hello"
```

## 验证

```bash
npm run check
npm test
npm run check:docs
npm run build
npm pack --dry-run
```

外部依赖测试是显式选择的：

```bash
npm run test:mimo
npm run test:e2e:mimo
npm run test:e2e:compaction-100k
npm run test:sandbox
```

测试不会回显 Provider Key。`test:mimo` 是单次 Runtime smoke test；`test:e2e:mimo` 使用真实 REST、SSE 和 Worker，覆盖 Provider/模型同步、AGENT.md、SKILL.md、Function Tool、MCP、Session 恢复、长期记忆、独立 Context Compaction、Usage 和 Artifact；`test:e2e:compaction-100k` 是显式选择的高成本基准，验证超过 100K 估算 tokens 的多分块压缩、三段事实保留、Canonical hash、低水位、压缩率和后续对话。普通对话测试使用 1024 Token 输出上限，Compaction checkpoint 使用 4096 Token 上限，不会用极小生成预算制造假失败。真实 E2E 只读取被 Git 忽略的 `.env` 或进程环境中的 `MIMO_API_KEY`，普通 `npm test` 始终排除 `test/e2e`。

## 文档

- [端到端开发者手册](docs/DEVELOPER_GUIDE.md)：安装、配置、API、测试、发布与排错；
- [架构与能力边界](docs/ARCHITECTURE.md)：能力矩阵、组件、Agent 定义、数据一致性、多项目接入和部署；
- [Provider、模型与上下文目录](docs/PROVIDERS.md)：协议、模型同步、Reasoning Effort、上下文默认值和 Secret；
- [Context Compaction](docs/CONTEXT_COMPACTION.md)：Canonical Transcript、Projection、压缩、恢复和验证；
- [生产就绪清单](docs/PRODUCTION_READINESS.md)：尚未完成的功能、验证和生产放行条件。

README 是文档入口，不再维护单独的索引或按日期追加的进度日志。仓库内的 `AGENT.md` 和 `SKILL.md` 是可执行定义示例，不计入正式文档。

OpenAI Agents SDK 本身开源并使用 MIT License；Omoikane 同样使用 MIT License。上游 TypeScript SDK 文档见 [OpenAI Agents SDK](https://developers.openai.com/api/docs/guides/agents)。
