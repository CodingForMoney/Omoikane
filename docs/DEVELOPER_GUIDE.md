# Omoikane 端到端开发者手册

> 适用版本：Omoikane `0.0.2`、Node.js 22+、`@openai/agents` `0.17.0`

本手册覆盖本地启动、Provider、Agent、Tool/MCP、Session、Run、SSE、审批、记忆、压缩、Artifact、部署、测试与 npm 使用。Omoikane 是 headless Runtime；业务前端只保存 Session ID 和业务关联，不保存另一份聊天正文。

本手册是操作入口，不重复定义架构和完成度。系统边界与能力状态见[架构文档](ARCHITECTURE.md)，Provider 目录见[Provider 文档](PROVIDERS.md)，生产前工作见[生产就绪清单](PRODUCTION_READINESS.md)。

## 1. 安装与启动

```bash
git clone git@github.com:CodingForMoney/Omoikane.git
cd Omoikane
nvm use
npm ci
cp .env.example .env
npm run dev
```

开发默认值：

- API：`127.0.0.1:8000`；
- 数据库：`pglite://./var/omoikane`；
- Artifact/Skill/Sandbox：`./var`；
- API 进程内嵌 Agent Worker 和 Webhook Worker；
- Tracing 默认关闭，避免测试意外上报。

健康与能力握手：

```bash
curl http://127.0.0.1:8000/healthz
curl http://127.0.0.1:8000/version
curl http://127.0.0.1:8000/v1/capabilities
```

独立进程运行：

```bash
npm run build
AGENT_EMBEDDED_WORKER=false npm start
npm run worker
npm run webhook-worker
```

迁移：

```bash
npm run migrate
# 已构建安装包也可运行：npx omoikane-migrate
```

生产必须使用 PostgreSQL，设置非默认的 `AGENT_RUN_STATE_SECRET`，并关闭 API 的内嵌 Worker。完整变量见 `.env.example`。

## 2. Provider 先于 Agent

Provider Connection 是独立资源。用户先选择已知 Provider，只输入 API Key 或环境变量引用；Runtime 决定 URL、协议、模型目录和能力。只有 `custom_openai_compatible` 允许自定义 URL。

```bash
curl -X POST 'http://127.0.0.1:8000/v1/provider-connections' \
  -H 'Content-Type: application/json' \
  -H 'X-Tenant-ID: demo' \
  -d '{
    "name": "MiMo Token Plan CN",
    "provider": "xiaomi_mimo",
    "endpoint_profile": "token_plan_cn",
    "api_key_env": "MIMO_API_KEY"
  }'
```

该请求默认尝试同步模型。离线配置时加 `?sync_models=false`，之后再调用：

```bash
curl -X POST \
  -H 'X-Tenant-ID: demo' \
  http://127.0.0.1:8000/v1/provider-connections/<connection-id>/validate
```

查看模型：

```bash
curl -H 'X-Tenant-ID: demo' \
  http://127.0.0.1:8000/v1/provider-connections/<connection-id>/models
```

远程 `/models` 通常只返回模型 ID。上下文窗口、输出限制、Vision、结构化输出与 Reasoning Effort 来自 Omoikane Catalog；用户可以新增模型并覆盖 capability。已知默认值不是硬限制，Agent 中可设置 `model_context_window`。

Provider Secret 的规则：

- 推荐保存 `api_key_env`，Worker 启动环境提供真实值；
- 也可一次提交 `api_key`，Runtime 使用 AES-256-GCM 加密；
- API 响应只返回 key hint，不返回密文或明文；
- `AGENT_RUN_STATE_SECRET` 同时保护 Provider、Webhook 和暂停 RunState，轮换前必须迁移存量密文。

## 3. 全局 Agent 设置

读取：

```bash
curl -H 'X-Tenant-ID: demo' http://127.0.0.1:8000/v1/agent-settings
```

更新默认与平台上限：

