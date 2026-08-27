# 架构复核决策与遗留问题

> 文档类型：架构决策与 Backlog
> 状态：现行决策；第 7 节保留明确标记的改造前背景
> 最后核对：2026-08-26
> 适用版本：AgentSDK `0.1.0`、`openai-agents==0.22.0`、数据库迁移 `0006`

本文记录已经接受的架构决策、当前边界和验证 Backlog。当本文与现行规范不一致时，以实际代码、迁移、OpenAPI 和 [文档索引](INDEX.md) 标记的现行规范为准。

## 1. 身份认证：明确不做

本系统定位为被上游业务 Agent 平台调用的内部 SDK/运行服务，不直接承载终端多用户，因此不实现登录、令牌签发、RBAC 或用户目录。

- `tenant_id`、`actor_id` 只是上游传入的业务元数据和审计线索，不构成身份认证。
- 部署边界默认是受信服务网络；若未来把 REST API 直接暴露给非受信调用方，认证属于新的范围变更。
- 当前 Header 不应在文档或 UI 中被描述为安全边界。

## 2. 脱敏：不做效果不可验证的通用脱敏

当前系统没有高质量的通用语义脱敏能力，也不应声称具备。现有代码只做两类确定性控制：拒绝在 Provider/MCP 配置中内联保存常见凭据字段，以及拒绝把明显类似 API Key/Token 的内容写入长期记忆。这不是完整的 PII/商业敏感信息脱敏。

正则、关键词和通用 NER 无法可靠理解每个工具参数的业务语义：漏报会形成虚假的安全感，误报会破坏审批判断和工具参数。因此本版本不增加启发式“全局自动脱敏”。

如果未来确实需要，唯一建议的实现是结构化、工具作者负责的机制：

- 在 Tool JSON Schema 或 Policy 中声明 `sensitive_paths`/`x-sensitive`。
- 审批展示层只对这些路径做确定性替换，并保留值的类型、长度或 Hash 供核对。
- 对复杂业务参数由工具注册时提供专用 `approval_renderer`，生成可审查的业务摘要。
- 未声明的字段不假装已经脱敏；是否允许保存原参数由上游平台决定。

当前 Approval 的 `request_json` 仍可能包含原始工具参数，这是已知事实，不列为本轮自动修复项。

## 3. 状态与事件原子性：已实现

`run_events` 现在同时充当有序事件日志和 Transactional Outbox。Run 状态转换与对应事件由 `append_in_transaction` 在同一个数据库事务内写入：

- 创建/领取：`queued + run.created`、`running + run.started`。
- 取消：`cancel_requested + run.cancel_requested` 或 `cancelled + run.cancelled`。
- 审批：状态保存、Approval 和 `approval.required`；审批决定与 `approval.resolved`；审批过期与 `approval.expired + run.failed`。
- Worker 租约过期：重新排队与 `run.requeued`，或等待副作用对账与 `tool.reconciliation_required`。
- 终态：最终输出与 `completed + run.completed`，以及超时/异常与 `failed + run.failed`。
- Sandbox Context、Usage/Cost 和对应事件也使用调用方事务提交。

如果事件插入失败，整个领域状态事务回滚，因此不会出现“REST 已完成但终态事件不存在”。事务提交后，Dispatcher 才尝试向进程内 Condition/Redis 发布通知。

`run_events` 增加发布次数、下次重试时间、发布租约、错误和完成时间。Redis 不可用时领域操作仍然成功，事件保持 pending；API/Worker Dispatcher 后续重试。SSE 无论通知是否成功都以 PostgreSQL 事件日志为事实来源，先补读数据库，再等待通知。

终态还增加不可逆保护：`completed`/`failed`/`cancelled` 提交后，后续记忆或 Artifact 整理失败不会覆盖 Run 终态，只记录 `run.postprocessing_failed`。

## 4. Function Tool 外部副作用幂等：本轮已实现

新增 `tool_executions` 持久化账本，稳定键由 `tenant_id + run_id + tool_call_id + implementation_key` 生成，不把原始参数写入账本，只保存参数 Hash。

执行规则：

