# 运行、API 与部署手册

> 文档类型：现行运维与接入手册
> 状态：现行
> 最后核对：2026-08-26
> 适用版本：AgentSDK `0.1.0`、`openai-agents==0.22.0`、数据库迁移 `0006`

## 1. 运行模式

项目提供两个命令入口：

- `agent-system`：FastAPI 控制面和 REST/SSE 服务；当前默认同时内嵌一个 Worker。
- `agent-worker`：额外的独立 Worker，从数据库领取 Run、续租并执行 Agents SDK Runner。

因此本地只启动 `agent-system` 就能完成 Run；启动 `agent-worker` 会增加一个并发消费者。Compose 当前同时运行 API 内嵌 Worker 和独立 Worker。它们依靠数据库租约安全领取任务，但如果部署要求 API 进程完全不执行模型或工具，需要先实现显式关闭内嵌 Worker 的配置，不能仅凭进程名称假设已经严格分离。

PostgreSQL 是生产事实来源，Redis 只做事件通知，SSE 总能从 `run_events` 重放。

### 1.1 最小本地启动

```bash
uv sync --extra dev
cp .env.example .env
uv run alembic upgrade head
uv run agent-system
```

服务默认监听 `http://127.0.0.1:8000`：

```bash
curl http://127.0.0.1:8000/healthz
```

交互式 OpenAPI 位于 `/docs`，机器可读合同位于 `/openapi.json`。本地需要更多 Run 消费能力时再执行 `uv run agent-worker`。

### 1.2 推荐业务接入顺序

1. 创建 ProviderConnection 并同步模型。
2. 读取并更新 `/v1/agent-settings`，设置全局默认 Provider 与模型。
3. 校验 `AGENT.md`，再创建并发布 AgentVersion。
4. 创建 Session，并始终用同一个 Session ID 继续对话。
5. 创建 Run，消费 SSE；审批中断时写入决定并继续同一 Run。

Provider 请求示例和完整角色格式分别见 [Provider 注册中心](08-provider-registry.md) 与 [Agent 角色定义](11-agent-role-definitions.md)。

## 2. 配置

主要环境变量：

| 变量 | 说明 |
|---|---|
| `AGENT_ENVIRONMENT` | `development`、`test` 或 `production`；生产会启用强制配置校验 |
| `AGENT_HOST` / `AGENT_PORT` | API 监听地址与端口；默认 `127.0.0.1:8000` |
| `AGENT_DATABASE_URL` | SQLAlchemy async URL；生产必须是 PostgreSQL |
| `AGENT_REDIS_URL` | Redis 通知地址；为空时使用进程内通知 |
| `AGENT_AUTO_CREATE_SCHEMA` | 开发可为 `true`；生产必须为 `false` 并用 Alembic |
| `AGENT_RUN_STATE_SECRET` | 审批暂停状态的加密密钥；生产必须替换 |
| `AGENT_WORKER_POLL_SECONDS` | Worker 无任务时轮询间隔 |
| `AGENT_RUN_LEASE_SECONDS` | Run 执行租约时长，必须覆盖正常续租周期 |
| `AGENT_SSE_HEARTBEAT_SECONDS` | SSE 心跳间隔 |
| `AGENT_MAX_EVENT_PAYLOAD_BYTES` | 单个持久化事件 Payload 上限 |
| `AGENT_DEFAULT_DAILY_BUDGET_USD` | 没有租户专用配置时的每日成本上限；空值表示不设 |
| `AGENT_DEFAULT_APPROVAL_TIMEOUT_SECONDS` | 审批默认过期时间 |
| `AGENT_TRACING_DISABLED` | 是否关闭 Agents SDK Tracing |
| `AGENT_ARTIFACT_BACKEND` | `local` 或 `s3` |
| `AGENT_ARTIFACT_ROOT` | Local Artifact 根目录 |
| `AGENT_SKILL_ROOT` | 已导入 Skill Bundle 根目录 |
| `AGENT_SANDBOX_ROOT` | Worker 可见的 Sandbox 工作目录 |
| `AGENT_SANDBOX_HOST_ROOT` | Worker 在 Docker 内控制宿主 Docker 时的宿主机对应路径 |
| `AGENT_S3_BUCKET` | S3/MinIO Bucket；S3 Backend 必填 |
| `AGENT_S3_ENDPOINT_URL` | 自建 S3/MinIO Endpoint；AWS S3 可为空 |
| `AGENT_S3_REGION` | S3 Region |

S3 凭据使用 boto3 支持的标准 AWS 环境变量或运行身份，不增加一套 AgentSDK 专用密钥字段。Provider 的 `api_key_env` 可以引用任意合法环境变量名，不要求 `AGENT_` 前缀。

AgentVersion 不保存模型凭据、URL 或协议，只引用 ProviderConnection 和 ProviderModel，例如：