```bash
curl -X PUT http://127.0.0.1:8000/v1/agent-settings \
  -H 'Content-Type: application/json' \
  -H 'X-Tenant-ID: demo' \
  -H 'X-Actor-ID: platform-admin' \
  -d '{
    "global_instructions": "Follow company data-handling policy.",
    "defaults": {
      "runtime_policy": {"max_turns": 20},
      "memory": {"enabled": true, "max_retrieved_items": 8},
      "compaction": {"enabled": true, "high_watermark_ratio": 0.82}
    },
    "policy": {"max_turns": 100, "max_tool_calls": 200}
  }'
```

角色可以覆盖默认值，但不能突破平台上限。编译时会固化全局默认 revision、平台策略 revision 和 config hash，之后的全局修改不会偷偷改变已发布版本。

## 4. `AGENT.md`

```md
---
apiVersion: agentsdk/v1
kind: Agent
metadata:
  slug: investment-analyst
  name: Investment Analyst
  description: Analyzes companies using evidence.
spec:
  provider:
    connection_id: <provider-connection-id>
  model: mimo-v2.5
  model_context_window: 1048576
  model_settings:
    reasoning_effort: high
    max_tokens: 8192
  tools: []
  mcp_servers: []
  skills: []
  handoffs: []
  memory:
    enabled: true
    max_retrieved_items: 8
    write_mode: candidates
  compaction:
    enabled: true
    high_watermark_ratio: 0.82
    low_watermark_ratio: 0.55
    preserve_recent_tokens: 16000
    chunk_tokens: 32000
  sandbox:
    enabled: false
  runtime_policy:
    max_turns: 20
    max_tool_calls: 50
    max_handoffs: 20
---

You are an investment analyst.

Separate observed facts, assumptions, and conclusions. Cite the evidence used.
```

验证和发布：

```bash
npx omoikane validate ./agents/investment-analyst/AGENT.md
npx omoikane deploy-agent ./agents/investment-analyst/AGENT.md \
  --url http://127.0.0.1:8000
```

也可直接调用 `/v1/agent-definitions/validate` 和 `/v1/agents/from-definition`。Run 只能引用 `published` Agent Version。

结构化输出放在 `spec.output_schema`：

```yaml
output_schema:
  type: object
  properties:
    conclusion: {type: string}
    risks:
      type: array
      items: {type: string}
  required: [conclusion, risks]
```

Runtime 强制 object root 和 `additionalProperties: false`，SDK 负责最终 JSON 解析。

## 5. Function Tool

先在 Runtime 宿主进程注册实现：

```ts
import { registerToolImplementation } from "omoikane";

registerToolImplementation("business.account_lookup", async (args, context) => {
  const accountId = String(args.account_id);
  return {
    account_id: accountId,
    tenant_id: context.tenant_id,
    status: "active",
  };
});
```

再创建 Tool 元数据：

```bash
curl -X POST http://127.0.0.1:8000/v1/tools \
  -H 'Content-Type: application/json' \
  -H 'X-Tenant-ID: demo' \
  -d '{
    "slug": "account-lookup",
    "name": "account_lookup",
    "description": "Read a bounded account summary",
    "implementation_key": "business.account_lookup",
    "schema": {
      "type": "object",
      "properties": {"account_id": {"type": "string"}},
      "required": ["account_id"],
      "additionalProperties": false
    },
    "policy": {"requires_approval": false, "side_effecting": false}
  }'
```

Agent 的 `tools` 使用 Tool ID、slug 或 name。内置 Tool 包括 Artifact create、Memory search/create 和 Sandbox exec；有副作用的内置 Tool 默认审批。共享内置 Tool 从 `default` namespace 解析，业务同名定义优先。

Tool execution 保存稳定 idempotency key、参数哈希、状态和结果。Worker 丢失且副作用结果未知时进入 `waiting_reconciliation`，由 `/v1/tool-executions/:id/resolve` 明确处理。

## 6. MCP

注册 stdio：

```json
{
  "slug": "business-tools",
  "name": "Business Tools",
  "transport": "stdio",
  "endpoint_config": {
    "command": "node",
    "args": ["--import", "tsx", "examples/business-mcp/server.ts"]
  },
  "secret_refs": {}
}
```

HTTP MCP 可使用 `sse` 或 `streamable_http`，`endpoint_config.url` 指向服务。`secret_refs` 的值是环境变量名。健康检查会真实连接并列出工具：

