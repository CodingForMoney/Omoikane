# 范围基线与 OpenAI Agents SDK 支持矩阵

> 文档类型：现行范围规范
> 状态：现行；上游版本数据为带日期快照
> 最后核对：2026-08-26
> 适用版本：AgentSDK `0.1.0`、`openai-agents==0.22.0`、数据库迁移 `0006`

## 0. 调研版本快照

本基线核对日期为 2026-08-09。官方 GitHub Release 页面在该日期标记：

- Python SDK 最新版为 [`v0.19.4`](https://github.com/openai/openai-agents-python/releases/tag/v0.19.4)。
- JavaScript/TypeScript SDK 最新版为 [`v0.14.3`](https://github.com/openai/openai-agents-js/releases/tag/v0.14.3)。
- 两个官方源码仓库均采用 MIT License；本系统选择 Python SDK。

版本号只描述调研时点，不是对 2026-08-26 上游最新版的声明。实现仓库已在 2026-08-26 精确升级到 `openai-agents==0.22.0`，并继续通过 SDK Contract 测试控制后续升级。

## 1. 范围声明

本项目冻结的一次性交付范围包含以下 15 项能力。文档中的实现顺序仅表示技术依赖，不表示分期、删减或延后交付；每项的当前完成度以第 2 节“当前状态”为准。

支持状态定义：

- **原生**：OpenAI Agents SDK 已提供主要运行时抽象，本项目负责配置化和服务化。
- **部分**：SDK 提供底层能力，但缺少平台级持久化、治理或 API。
- **Beta**：官方已有能力，但接口或语义仍可能变化，必须通过适配层隔离。
- **自建**：不属于 SDK 的职责，必须由本项目实现。

## 2. 功能支持矩阵

“当前状态”描述代码已经提供的能力及尚未完成的验证，不把“存在一个实现”写成“生产完备”。

| # | 功能 | SDK 支持 | 本项目职责 | 当前状态 |
|---|---|---|---|---|
| 1 | Agent 定义与注册 | **部分**。模型、Instructions、Tools、Guardrails、Handoffs、MCP 和输出类型 | `AGENT.md`、全局默认、平台策略、注册、不可变版本和发布 | 已实现并有合同测试 |
| 2 | Runner 运行服务 | **部分**。Agent loop、流式运行和暂停恢复 | 队列、Worker、租约、恢复、取消、超时和并发 | 已实现；真实多进程故障注入待补 |
| 3 | Function Tools 与 MCP | **原生/部分**。Function Tools、Agents as Tools 和 MCP | 注册、策略、审批、健康检查和副作用幂等 | Function Tool 已实现；MCP 跨进程稳定 Call ID 受上游接口限制 |
| 4 | Session、Context 和流式输出 | **部分**。Session、运行 Context 和流式事件 | 数据库存储、Context 投影、SSE 落库和重放 | 已实现并有恢复测试 |
| 5 | Guardrails 与人工审批 | **原生/部分**。输入、输出、工具 Guardrails 和 HITL | 审批单、API、超时、审计和跨进程恢复 | 已实现并有暂停/恢复测试 |
| 6 | 结构化输出 | **原生**。Agent 类型化输出 | Native/Prompt Schema、平台二次校验和失败策略 | 已实现；按 Provider 选择兼容模式 |
| 7 | 数据库存储 | **自建** | Schema、迁移、事务和保留 | SQLite 合同测试完成；PostgreSQL 故障测试待补 |
| 8 | REST/SSE API | **自建** | FastAPI、错误模型、幂等、分页、SSE 重放和背压 | 主链路已实现；统一写幂等和统一游标分页未完成 |
| 9 | Tracing、用量和成本 | **部分**。Tracing 和模型用量 | Trace 关联、用量、价格、成本和预算 | 已实现基础账本与限额；未定价模型明确保持未知成本 |
| 10 | 多 Agent 编排 | **原生/部分**。Handoff、Agent as Tool 和代码编排 | 图注册、环路、深度限制、事件和失败策略 | 已实现合同和装配测试 |
| 11 | Sandbox 执行 | **部分**。官方 Sandbox 能力可作为上游选项 | Local/Docker Provider、资源和网络边界、回收和审计 | 基础执行已实现；快照/恢复、域名网络允许列表和完整文件审计未实现 |
| 12 | `SKILL.md` 技能系统 | **部分**。可与工具和 Sandbox 组合 | 导入、校验、版本、物化和权限治理 | 已实现目录导入、版本和按需读取 |
| 13 | 长期经验记忆 | **部分**。SDK Session 不等于长期经验记忆 | 跨 Session 记忆、候选、检索、作用域和防投毒 | 基础实现完成；检索质量、矛盾和污染治理仍在 Backlog |
| 14 | Context Compaction | **部分**。Responses 与 SDK 提供相关状态能力 | Token 触发、投影、双路径、审计和质量校验 | Portable 已真实验证；Native Provider replay 和生产故障测试待补 |
| 15 | Artifact 管理 | **部分**。工具和 Sandbox 能产生文件/结果 | 元数据、对象存储、校验、下载、血缘和清理 | Local/S3 基础实现完成；签名 URL 和引用保护未实现 |

结论：SDK 对 Agent 的推理、工具执行、编排、Session、Tracing、Guardrails 和可恢复审批循环支持完整度较高；注册、持久化服务、长期状态、治理和外部 API 仍主要由本项目负责。长期记忆和 Compaction 必须继续以平台数据库为事实来源，不能用实验性或 Provider 专有状态替代。

## 3. 逐项目标验收标准（非当前完成清单）

以下是完整目标，不等同于每一条都已通过生产验证。当前差距以第 2 节“当前状态”和 [架构决策与 Backlog](05-review-decisions-and-backlog.md) 为准。

### 3.1 Agent 定义与注册

- 可创建 Agent，并生成不可变 `AgentVersion`。
- 可用严格类型化的 `AGENT.md` 定义角色；未覆盖参数继承带 revision 的全局默认。
- 角色预览、编译和发布产生相同配置哈希；平台强制策略在运行时再次收紧历史版本。
- 每个版本固定模型、Instructions、模型参数、工具、MCP、技能、Guardrails、Handoffs 和输出 Schema。
- 版本状态支持 `draft`、`published`、`deprecated`；Run 只能引用明确版本。
- 发布前完成引用完整性、编排环路、输出 Schema 和安全策略校验。

### 3.2 Runner 运行服务

- REST 创建 Run 后异步执行，支持查询、取消、超时和幂等重试。
- Worker 崩溃后，过期租约可被其他 Worker 接管。
- 审批中断后，进程重启仍可恢复同一 Run。
- 每个 Run 固定 Agent 版本、SDK 版本和运行策略快照。

### 3.3 Function Tools 与 MCP

- 支持代码内 Function Tool、Agent as Tool，以及 MCP 的受支持连接方式。
- 每个工具均可设置超时、重试、并发、审批、输入/输出限制和密钥引用。
- MCP Server 支持健康检查、工具过滤、允许列表和调用审计。
- 工具异常被标准化为可观察、可重试或终止的结果。

### 3.4 Session、Context 和流式输出

- Session 和消息跨进程持久化；同一 Session 可连续运行多个 Run。
- 应用 Context 与模型可见 Context 分离，敏感对象不会被自动序列化给模型。
- SSE 事件先落库再发布，客户端可用 `Last-Event-ID` 继续读取。
- 最终结果与 SSE `run.completed` 的输出一致。

### 3.5 Guardrails 与人工审批

- 支持输入、输出和工具级 Guardrail。
- 高风险工具调用进入 `waiting_approval`，返回参数摘要和风险说明。
- 审批支持允许、驳回、超时；决定人、时间、理由全量审计。
- 重复审批请求和重复提交审批结果均幂等。

### 3.6 结构化输出

- Agent Version 绑定版本化 JSON Schema 或代码内 Pydantic 类型。
- SDK 输出完成后再次进行平台边界校验。
- 校验失败可按策略执行一次修复重试或直接失败，不能把非法结构标记为成功。

### 3.7 数据库存储

- PostgreSQL 保存所有核心实体、状态迁移和审计事件。
- 数据库迁移可从空库执行，也可向前升级已有库。
- 不在数据库中保存大文件正文；Artifact 仅保存元数据和对象存储引用。

### 3.8 REST/SSE API

- 所有资源使用 `/v1` 版本前缀和统一错误格式。
- 写操作支持 `Idempotency-Key`；列表接口使用游标分页。
- SSE 支持心跳、重连、事件重放和慢消费者断开策略。

### 3.9 Tracing、用量和基础成本控制

- Run、Agent、模型请求、工具和 Handoff 可关联到同一 Trace。
- 保存输入/输出/推理/缓存 Token 等 SDK 可提供的用量维度。
- 价格表带生效日期和版本，历史成本不会因新价格而重算。
- 支持单 Run 上限、并发上限、每日预算和超限前停止下一次模型调用。

### 3.10 多 Agent 编排

- 支持 Handoff 和 Agent as Tool 两种主模式。
- 发布前校验不存在不允许的环路，并限制最大深度、最大 Agent 次数和并发数。
- 子 Agent 继承 Trace，但拥有独立 Span、用量和错误信息。

### 3.11 Sandbox 执行

- Sandbox 具有 CPU、内存、磁盘、进程数、执行时长和网络策略。
- Run 可创建、恢复和回收 Sandbox；异常退出也有后台清理。
- 所有命令、文件变化、网络例外和导出 Artifact 均可审计。
- 生产环境不允许退化为无隔离的宿主机 Shell。

### 3.12 `SKILL.md` 技能系统

- 可从规范目录发现 `SKILL.md`，解析元数据并生成内容哈希。
- 技能采用不可变版本，可绑定 Agent Version，并在运行前物化到 Sandbox。
- 缺失依赖、非法 Front Matter、路径逃逸或安全扫描失败时禁止发布。
- 模型按需读取技能正文和资源，避免把全部技能一次性塞入 Prompt。

### 3.13 长期经验记忆

- 支持用户、Agent、项目和全局四种作用域；Session 消息不等同于长期记忆。
- Run 结束后先生成记忆候选，再执行脱敏、去重、可信度评估和合并。
- 检索结合向量、关键词、时间和作用域；当前用户输入优先于历史记忆。
- 支持查看、修正、禁用、过期和删除记忆，并记录来源血缘。

### 3.14 Context Compaction

- 根据 Token 水位自动触发，也支持手工触发。
- 压缩前后的消息边界、摘要、保留项和 Token 变化可审计。
- 活动工具调用、未决审批、系统约束和最近用户消息不能丢失。
- 压缩后 Run 可继续，下一轮输出通过一致性测试。

### 3.15 Artifact 管理

- 支持上传、Sandbox 导出、工具产生和 Agent 生成四种来源。
- 元数据包含 MIME、大小、SHA-256、存储位置、Run、产生者和血缘。
- 下载通过短期授权 URL 或 API 流式返回；对象不可被路径穿越访问。
- 支持保留期限、引用保护、孤儿清理和删除审计。

## 4. 本次明确不包含

- 面向生产运维的完整 Web 管理后台；当前 Demo 只是功能验证控制台。
- 身份认证、RBAC 和多租户计费系统；本服务只供受信的上游业务 Agent 平台调用，领域表和 Request Context 中的 `tenant_id`、`actor_id` 只是业务元数据。
- 定时任务/工作流编排产品、插件市场、语音 Agent。
- 跨 Provider 的自动路由、健康故障转移和质量/成本择优；当前支持显式选择多个内置 Provider 和自定义兼容连接。

这些能力不是 15 项功能的隐性组成部分。若未来直接服务非受信用户，应作为新的产品范围重新设计安全边界。

## 5. 官方依据

- [OpenAI Agents SDK 总览](https://developers.openai.com/api/docs/guides/agents)
- [Agent 定义](https://developers.openai.com/api/docs/guides/agents/define-agents)
- [Agent 运行与流式输出](https://developers.openai.com/api/docs/guides/agents/running-agents)
- [多 Agent 编排](https://developers.openai.com/api/docs/guides/agents/orchestration)
- [Guardrails 与审批](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)
- [Sandbox](https://developers.openai.com/api/docs/guides/agents/sandboxes)
- [Tracing 集成](https://developers.openai.com/api/docs/guides/agents/integrations-observability)
- [Skills 示例与定义](https://developers.openai.com/cookbook/examples/skills_in_api#what-is-a-skill)

> 注：官方 SDK 和 Beta 能力仍在演进。开始实现时必须固定 SDK 版本；升级只能通过 adapter 合同测试和迁移测试后进行。