1. 首个 Worker 通过数据库唯一约束领取执行权并写入 `running`。
2. 成功后保存 JSON 结果并标为 `completed`；相同 Tool Call 重放时直接返回缓存结果，不再次调用 Handler。
3. 同一 `tool_call_id` 携带不同参数时拒绝执行。
4. 有副作用且未声明 `idempotent=true` 的工具不允许自动重试。
5. Worker 在调用期间消失后，租约过期的执行进入 `unknown`，Run 进入 `waiting_reconciliation`，禁止自动重放整个 Run。
6. 运维方核对下游真实状态后，通过 reconciliation API 把 `unknown` 确认为 `completed` 或 `failed`。由于 Agents SDK 不能从任意 Function Tool 的中间点恢复，该旧 Run 会以明确错误关闭；上游根据对账结果决定是否创建新 Run。

自定义 Function Tool 的 Handler 可从 `ToolInvocation.idempotency_key` 获取稳定键，并传给 Stripe、支付、工单、消息或其他支持幂等键的下游 API。

保证边界必须说清楚：平台自身可以保证同一稳定 Tool Call 的执行领取、结果缓存以及“不确定时不自动重试”；如果进程在“下游已成功、平台尚未记录成功”的瞬间崩溃，只有下游也接受同一个幂等键，才能实现端到端 exactly-once。否则只能实现安全的 at-most-once initiation，并要求人工对账。

MCP 是当前边界缺口。`openai-agents` 的 MCP `call_tool` 接口没有把模型的 `tool_call_id` 传给 Server Wrapper，因此无法仅在平台外层生成跨进程稳定键。当前要求有副作用的 MCP Server 自身实现业务幂等，并把 SDK 的 `max_retry_attempts` 保持为 0；否则应改造成受平台管理的 Function Tool。后续若 SDK 暴露 MCP Call ID，再统一接入本账本。

相关 API：

```text
GET  /v1/runs/{run_id}/tool-executions
POST /v1/tool-executions/{execution_id}/resolve
```

## 5. Worker 与 Docker Socket 风险：接受当前设计，不列高优先级

正常的 `sandbox_exec` 命令运行在子 Sandbox 容器内，子容器没有挂载 Docker Socket，所以 Agent 在 Sandbox 里执行任意命令并不能直接控制宿主 Docker。

风险只在 **Worker 进程本身已经获得任意代码执行** 时成立，例如：部署了恶意/有漏洞的进程内自定义 Function Tool、依赖供应链被污染，或 Worker 内部代码存在可利用漏洞。此时 Worker 挂载的 Docker Socket 通常等价于宿主高权限，影响很大。

在“内部受信平台、注册工具代码受控”的当前边界下，这属于低概率高影响风险，不需要为了形式上的隔离立刻引入远程 Sandbox Control Plane。保留 Docker Sandbox 与最小挂载，记录风险即可。若将来允许第三方 Tool 插件进入 Worker 进程，再重新评估并把 Docker 控制移出 Worker。

## 6. 长期经验记忆：记录为后续质量问题

当前实现可以持久化、按作用域检索、去重、记录来源、修改和禁用，但距离“可靠的长期经验记忆”仍有明显差距：

- 测试/兼容检索主要依赖 Hash 向量和关键词，不是真实 Embedding + PostgreSQL FTS 的完整混合检索。
- 候选提炼主要来自最终输出，缺少对工具结果、失败路径、用户纠正和决策理由的结构化抽取。
- 缺少成熟的矛盾检测、版本合并、时间衰减、TTL 和 `last_confirmed_at` 更新策略。
- 凭据规则只能拒绝明显模式，不能承担通用隐私治理。
- 缺少记忆污染、错误召回、过期事实和跨 Session 收益的离线评测集。

后续处理时必须以检索质量指标和污染率验收，不能仅以“数据库里有 memory 表”作为完成标准。

## 7. Context Compaction：改造完成，保留验证 Backlog

### 7.1 当前实现

字符截断路径已经删除。当前实现采用：

- 不可变 Canonical Transcript 与独立 Active Projection；压缩不会改写原始对话。
- 模型能力目录和 Token 预算驱动的触发，不使用字符数阈值。
- Native Responses Compaction 与 Portable Structured Summary 双路径 Capability Gate。
- 结构化 Checkpoint、近期原文、原子 Tool Pair、静态 Context 重注入和 Artifact Offloading。
- Lease、CAS、来源分块覆盖和激活前确定性校验；失败为 Hard No-op。
- 长期记忆只作为请求级 Segment 注入，不参与摘要事务，也不存在 Memory Flush。