```bash
curl -X POST -H 'X-Tenant-ID: demo' \
  http://127.0.0.1:8000/v1/mcp-servers/<id>/health
```

当前 Runtime 会连接 Server 暴露的工具，但 `policy.allowed_tools` 与 MCP 级审批尚未强制执行；在补齐前，业务 MCP 必须只暴露允许调用的工具，有副作用的操作必须自行实现业务幂等。

## 7. `SKILL.md`

```md
---
name: Source Review
slug: source-review
description: Evaluate source quality.
---

# Source Review

Prefer primary sources. Distinguish publication date from event date.
```

上传完整 Bundle：

```http
POST /v1/skills/bundles
{
  "files": [
    {"path": "SKILL.md", "content_base64": "..."}
  ]
}
```

Runtime 拒绝绝对路径和 `..`，限制最多 500 个文件，按内容生成 digest，保存不可变 Skill Version。Agent `skills` 引用 Skill Version ID。当前 Skill 内容会注入指令；脚本自动执行需要结合 Sandbox 与 Tool 明确实现，不因 Bundle 中存在脚本就自动运行。

## 8. Session、Run 与 SSE

TypeScript Client：

```ts
import { OmoikaneClient } from "omoikane/client";

const client = new OmoikaneClient({
  baseUrl: "http://127.0.0.1:8000",
  tenantId: "demo",
  actorId: "business-service",
});

await client.handshake();
const session = await client.createSession({ business_object_id: "company-42" });
const run = await client.createRun({
  agent_version_id: process.env.OMOIKANE_AGENT_VERSION_ID!,
  session_id: String(session.id),
  input: "Analyze the latest facts in the supplied data.",
  limits: { max_turns: 20, max_cost_usd: 2 },
});

for await (const event of client.streamRun(String(run.id))) {
  if (event.type === "model.output_delta") process.stdout.write(String(event.data.delta));
  if (event.type === "approval.required") console.log(event.data);
}

console.log(await client.getRun(String(run.id)));
console.log(await client.sessionMessages(String(session.id)));
```

`streamRun` 使用 `Last-Event-ID` 续传并按 sequence 去重。Reasoning、reasoning summary 和最终 output 是不同事件类型，前端不应把 reasoning delta 拼进 assistant 最终消息。

常见 Run 事件：

- `run.created`、`run.started`、`run.completed`、`run.failed`、`run.cancelled`；
- `agent.started`、`agent.completed`、`agent.updated`；
- `model.reasoning_delta`、`model.reasoning_summary_delta`、`model.output_delta`；
- `tool.called`、`tool.completed`、`handoff.started`；
- `approval.required`、`approval.resolved`；
- `memory.retrieved`、`memory.updated`、`context.compacted`；
- `usage.updated`、`sandbox.created`、`sandbox.destroyed`。

## 9. 审批

SSE 在 `waiting_approval` 暂停。业务系统验证用户身份后提交：

```ts
await client.decideApproval(approvalId, true, "Approved by investment reviewer");
```

审批决定把 Run 重新排队；任意 Worker 可读取加密 RunState、校验 SDK 格式、应用决定并继续。拒绝不是取消，它会把 rejected tool result 交还模型继续处理。审批超时会令 Run 失败。

## 10. 长期记忆

Memory 与 Session Transcript 不同：

- Transcript 是完整对话事实来源；
- Memory 是经过 Scope 管理、可启停的长期信息；
- Compaction Summary 不是 Memory，也不会自动 flush 到 Memory。

创建：

```bash
curl -X POST http://127.0.0.1:8000/v1/memories \
  -H 'Content-Type: application/json' \
  -H 'X-Tenant-ID: demo' \
  -d '{
    "scope_type": "global",
    "scope_id": "global",
    "kind": "semantic",
    "content": "Investment reports must state the valuation date.",
    "confidence": 0.9
  }'
```

当前检索使用确定性 hash embedding，适合验证数据流和 Scope，不应视为高质量生产语义检索。生产路线见[生产就绪清单](PRODUCTION_READINESS.md)。

## 11. Context Compaction

读取两种视图：

