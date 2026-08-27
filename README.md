# Omoikane

Omoikane 是基于 OpenAI Agents SDK 构建的可持久化、可扩展 Agent 运行平台。

本项目不是对 SDK 的简单二次封装。OpenAI Agents SDK 负责 Agent 循环、工具调用、MCP、Handoff、Guardrails、结构化输出、流式事件和 Tracing 等运行时能力；本项目补齐注册中心、持久化运行服务、REST/SSE、长期经验记忆、技能治理、上下文压缩、Artifact、成本控制和 Local/Docker Sandbox 等平台能力。

## 文档

- [文档总索引与推荐阅读顺序](docs/INDEX.md)
- [运行、API 与部署手册](docs/03-operations.md)
- [Agent 角色定义、全局默认与平台策略](docs/11-agent-role-definitions.md)
- [Provider 注册中心与模型目录](docs/08-provider-registry.md)
- [范围基线与 SDK 支持矩阵](docs/01-scope.md)

设计、决策、验收报告和 100K Context 实验均从文档总索引进入。带日期的验收报告是历史快照，不代表当前代码的动态状态。

## 已实现能力

最初冻结的 15 项范围都已有可运行实现：`AGENT.md` 风格角色定义、全局默认与运行时平台策略、Agent 不可变版本与发布、持久化 Runner、Function Tools/MCP、数据库 Session/Context/SSE、Guardrails/跨进程审批恢复、动态结构化输出、PostgreSQL/Alembic、REST API、Tracing/用量/成本限额、Handoff/Agent-as-Tool、Docker Sandbox、`SKILL.md`、长期经验记忆、可审计 Compaction，以及本地/S3 Artifact 管理。

“已有实现”不等于“全部生产验收完成”。统一写幂等/游标分页、Sandbox 快照与域名网络策略、长期记忆质量治理、Native Compaction 真实 Provider replay，以及 PostgreSQL/Redis/S3 多进程故障注入仍有缺口；准确状态见 [范围矩阵](docs/01-scope.md) 和 [Backlog](docs/05-review-decisions-and-backlog.md)。

关键实现不是模拟封装：运行、流式事件、工具、MCP、多 Agent、Guardrails、结构化输出和审批中断/恢复均经过真实 `openai-agents==0.22.0` Runner。离线测试模型只允许在 `environment=test` 下使用。

Session ID 是业务对话的唯一标识。Omoikane 在数据库保存 Canonical Transcript，并提供 Session 列表、底层 Items 视图和标准化 Chat Messages 视图；前端只需保存当前选中的 Session ID，不应另行持久化聊天正文。

## 快速开始

```bash
uv sync --extra dev
cp .env.example .env
uv run agent-system
```

`agent-system` 当前会内嵌一个 Worker，已经可以执行 Run。需要额外并发 Worker 时，再在另一个终端启动：

```bash
uv run agent-worker
```

开发环境默认使用 SQLite、本地 Artifact 和受信 Local Sandbox。生产环境必须执行 Alembic 迁移，并使用 PostgreSQL、S3/MinIO、Redis 与 Docker Sandbox：

```bash
export AGENT_RUN_STATE_SECRET='至少32字节的随机秘密'
docker compose up --build
```

API 文档启动后位于 `http://127.0.0.1:8000/docs`。本服务只面向受信的上游业务 Agent 平台，不实现身份认证与 RBAC；`tenant_id`/`actor_id` 仅作为业务元数据和审计线索。

## 验证

```bash
uv run ruff check .
uv run pytest -q
uv run python scripts/check_docs.py
uv run python scripts/sandbox_smoke.py
uv run python scripts/provider_e2e.py
```

Provider 脚本通过无回显提示读取 API Key。正式 REST API 支持一次性提交 Key（使用平台密钥派生的 Fernet 密钥加密）或引用环境变量；AgentVersion 只保存 `provider_connection_id` 与 `provider_model_id`，不会保存凭据、URL 或协议。普通 Agent Run 没有设置 `max_tokens`、`max_output_tokens` 或 `max_completion_tokens`；`max_turns` 只是 Agent 循环次数上限，不是生成 Token 上限。结构化 Compaction Summary 单独设置 4096 Token 输出预算，避免 Schema 被截断。

本地开发可把 Provider 凭据写入被 Git 忽略的 `.env`，再让 ProviderConnection 引用对应环境变量。服务启动时会把 `.env` 中的 Provider 凭据加载到进程环境；操作系统、容器或服务管理器已提供的同名环境变量始终优先，不会被 `.env` 覆盖。生产环境仍应优先使用 Secret Manager 或容器 Secret。

## 已确定的核心决策

- 一次性完成已确认的 15 项功能，不把范围拆成多个阶段。
- 主语言采用 Python 3.12，使用 OpenAI Agents SDK Python 版和 FastAPI。
- PostgreSQL 是业务状态的唯一事实来源，pgvector 用于长期记忆检索。
- Redis 用于运行通知、SSE 实时扇出、分布式互斥和短期缓存，不作为持久化事实来源。
- Run 状态与对应事件在同一数据库事务提交；`run_events` 兼任 Transactional Outbox，Redis 通知失败可重试。
- Artifact 存入 S3 兼容对象存储；开发环境可使用本地文件适配器。
- Sandbox 通过统一接口接入；生产默认 Docker 隔离，开发可选受限本地实现。
- 有副作用的 Function Tool 使用持久化执行账本、稳定幂等键和结果重放；不确定结果禁止自动重试。
- SDK 的 Beta 能力全部封装在 adapter 内，并在运行状态中记录 SDK 版本和状态格式版本。
- REST/SSE 是本次交付界面；Web 管理后台不在当前范围内。

## OpenAI Agents SDK 定位

OpenAI Agents SDK 是开源项目，可查看 [Python 源码](https://github.com/openai/openai-agents-python) 和 [TypeScript 源码](https://github.com/openai/openai-agents-js)。本项目选用 Python 版，并在依赖锁文件中固定实际验收过的版本，不直接追随浮动的最新版。

2026-08-09 的调研快照记录 Python `v0.19.4` 和 JS/TS `v0.14.3`；这不是对上游“当前最新版”的动态声明。本项目已于 2026-08-26 升级并固定为 `openai-agents==0.22.0`，升级前后均通过相同的 SDK 合同、迁移和 Provider 测试。

官方参考：

- [Agents SDK 总览](https://developers.openai.com/api/docs/guides/agents)
- [定义 Agent](https://developers.openai.com/api/docs/guides/agents/define-agents)
- [运行 Agent](https://developers.openai.com/api/docs/guides/agents/running-agents)
- [多 Agent 编排](https://developers.openai.com/api/docs/guides/agents/orchestration)
- [Guardrails 与审批](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)
- [Sandbox](https://developers.openai.com/api/docs/guides/agents/sandboxes)
- [Tracing](https://developers.openai.com/api/docs/guides/agents/integrations-observability)

## 当前状态

v0.1.0 的工程实现和本地合同验证已完成，但不等同于完整生产故障验证。依赖由 `uv.lock` 精确锁定；数据库迁移当前到 `0006`。Context Compaction 已采用不可变 Transcript + Active Projection、Token 水位、Native/Portable 双路径、租约/CAS 和结构化校验，并通过 MiMo v2.5 真实连续性测试；Provider 注册中心支持内置厂商、加密连接、模型同步和能力映射；Agent 定义支持 `AGENT.md`、全局默认和运行时平台策略。长期记忆质量和真实 PostgreSQL/Redis/S3 多进程故障测试仍有缺口，详见文档索引中的 Backlog 与验收快照。