详细算法见 [Compaction 设计](06-context-compaction-design.md)，实现与 MiMo 连续性数据见 [实现报告](07-context-compaction-implementation-report.md) 和 [100K 实验](10-context-compaction-100k-experiment.md)。

### 7.2 决策背景

改造前实现只按字符数保留尾部 JSON，无法可靠保存较早约束，也无法对应不同模型的真实 Context Window。对 Hermes、Claude Code、Codex、OpenClaw、Deep Agents 和 AutoGen 的调研形成了三个最终决定：语义摘要与确定性状态必须分层；记忆和压缩必须分离；Canonical Transcript 必须始终保留。

Claude Code 和 Codex 的公开资料用于建立行为参照，但没有被当成可复制的内部实现。Claude Code 公开支持带关注点的 `/compact`；Codex 公开源码包含模型摘要、Token 预算、静态 Context 重注入和多触发点。当前系统吸收这些可验证原则，同时增加数据库投影、来源覆盖、CAS 和恢复审计。

### 7.3 剩余验证边界

- 真实支持 `/responses/compact` 的 Provider replay 尚未完成；当前 Native Adapter 只有合同测试。
- PostgreSQL 多进程并发、Worker 崩溃和 Redis 通知中断下的 Compaction 故障注入仍在 Backlog。
- Context Overflow 后的最多一次紧急压缩重试尚未接入 Runner；当前选择安全失败，不自动重放 Tool Loop。
- 可选第二模型语义 Reviewer 尚未默认启用；当前激活门以结构化和确定性校验为主。

因此可以称为“Compaction 功能已实现并通过 Portable 实测”，不能称为“所有 Provider 和生产故障场景均验证完成”。

## 8. 真实基础设施测试：记录为后续问题

当前自动化主要在 SQLite/本地对象存储/本地 Sandbox 下运行；Docker Sandbox 有单独 Smoke Test。后续必须补：

- PostgreSQL + pgvector 的迁移、并发领取、锁和向量查询。
- Redis 通知中断、重复通知和 SSE 重连。
- MinIO/S3 的写入失败、孤儿对象、删除补偿和校验和。
- Docker Worker 重启、Run 租约回收、Tool Execution `unknown` 对账。
- Worker 崩溃后孤儿 Docker Sandbox 的发现与 Reaper 清理。
- API 与 Worker 分进程运行的审批恢复、Sandbox 清理和长 Context Compaction。

在这些测试完成前，当前状态应称为“功能完整的工程实现和本地合同验证”，不能称为经过完整生产故障验证。

## 9. Worker 进程拓扑：行为已明确，严格分离待配置化

`agent-system` 当前通过 `create_app(start_worker=True)` 默认内嵌一个 Worker；`agent-worker` 会再启动一个独立消费者。Compose 同时启动 API 和独立 Worker，因此实际是两个 Worker，而不是纯控制面加一个运行面。

数据库租约保证这种多消费者拓扑不会让同一 Run 被正常重复领取，所以它不是当前正确性缺陷。但它影响容量估算、故障域和最小权限：API 容器也具备执行模型、工具和 Sandbox 的能力。如果生产要求严格的控制面/运行面隔离，应增加显式 `AGENT_EMBEDDED_WORKER=false`（或等价配置），并让 Compose API 使用该设置。在实现前，运维文档必须按真实拓扑描述，不能假设 API 是纯控制面。

## 10. 本轮结论

- 不做身份认证。
- 不做无法验证效果的通用自动脱敏。
- 状态/事件原子性已通过 Transactional Outbox 实现。
- Function Tool 副作用幂等账本已实现；MCP 的跨进程稳定 Call ID 仍受上游 SDK 接口限制。
- 保留当前 Docker Sandbox 架构，记录 Worker Socket 风险。
- 长期记忆质量和真实基础设施故障测试进入 Backlog。
- Context Compaction 双路径改造已完成本地合同测试和 MiMo Portable 实测；真实 Native Provider replay 与 PostgreSQL 多进程故障测试仍在验证 Backlog。
- 当前 API 内嵌一个 Worker；严格控制面/运行面分离仍需配置化。
- 正常终态会销毁 Sandbox；Worker 崩溃后的孤儿 Sandbox Reaper 尚未实现。