```text
GET /v1/sessions/:id/messages
GET /v1/sessions/:id/messages?include_compacted=true
GET /v1/sessions/:id/chat-messages
GET /v1/sessions/:id/context-preview
```

默认 messages 返回模型使用的 Active Projection；`include_compacted=true` 返回完整 Canonical Transcript。手动压缩：

```bash
curl -X POST http://127.0.0.1:8000/v1/sessions/<session-id>/compact \
  -H 'Content-Type: application/json' \
  -H 'X-Tenant-ID: demo' \
  -d '{"agent_version_id": "<id>", "force": true}'
```

API 默认不强制压缩；示例中的 `force: true` 只跳过高水位判断，不能跳过结构、压缩有效性、低水位和并发 CAS 校验。压缩会在低水位预算内保留最近内容，使用同一 Agent 的 Provider 生成结构化 checkpoint；多个局部摘要能放入预算时采用确定性无损合并，否则分层合并。原始 items 不删除，Projection 读取时校验 checksum；`pop`/`clear` 会使旧 Projection 失效，`restore` 只能重新激活仍然有效的 Compaction Projection。算法和边界见[Context Compaction 文档](CONTEXT_COMPACTION.md)。

## 12. Artifact

```ts
const artifact = await client.uploadArtifact(
  new Blob(["report content"], { type: "text/plain" }),
  "report.txt",
  runId,
);
const content = await client.downloadArtifact(String(artifact.id));
```

Artifact 保存 SHA-256、size、MIME、storage key、Run ID 和 lineage。生产推荐 S3/MinIO；大型工具结果应落 Artifact，只向模型返回 ID 和摘要。

## 13. Usage、Cost 和 Budget

Runner 从 SDK `runContext.usage` 保存 request/input/output/total tokens。通过 `/v1/prices` 为 Provider + model 登记版本化价格；`/v1/usage` 和 `/v1/costs` 可按 Run 查询。`max_cost_usd` 是 Run 级检查，`AGENT_DEFAULT_DAILY_BUDGET_USD` 是基础日预算。

当前没有价格时成本为 0，这可能误导预算判断，生产必须先补齐使用模型的价格，并计划把“未知价格”改成显式未定价状态。

## 14. Webhook

订阅：

```json
{
  "name": "business-events",
  "url": "https://internal.example/webhooks/omoikane",
  "secret": "shared-secret",
  "event_types": ["run.completed", "run.failed"],
  "max_attempts": 10
}
```

Event 和 Delivery 在同一事务创建。Webhook Worker 发送 `x-omoikane-event-id` 与 `x-omoikane-signature: sha256=...`，指数退避，超过次数进入 failed，可通过 replay API 重放。接收方仍需按 event ID 幂等。

## 15. Sandbox

开发 Local Sandbox：

- 只隔离工作目录和超时；
- 命令仍由本机用户执行；
- 不能用于运行不可信代码。

生产 Docker Sandbox：

- 非 root UID、只读 rootfs、cap drop、no-new-privileges；
- PID/CPU/内存限制；
- 默认 `--network=none`；
- 只有 `/workspace` 可写挂载。

实际测试：

```bash
npm run test:sandbox
```

Worker 需要 Docker socket 权限。Docker 降低命令影响面，但 socket 本身是高权限边界，因此 Worker 仍应独立部署、限制网络和宿主访问。

真实 MiMo 端到端回归使用独立的临时数据库和 Artifact/Skill/Sandbox 目录：

```bash
npm run test:e2e:mimo
npm run test:e2e:compaction-100k
```

这些测试从被 Git 忽略的 `.env` 或进程环境读取 `MIMO_API_KEY`，不把 Key 写入测试数据、快照或日志。`test:e2e:mimo` 经过真实 REST、SSE 和内嵌 Worker，覆盖 Provider/模型同步、AGENT.md 发布、SKILL.md、Function Tool、stdio MCP、Session 恢复、长期记忆、独立 Context Compaction、Usage 和 Artifact 下载。`test:e2e:compaction-100k` 构造超过 100K 估算 tokens 的 Session，验证多 chunk、开头/中间/结尾事实、Canonical hash、低水位、压缩率和下一轮连续性；它会产生多次真实模型调用，应按需运行。普通对话调用使用 1024 Token 输出上限；Compaction checkpoint 使用 4096 Token 上限。普通 `npm test` 通过 `vitest.config.ts` 明确排除所有 live E2E。