```json
{
  "provider_connection_id": "provider-connection-uuid",
  "provider_model_id": "provider-model-uuid",
  "instructions": "Answer accurately.",
  "provider_options": {
    "structured_output_mode": "prompt"
  }
}
```

通过 `POST /v1/provider-connections` 一次性提交 `api_key` 时，SDK 加密后存储且响应只返回尾部提示；也可提交 `api_key_env` 引用环境变量。内置厂商的 URL 和协议不可覆盖，只有 `custom_openai_compatible` 接受 `custom_base_url` 与协议。完整接口和厂商清单见 [Provider 注册中心](08-provider-registry.md)。

结构化输出有两种模式：`native` 把 Pydantic/JSON Schema 交给 Agents SDK 和 Provider；`prompt` 要求模型只返回 JSON，再由平台解析并使用原始 JSON Schema 强校验。兼容 Provider 不支持原生 JSON Schema 时使用后者，非法 JSON 仍会使 Run 失败，不会被当作成功结果。

## 3. 数据库迁移

```bash
AGENT_DATABASE_URL='postgresql+asyncpg://...' uv run alembic upgrade head
```

初始迁移创建完整领域表，并在 PostgreSQL 上启用 `vector` 扩展。生产启动时不会调用 `create_all`。迁移合同测试会从空 SQLite 数据库执行 `upgrade head` 和 `downgrade base`；Compose 使用 pgvector PostgreSQL 16 镜像。

当前迁移 head 是 `0006`。早期开发库可能由 `create_all` 建表却没有 Alembic revision；这类库直接执行 `upgrade head` 会在已有表上冲突。必须先核对实际表结构对应到哪个迁移，再 `alembic stamp <revision>`，随后执行 `upgrade head`。生产库禁止未核对结构就 stamp。

## 4. REST 工作流

所有业务接口使用 `/v1`。开发身份来自 `X-Tenant-ID`、`X-Actor-ID` 请求头，默认值仅适合受信环境。

完整路由、请求 Schema 和响应 Schema 以运行时 `/openapi.json` 为唯一 API 清单；本手册只维护主工作流，避免复制全部路由后产生漂移。

推荐的角色文档工作流：

1. `GET/PUT /v1/agent-settings` 配置全局 Instructions、默认 Provider/模型和平台策略。
2. `POST /v1/agent-definitions/validate` 预览 `AGENT.md` 的完整有效配置。
3. `POST /v1/agents/from-definition` 创建逻辑 Agent 和 v1。
4. `POST /v1/agents/{id}/versions/from-definition` 从更新后的角色文档创建后续版本。
5. `GET /v1/agents/{id}/versions/{version}/definition` 恢复源文档和编译快照。

兼容的底层 JSON 工作流：

1. `POST /v1/agents` 创建逻辑 Agent。
2. `POST /v1/agents/{id}/versions` 创建不可变配置版本。
3. `POST /v1/agents/{id}/versions/{version}/publish` 校验并发布。
4. 可选 `POST /v1/sessions` 创建持久会话；后续 Run 始终复用返回的 Session ID。
5. `POST /v1/runs` 返回 `202`；`Idempotency-Key` 防止重复创建。
6. `GET /v1/runs/{id}/stream` 接收 SSE；重连时发送 `Last-Event-ID`。
7. 若进入 `waiting_approval`，查询 `/v1/approvals` 并 approve/reject。

Run 状态与对应 SSE 事件在同一数据库事务写入，`run_events` 同时作为 Transactional Outbox；序号对单个 Run 严格递增。事务提交后 Dispatcher 才通知 Redis，失败不会回滚业务状态，事件保留为 pending 并按退避策略重试。SSE 始终先从 PostgreSQL 补读，因此 Redis 短时不可用不会丢事件。终态事件后流自然结束。

## 5. Agent、Tool、MCP 与编排

AgentVersion 可绑定：

- `tool`：部署代码注册的 Function Tool，支持 JSON Schema、输入/输出大小、超时、有限重试、并发和审批策略。
- `mcp`：stdio、SSE 或 Streamable HTTP；支持 Secret 引用、允许/阻止工具名单、缓存、超时、重试和健康检查。
- `skill`：不可变 SkillVersion。
- `handoff`：把对话控制权转交另一 Agent。
- `agent_tool`：把另一 Agent 暴露为工具。

发布前会验证绑定存在、JSON Schema 合法及多 Agent 图无环且不超过深度限制。

## 6. 审批与恢复

需要审批的工具由 Agents SDK 产生 interruption。平台执行以下原子流程：

1. `RunState.to_json()` 序列化同一运行状态。
2. 使用 Fernet 加密并保存 checksum、SDK 版本和格式版本。
3. Run 进入 `waiting_approval` 并释放 Worker 租约。
4. 审批 API 写入决定并将 Run 重新排队。
5. 任意 Worker 用 `RunState.from_json()` 恢复，并对原 interruption approve/reject。