## 16. Project Release 与 Channel

服务端支持不可变 Release 和带 revision 的 Channel CAS：

```json
{
  "apiVersion": "omoikane.io/v1",
  "kind": "ProjectRelease",
  "project": "investment-research",
  "resources": {
    "agents": {"analyst": "<published-agent-version-id>"},
    "skills": {"source-review": "<skill-version-id>"},
    "mcpServers": {"business": "<mcp-server-id>"}
  },
  "sourceCommit": "<git-commit>"
}
```

先调用 `/v1/project-releases/validate`，再创建 Release，最后 `PUT /v1/projects/:project/channels/:channel`。回滚只把 Channel 指回历史 Release，不修改旧资源。当前 CLI 已覆盖 Agent 与 Run 常用流程；Release manifest 的完整目录扫描和批量发布仍建议由业务 CI 调用 API 实现。

## 17. npm 发布与其他项目使用

开发中的 Omoikane 与业务项目解耦：

1. Omoikane 使用 SemVer 发布 npm package 和固定 digest 镜像；
2. 业务项目依赖确定版本的 `omoikane/client`，不引用本地源码路径；
3. 业务连接稳定 Runtime URL；
4. Omoikane 开发使用独立数据库、Artifact 和 Provider 测试环境；
5. 升级先进入 `next` Runtime，再切业务的 stable channel。

发布前：

```bash
npm ci
npm run check
npm test
npm run check:docs
npm run build
npm pack --dry-run
```

正式发布由 [`.github/workflows/publish.yml`](../.github/workflows/publish.yml) 完成：

1. 首次发布前，在 npm 包设置中把 `CodingForMoney/Omoikane`、工作流 `publish.yml` 注册为 Trusted Publisher，并允许 `npm publish`；
2. 将 `package.json` 版本更新为目标 SemVer，提交并创建完全一致的 `v<version>` GitHub Release；
3. GitHub-hosted runner 使用 Node.js 24、OIDC 和 npm Trusted Publishing 发布，不需要在仓库保存长期写入 Token；
4. 工作流会验证 Release tag 与包版本一致，`prepack` 会再次执行类型检查、测试和构建。

首次占用包名或 Trusted Publisher 尚未建立时，不应由本地自动发布；先在 npm 账号中确认所有权和发布授权。

## 18. 故障排查

- `provider credential environment variable is missing`：Connection 引用的变量没有注入执行 Worker；
- `run requires a published agent version`：发布对应版本后再创建 Run；
- Effort 校验失败：模型目录声明不支持该值，应隐藏 UI 选项或改为支持值；
- Run 长期 queued：检查 Worker、Runtime Generation 与数据库连接；
- Run waiting_approval：审批是正常暂停，不是 Worker 卡死；
- Run waiting_reconciliation：副作用结果未知，不能自动重试；
- Session 恢复异常：读取 canonical messages，核对是否错误切换 Projection；
- Docker Sandbox 失败：检查 Docker daemon、socket、镜像和 host root 映射；
- npm 命令 Node 版本错误：执行 `nvm use`，要求 Node.js 22+。

## 19. 仓库示例

- `examples/business-project/`：最小业务定义仓库，包含 `omoikane.yaml`、`AGENT.md`、`SKILL.md` 和结构化输出 Schema；
- `examples/business-mcp/`：stdio MCP Server，演示有界读取视图和业务侧写操作幂等，运行命令为 `npm run example:mcp`；
- `examples/skills/source-review/`：可独立导入的 `SKILL.md` Bundle。

示例不随 npm tarball 分发，需要从源码仓库使用。先创建 Provider Connection，再替换示例中的连接和模型占位值。Provider Key、MCP Token 和业务数据库密码不得写入示例文件。

当前 Runtime 尚未强制 MCP 级 `allowed_tools` 和审批策略，因此 `create_review_request` 等写工具只能暴露在业务系统控制的审批边界之后。