审批有过期时间；Reaper 会将过期审批和 Run 标记为 `expired`/`failed`。审批参数不会在决定时被静默修改。

有副作用的 Function Tool 还会写入 `tool_executions`：相同 Tool Call 完成后直接重放已保存结果；Worker 消失导致租约过期时执行变为 `unknown`，Run 变为 `waiting_reconciliation`，不得自动重试。运维方先核对下游系统，再调用 `POST /v1/tool-executions/{id}/resolve` 确认结果。旧 Run 随后以明确错误关闭，因为 SDK 不能从任意 Function Tool 的中间点安全恢复；上游根据对账结果决定是否创建新 Run。工具 Handler 应把 `ToolInvocation.idempotency_key` 原样传给支持幂等键的下游 API。

## 7. Session、长期记忆和 Compaction

- Session 保存 Agents SDK 输入/输出项，跨 Run、跨进程持久。
- 长期记忆与 Session 分表；支持 `user`、`agent`、`project`、`global` 作用域和 semantic/episodic/procedural 类型。
- Run 完成后先写候选，再经过凭据过滤、去重、置信度与来源血缘后合并。
- 检索结合哈希向量、关键词、作用域和可信度；PostgreSQL 同时保存 pgvector 列，SQLite 走 JSON 兼容路径。
- Compaction 使用不可变 Canonical Transcript 和独立 Active Projection；原消息不因压缩而修改或设为 inactive。
- 触发依据是显式 Context Window、Tokenizer、输出/Tool Loop/Safety 预留、Token 高低水位和下一次 Provider 的真实 input usage，不使用字符阈值。
- Capability 合同确认支持时使用 Native Responses Compaction Item；其他 Provider 使用受 JSON Schema 约束的 Portable Summary、近期原文和原子 Tool Pair。
- 摘要失败、Token 降幅不足、Identifier 丢失、Lease/CAS 冲突均为 Hard No-op。长期记忆只作为 Request-only Segment 注入，不参与摘要和压缩事务。

管理接口包括：

```text
POST /v1/sessions/{id}/compact
GET  /v1/sessions/{id}/compactions
GET  /v1/sessions/{id}/compactions/{compaction_id}
POST /v1/sessions/{id}/compactions/{compaction_id}/restore
GET  /v1/sessions/{id}/context-preview
GET  /v1/sessions
GET  /v1/sessions/{id}/chat-messages
```

记忆 API 支持创建、查询、修改、禁用和删除语义；包含类似 API Key/Token 的内容会被拒绝。

## 8. Skills、Sandbox 与 Artifact

Skill 目录格式：

```text
skill-name/
├── SKILL.md
├── scripts/
├── references/
└── assets/
```

Importer 验证 YAML Front Matter、路径、符号链接、单文件/总大小和危险脚本模式，生成文件清单与 SHA-256。运行时只物化绑定版本，模型先看到目录，需要时调用 `read_skill` 获取正文。

生产 Docker Sandbox 使用非 root 用户、只读根文件系统、`no-new-privileges`、CPU/内存/PID/时限和默认断网策略。Local Sandbox 只允许非生产环境。Docker socket 等同高权限控制面，生产部署应把 Worker 放在独立节点，并限制谁能修改 Agent/Tool 配置。

Artifact 支持本地和 S3/MinIO，保存 MIME、大小、SHA-256、Run 和血缘。下载会复核 checksum；删除采用数据库 tombstone 后清理对象；过期对象可由 `cleanup_expired` 回收。

## 9. 用量、成本和可观测性

SDK RunHooks 为 Agent、模型、工具与 Handoff 记录关联事件；Run 保存 trace ID，SDK Tracing 可按配置启用。每次运行写入原始 Usage、版本化价格和不可变 Cost 记录。

平台限制包括最大 turns、运行时长、工具调用、Handoff、并发、单 Run 成本和租户每日预算。成本检查会在下一次模型调用前阻止继续执行；首次请求的实际 Token 只能在 Provider 返回 Usage 后记账。

## 10. 测试

```bash
UV_CACHE_DIR=/private/tmp/agentsdk-uv-cache uv lock --check
uv run ruff check .
uv run pytest -q
uv run python scripts/check_docs.py
```

合同测试覆盖 Registry、不可变版本、真实 SDK 流式 Runner、结构化输出、输入 Guardrail、审批保存/恢复/过期、数据库 Session、Compaction、长期记忆、成本、SKILL.md、Local Sandbox、Artifact、REST/SSE、stdio MCP 和 Agent-as-Tool。

`scripts/sandbox_smoke.py` 额外验证 Docker Sandbox；`scripts/provider_e2e.py` 验证真实 OpenAI-compatible Provider。两者都可能访问本机 Docker 或外部网络，应在明确授权的环境执行。
