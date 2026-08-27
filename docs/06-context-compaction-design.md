# Context Compaction 调研、Hermes 对照与设计方案

> 文档类型：专题设计记录
> 状态：已接受并实现；外部框架调研为带日期快照
> 最后核对：2026-08-26
> 适用版本：AgentSDK `0.1.0`、Compaction 迁移 `0004` 及后续版本

更新日期：2026-08-10

实现状态（2026-08-10）：本文设计的核心路径已经落地。字符截断和伪 `run_compaction()` 协议已删除；实现、故障测试、MiMo v2.5 指标和仍未覆盖的生产边界见 `07-context-compaction-implementation-report.md`。下文“当前实现”字样在调研章节中表示改造前基线。

## 1. 结论

改造前基线并不是真正的上下文压缩：它把旧 Session Item 序列化成 JSON Lines，只保留末尾固定字符，然后包装成一条 `system` 消息。该实现不调用模型、不理解目标和任务状态、不按 Token 预算工作，也无法验证重要信息是否丢失；这条路径现在已经删除。

成熟 Agent 系统采用的是分层 Context Management，而不是单一摘要：

1. 保存不可变的完整 Transcript，压缩只改变模型看到的 Active Context Projection。
2. 大型 Tool Input/Output 外置到 Artifact，只在 Context 中保留摘要、校验值和可检索引用。
3. 按模型 Context Window、静态开销、输出预算和后续 Tool Loop 预算计算触发点。
4. 保持 Tool Call、Tool Result、Approval 和 Handoff 的原子关系。
5. 对旧历史生成语义 Checkpoint，同时保留近期用户消息和近期交互原文。
6. System Policy、Agent Instructions、Skills、权限、预算和未决状态从权威来源重新注入，不依赖有损摘要。
7. Provider 支持时优先使用原生 Compaction；否则使用跨 Provider 的结构化摘要。
8. 压缩结果通过确定性和语义校验后才能成为新的 Active Projection。

新增一条不可破坏的架构边界：**长期记忆与上下文压缩完全解耦**。

- 上下文压缩只管理单个逻辑 Session 的模型输入投影，不提取、不写入、不提交长期记忆。
- 长期记忆有独立的触发、证据、去重、冲突处理、审核和生命周期，不能把“即将压缩”当成记忆写入时机。
- 压缩流程不得调用 `on_pre_compress`、`commit_memory_session` 或任何等价的 Memory Flush 钩子。
- Memory Retrieval 可以由 Context Assembler 作为独立输入段加入下一次请求，但 Compactor 既不读取它来生成摘要，也不修改 Memory Store。
- 压缩失败、超时、回滚或重复执行不能产生任何记忆副作用。

建议采用：以 **Hermes 当前 Context Engine 架构作为 Portable 路径的主要工程基线**；Provider 支持时使用 OpenAI 原生 Compaction；吸收 OpenClaw 的 Tool Pair、标识符保留和质量审计，但不采用 Memory Flush；使用 LangChain Deep Agents 风格的 Artifact Offloading 处理大型内容。

## 2. 框架调研

### 2.1 Hermes Agent

本次以 Hermes 官方仓库提交 `3bd844edf1777a680115f88a68474b4fb434092f`（2026-08-09）为审查基线。当前实现已经不是简单的“50% 时调用一次摘要模型”，而是完整的 Context Engine 子系统。

值得采用的设计：

1. `ContextEngine` 是可插拔接口，统一负责真实用量更新、Preflight、触发判断、压缩、当前请求的 Context Selection、Turn Complete、Session 生命周期、模型切换和 Engine 专属工具。
2. 双入口触发：Agent Loop 使用 Provider 返回的真实 Token 做主要判断；Gateway 在新消息进入前以约 85% 做 Session Hygiene 兜底，粗估只在真实值不可用时使用。
3. 阈值考虑 `context_length - reserved_output_tokens`，支持按模型覆盖和绝对 Token 上限。配置名义默认值为 50%；当前代码对小于 512K 的模型把有效阈值提高到至少 75%，避免过早且频繁压缩。
4. 近期 Tail 按 Token 预算选择，同时设消息数和真实用户消息下限，并修正 Tool Call/Tool Result 边界。
5. 摘要是结构化任务 Checkpoint，特别强调最新未完成用户请求、完成动作、当前状态、阻塞、决定、文件、精确错误和下一步；后续使用“旧摘要 + 新增历史”增量更新。
6. 默认同一逻辑 Session ID 原地压缩；旧消息软归档，仍可搜索和恢复。历史的 Session Rotation 只作为兼容模式。
7. 使用 Session 级持久租约、Lease Refresh、超时 Commit Fence、提交前 Snapshot 和原子 `archive_and_compact`，避免多个 Worker 对同一 Session 并发提交不同压缩结果。
8. 使用冷却阶梯、无效压缩计数、恢复探针和真实 Token 回读判断是否真正降到阈值以下，避免压缩抖动。
9. 支持 Provider/Runtime 专属策略：Codex App Server 走其原生 Thread Compaction；符合条件的 Responses 路径可使用原生 Compaction Item；本地摘要器继续作为后备。
10. 可选 Proactive Tool-result Pruning 和 Micro-compaction；Hermes 默认关闭 Micro-compaction，因为每轮重写历史会持续破坏 Prompt Cache 前缀。

不能直接照搬的设计：

1. `ContextEngine.compress()` 仍接收 `memory_context`；Host 会在压缩前调用 Memory Provider 的 `on_pre_compress()`，提交前还会调用 `commit_memory_session()`。这把记忆写入和压缩生命周期绑定，且记忆副作用早于压缩数据库提交，不符合我们的边界和原子性要求。
2. `abort_on_summary_failure` 默认仍为 `false`。一般摘要失败时可能生成确定性 Fallback 后丢弃中段；只有配置显式开启、鉴权/额度错误或部分网络错误才保证 No-op。我们的默认必须是任何不可验证摘要都不激活 Projection、不丢弃历史。
3. Batch Summary 仍主要是单次 LLM 调用。输入先按每条消息字符数裁剪，再按 160K 字符保留头尾、丢弃中间；这不是按摘要模型 Tokenizer 和实际 Context 能力做的无损分块。
4. Phase 1 会在摘要前改写旧 Tool Result；保护区压力过高时甚至会降级近期大型 Tool Body。我们只允许先外置到可校验 Artifact，再在投影中放引用；不能用不可逆文本替换作为正式压缩的前置条件。
5. 迭代摘要长期使用“摘要的摘要”，Hermes 自己在第二次压缩后提示精度可能下降，但没有基于原始 Transcript 的周期性 Rebase 和字段级来源证明。
6. Hermes 为兼容不同 Chat Template，会把摘要放进 `user`/`assistant` 消息或合并到 Tail。我们应使用显式 Projection Segment 类型，在 Provider Adapter 最后一层才转换为合法消息，避免持久层把历史摘要伪装成人类新输入。

来源：[Hermes Context Compression 文档](https://github.com/NousResearch/hermes-agent/blob/3bd844edf1777a680115f88a68474b4fb434092f/website/docs/developer-guide/context-compression-and-caching.md)、[`ContextEngine`](https://github.com/NousResearch/hermes-agent/blob/3bd844edf1777a680115f88a68474b4fb434092f/agent/context_engine.py)、[`ContextCompressor`](https://github.com/NousResearch/hermes-agent/blob/3bd844edf1777a680115f88a68474b4fb434092f/agent/context_compressor.py)、[压缩事务与并发控制](https://github.com/NousResearch/hermes-agent/blob/3bd844edf1777a680115f88a68474b4fb434092f/agent/conversation_compression.py)。

### 2.2 OpenClaw

OpenClaw 将旧消息摘要为持久化 `compaction` entry，保留近期原文，完整 Transcript 继续保存在磁盘。它提供：

- 接近窗口上限时自动压缩；Provider 报 Context Overflow 时压缩并重试。
- Tool Call/Tool Result 成对选择边界。
- `keepRecentTokens` 近期尾部预算。
- 严格 opaque identifier 保留策略。
- Safeguard Mode 的摘要质量审计与有限重试。
- 可插拔 Compaction Provider，失败时回退到内置 LLM 摘要。
- Session Pruning：只临时裁剪 Tool Result，不修改持久化摘要。
- Mid-turn Precheck：Tool Result 写入后检查下一次模型请求是否会溢出。

OpenClaw 的压缩前记忆写入机制已明确排除在本项目计划之外：压缩不是长期记忆的触发器，记忆成功与否也不能成为压缩的前置条件或回退手段。

来源：[OpenClaw Compaction](https://github.com/openclaw/openclaw/blob/main/docs/concepts/compaction.md)、[Session Management and Compaction](https://github.com/openclaw/openclaw/blob/main/docs/reference/session-management-compaction.md)。

### 2.3 LangChain Deep Agents

Deep Agents 把大型 Tool Input/Output 外置到文件系统或可替换 Backend：

- 大型 Tool Result 保存到外部存储，Context 只保留文件路径和 Preview。
- 接近模型窗口约 85% 且没有更多内容可外置时，才进行语义摘要。
- 保留约 10% 的近期原文。
- 完整原始消息写入文件系统作为 canonical record。
- 遇到标准 `ContextOverflowError` 时执行摘要并重试。
- Subagent 使用独立 Context，避免研究型或工具密集任务污染主 Agent 上下文。

来源：[Deep Agents Context Engineering](https://docs.langchain.com/oss/python/deepagents/context-engineering)。

### 2.4 Claude Code 与 Codex

Claude Code 先清理旧 Tool Output，再对会话进行摘要。Project Root `CLAUDE.md`、Auto Memory、System Prompt 和符合预算的 Skill Body 会在压缩后重新注入；可通过 `/compact <focus>` 指定摘要关注点。其官方文档明确提醒，仅存在于早期会话中的指令仍可能丢失。

Codex 支持本地模型摘要和 Provider 原生压缩。当前开源实现会保留最多约 20K Token 的近期用户消息、生成的摘要，以及按运行阶段重新注入的 Initial Context；同时支持手动、自动和 Mid-turn Compaction。多次压缩仍被视为有损操作。

来源：[Claude Code Context Window](https://code.claude.com/docs/en/context-window)、[Codex compact.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs)。

### 2.5 AutoGen

AutoGen 提供 `BufferedChatCompletionContext`、`TokenLimitedChatCompletionContext` 和可扩展 Model Context 接口。默认实现主要是最近 N 条或 Token 上限视图，能防止溢出，但不等价于语义压缩。它说明 Context 抽象和真正的信息保留算法是两个不同层次。

来源：[AutoGen Model Context](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/components/model-context.html)。

### 2.6 OpenAI Responses 与 Agents SDK

OpenAI Responses API 提供两条原生路径：

- `context_management` + `compact_threshold`：在 Responses 请求和流式输出内部触发 Server-side Compaction。
- `/responses/compact`：接收完整 Context，返回下一次调用应原样使用的 canonical compacted window。

压缩结果包含 opaque、加密的 Compaction Item，用于以较少 Token 延续关键状态和推理。它不应被解析或改写。

当前项目安装的 `openai-agents==0.22.0` 提供 `OpenAIResponsesCompactionSession`、Compaction Item 支持和 `ModelSettings.context_management`。改造前平台没有接入这些能力，并用自定义 `DatabaseSession.run_compaction()` 错占 SDK 的 Compaction-aware Session 接口；该方法现已删除，Native 能力改由 Provider Capability 合同门控。平台直接调用 Native Compact 时必须记录响应中的真实 Usage，不能把压缩成本记为零。

来源：[OpenAI Compaction](https://developers.openai.com/api/docs/guides/compaction)。

### 2.7 Hermes 对照后的设计决策

| 能力 | Hermes 当前方案 | 本项目决定 |
|---|---|---|
| 扩展边界 | 单一可插拔 `ContextEngine`，同时含选择、观察、压缩和工具 | 采用接口化思想，但拆成 `ContextPolicy`、`CompactionStrategy`、`ContextAssembler`；职责不混在一个大接口中 |
| 触发 | Loop 真实 Token + Gateway Hygiene 粗估兜底 | 采用；再加入 Provider Overflow 和模型切换 Preflight，统一进入同一状态机 |
| 阈值 | 名义 50%，小窗口有效下限 75%，Gateway 85% | 不复制固定百分比；使用可用输入预算、高/低水位和 Provider 能力计算 |
| 最近上下文 | Token Tail + 消息下限 + 真实用户消息下限 | 采用，并把未完成 Tool/Approval/Handoff 作为不可压缩控制段 |
| Tool 结果 | 压缩前摘要/截断，必要时降级保护区内容 | 改为 Artifact-first；失败时保留原文，不做不可恢复替换 |
| 摘要输入 | 单次调用；逐消息字符裁剪 + 160K 字符总上限 | 改为按摘要模型 Tokenizer 预检；超限时按原子交互组分块并分层归并 |
| 摘要递归 | Previous Summary + New Turns | 采用增量 Checkpoint，但增加来源范围、字段 Provenance 和周期性从 Canonical Transcript Rebase |
| 摘要失败 | 可配置 Abort；默认可用确定性 Fallback 丢弃中段 | 强制 Hard No-op；Fallback 只能用于 Request 临时降级，不能激活持久 Projection |
| 并发和超时 | Session Lease + Refresh + Commit Fence + 原子软归档 | 采用，并与现有 Revision CAS、Outbox 合并 |
| Session 语义 | 默认同 ID 原地压缩，旧记录软归档 | 采用同一逻辑 Session；Transcript 永不改写，只新增 Projection Revision |
| 压缩防抖 | Cooldown、无效计数、恢复探针、真实用量回读 | 采用；高/低水位状态机持久化，避免进程重启解除保护 |
| Prompt Cache | 静态 System 前缀稳定；压缩或 Micro-compaction 会使后续前缀失效 | 采用稳定分段顺序；默认不启用逐轮 Micro-compaction |
| 记忆关系 | `on_pre_compress`、`memory_context`、`commit_memory_session` 与边界回调 | 全部从压缩域删除；Memory 是独立 Pipeline，只由 Context Assembler 读取检索结果 |
| 原生 Provider | Codex App Server/Responses 走原生路径，本地摘要兜底 | 采用 Capability-driven Strategy，合同测试后启用，不按模型名称猜测 |
| 可观测性 | Attempt ID、区域 Token、Aux 调用、Fallback、Commit/Split 状态 | 采用并扩展 Validation、Projection Revision、Artifact Reclaim 和语义连续性指标 |

## 3. 目标架构

```text
不可变 Session Transcript
  ├─ Tool Output / Artifact Offloader ──> Artifact Store
  └─ Compaction Orchestrator
       ├─ OpenAI Native Compaction
       ├─ Portable Structured Summarizer
       └─ Emergency Request-only Reducer
                         │
                         v
                 Compaction Validator
                         │
                         v
               Active Context Projection

独立的 Long-term Memory Pipeline ───────> Long-term Memory Store
                                                   │ read only
                                                   v
Context Assembler =
  最新 Agent Instructions / Policy / Skills        （静态权威段）
  + 确定性 Control Checkpoint                       （控制段）
  + Native Compaction Item 或 Portable Summary     （投影段）
  + 检索出的 Long-term Memory                       （独立检索段）
  + Artifact References                            （引用段）
  + 近期未压缩原文 + 当前用户输入                   （实时段）
```

关键概念必须分离：

- **Canonical Transcript**：不可变的完整事实记录。
- **Active Context Projection**：当前模型实际看到的 Context View。
- **Context Checkpoint**：当前任务的目标、约束、决定、进度和下一步。
- **Control Checkpoint**：审批、Tool State、Handoff、Artifact、预算等确定性平台状态。
- **Long-term Memory**：跨 Session 仍有价值的事实、偏好和已验证经验。
- **Artifact**：需要精确保存和按需读取的大型内容。

边界规则：

- Compaction 输入只能来自 Canonical Transcript、Control State、Artifact Metadata 和 Compaction 配置。
- Memory Retrieval 的结果不能写进 Portable Summary 的持久内容；它只属于当次 Request 的独立段，避免把过期或错误召回固化进摘要。
- Long-term Memory Pipeline 可以读取 Canonical Transcript，但不能把 Active Projection 当成唯一证据，也不能由 Compaction Event 触发。
- Context Assembler 是唯一组合 Projection、Memory、Skills 和 Control State 的组件；Compactor 不负责最终 Prompt 拼装。

## 4. Token 预算与触发

先计算真实可用输入预算，而不是按字符数或单一 Context Window 百分比判断：

```text
available_input_budget =
    model_context_window
    - reserved_output_tokens

dynamic_history_budget =
    available_input_budget
    - system_and_skill_tokens
    - tool_schema_tokens
    - control_checkpoint_tokens
    - retrieved_memory_budget
    - reserved_tool_loop_tokens
    - provider_safety_margin
```

采用持久化的高/低水位状态机：

- `NORMAL`：不压缩；大型 Tool Output 在产生时立即 Artifact-first，不等待 Context 压力。
- `COMPACTION_DUE`：预计下一次请求超过 `high_watermark`，创建 Snapshot 并执行正式压缩。
- `COMPACTION_BLOCKED`：压缩正在运行、处于冷却、没有可压缩区间或最近两次无效；对用户和遥测公开原因。
- `EMERGENCY`：Provider 返回明确 Context Overflow，或下一次请求超过 `hard_input_limit`；基于同一 Snapshot 执行紧急策略，最多重试一次 Model Call，绝不重复副作用 Tool。
- `RECOVERED`：Provider 的下一次真实 Usage 低于 `low_watermark` 后才解除防抖闩锁。

默认计算建议：

```text
hard_input_limit = available_input_budget - provider_safety_margin
high_watermark   = min(configured_trigger_tokens,
                       hard_input_limit - reserved_tool_loop_tokens)
low_watermark    = min(target_projection_tokens,
                       high_watermark * 0.60)
```

如果未配置 `configured_trigger_tokens`，可按模型窗口给初值，但它只是策略默认值：小于 512K 的模型从可用输入预算的 75% 起，大窗口模型从 50% 起，再由合同测试、真实 Usage 偏差和工具 Schema 固定开销校正。这吸收了 Hermes 的实践，但避免把 50%/75%/85% 当成普遍真理。

检查入口与职责：

- Agent Loop：每次 Provider Response 后用真实 `input_tokens` 更新状态；这是主要触发依据。
- Request Preflight：每次模型调用前检查完整已组装请求，特别是 Tool Result 写入后。
- Runner/Gateway：恢复长 Session、新消息进入、模型切换或 Provider Fallback 前做 Hygiene 兜底。
- Overflow Handler：只接受 Provider 的明确 Context Overflow 分类，不用字符串中的普通 `token` 字样猜测。
- 粗略估算只用于提前触发，必须记录估算器版本和误差；有真实 Usage 基线时按增长量投影，不能让粗估覆盖真实读数。

Context Window、输出预留或 Tool Schema Token 无法可靠得到时，Provider 必须显式配置或进入保守的 Unsupported 状态，不能用 `len(text) / 4` 作为生产事实。

近期尾部按 Token 选择：默认保留不超过 20K Token 或 Context Window 的 10%～15%，同时保证至少最近 3 个真实用户回合原样存在。

## 5. 压缩流水线

### 5.1 创建快照

先取得 Session 级压缩租约，再把当前未压缩 Tail 刷入 Canonical Transcript。记录 Session Revision、Source Sequence Range、Provider、Model、Context Window、完整请求 Token、估算来源、触发入口和当前 Projection Revision。此时只创建 `pending` Compaction，不改变 Active Projection。

摘要调用在 Snapshot 上运行，绝不持有数据库长事务。超时或取消后，Commit Fence 必须阻止迟到 Worker 写入状态；租约由 Holder-qualified Release 释放，避免旧 Worker 释放新持有者的锁。

Snapshot 不包含任何“准备写入长期记忆”的字段，也不执行记忆回调。

### 5.2 Artifact Offloading

大型 Tool Input/Result 应在产生时就保存为 Artifact；Compaction 只补做历史迁移，不直接用字符截断覆盖原值。Context Stub 至少包含：

- `call_id`
- Tool Name
- 状态和必要错误片段
- 简要摘要
- `artifact_id`
- SHA-256
- MIME Type
- 重新读取方式

图片 Base64、完整文件、长终端日志和搜索结果不得在多轮 Context 中持续重放。

Artifact 写入、校验和 Stub 激活必须原子关联。外置失败时保留原消息，不得退化为 Hermes 式的 `[Old tool output cleared ...]` 占位符。

### 5.3 选择原子边界

压缩的最小单位是完整对话轮次。一个轮次从真实 User Item 开始，到下一个真实 User Item 之前结束；其中的 Reasoning、Assistant Response、Tool Call/Result、Approval 和失败元数据都不得跨越 Checkpoint/Tail 边界：

```text
user request
+ reasoning / assistant tool_call
+ tool_result / approval decision
+ retry/failure metadata
+ final assistant response
```

不得把 User Request 放入 Checkpoint、却把对应 Assistant Response 留在 Raw Tail；否则运行时会把已经回答的请求误判为 Pending。不得拆分 Tool Call/Result；Pending Tool、Approval 和 Handoff 保留在近期原文区，并从权威数据库重建。Tail Token 目标是软下限：为了保持轮次原子性，可以多保留一个完整轮次。

### 5.4 选择 Strategy

由 `ProviderCapabilityRegistry` 根据合同测试结果选择 Strategy，不按模型名或 Base URL 猜测。Provider 合同测试确认支持时：

- 单轮长 Tool Loop 使用 Server-side `context_management`。
- 回合间、手动或 Preflight 使用 `/responses/compact`。
- 原样保存返回的 canonical items。

Provider 不支持原生 Compaction 时，使用 Portable Structured Summary。摘要至少包含：

```json
{
  "objective": {
    "current_goal": "",
    "success_criteria": []
  },
  "constraints": [],
  "decisions": [],
  "progress": {
    "done": [],
    "in_progress": [],
    "blocked": [],
    "next_actions": []
  },
  "execution_state": {
    "authority": "runtime_derived",
    "source_to_seq": 0,
    "responded_user_turn_count": 0,
    "last_responded_user_source_seq": 0,
    "pending_user_turn_count": 0,
    "recent_pending_user_inputs": [],
    "completed_tool_call_count": 0,
    "recent_completed_tool_calls": [],
    "pending_tool_calls": [],
    "approvals": []
  },
  "active_task": {
    "latest_unfulfilled_user_input": "",
    "source_seq": 0
  },
  "completed_actions": [],
  "artifacts": [],
  "relevant_files": [],
  "unresolved_questions": [],
  "exact_identifiers": [],
  "tool_and_approval_state_refs": [],
  "narrative_summary": ""
}
```

`execution_state`、`active_task`、`completed_actions` 和 `progress` 不是模型生成字段。Runtime 从 Canonical Transcript、Tool Call/Result 和 Approval Record 确定性派生并覆盖模型输出；摘要模型只负责目标、约束、决定和叙事语义。结构化状态附 `source_seq` 或 Source Range，Pending Approval、正在执行的 Tool 和权限状态只保存权威记录，不让摘要模型重写事实。

Portable Summary 必须先对摘要模型做能力预检：

```text
summary_input_budget =
    summary_model_context_window
    - summary_prompt_tokens
    - reserved_summary_output_tokens
    - safety_margin
```

- `source_window` 超过预算时，按完整交互组分块；每块生成同 Schema 的 Partial Checkpoint，再做确定性字段合并和必要的最终归并。
- 不允许使用 160K 字符或逐消息字符上限代替 Token 预算，也不能通过保留头尾、静默丢中间来让请求“能发出去”。
- 辅助模型失败时可尝试一次已验证能力足够的备用模型；没有合格模型就中止，不激活压缩结果。
- 输出长度必须有明确预留，但不能设置会截断结构化结果的任意极小上限；返回 `finish_reason=length` 或 Schema 不完整一律失败。

重复压缩通常使用“上一个 Checkpoint + 新增原始区间”，但不能无限 Summary-of-Summary：

- 每个字段保存 Provenance Range 和摘要代数 `generation`。
- 每 3 次压缩、关键字段校验失败或累计覆盖超过配置范围时，从 Canonical Transcript 对仍有效的事实做 Rebase。
- Rebase 仍采用分块归并，旧 Projection 只是提示，不是权威来源。

Portable Summary 不得作为 `system` 消息注入，避免旧会话内容和 Tool Output 被提升为高优先级指令。

### 5.5 重新注入静态 Context

下列内容从权威来源重新生成，不交给摘要模型决定：

- Agent Instructions 和 System/Developer Policy
- 当前有效 SKILL.md
- Guardrails 和权限策略
- Pending Approval、Tool State 和 Handoff State
- Cost Budget
- Sandbox Handle
- Artifact 元数据

检索出的长期记忆由 Context Assembler 在此步骤之后作为独立、带来源和时效的 Request Segment 注入。它不进入 Context Checkpoint，不影响 Compaction 成败，也不能修改静态 System Prefix。这样既允许模型利用记忆，又不会把一次错误召回永久固化到后续摘要。

分段顺序和序列化必须稳定，尽量保持 System/Developer、Agent Instructions、Tool Schema 等前缀字节不变。压缩只替换 Projection Segment；默认不做逐轮 Micro-compaction，避免持续破坏 Provider Prompt Cache。

### 5.6 校验

确定性校验：

- Tool Call/Result 无孤儿。
- Checkpoint/Tail 边界不拆分 User Request 与其 Assistant Response。
- `execution_state` 与 Canonical Transcript、Tool Call/Result、Approval Record 的确定性派生结果逐字段一致。
- Pending Approval、当前目标和最近用户指令存在。
- Artifact ID、文件路径、URL、Commit、PR、Run ID 等 opaque identifier 原样保留。
- Schema 合法，Source Range 与 Session Revision 一致。
- 压缩后 Token 低于目标。
- 压缩率低于约 20% 时视为无效压缩，避免反复压缩。
- Summary Model 输入没有未声明的截断，所有 Source Chunk 均被覆盖。
- Memory Store 的读取版本可用于请求审计，但压缩 Attempt 的 Memory Write Count 必须为 0。

可选语义 Reviewer 检查：

- 是否遗漏关键约束。
- 是否把未完成事项错误标成完成。
- 是否引入源历史中不存在的决定。
- 是否保留失败原因和下一步。

任何校验失败都不得激活新 Projection，也不得把原消息设为 inactive。特别是模型输出不得把已存在后续 Assistant Response 的 User Item 标成未响应；状态不一致必须 Hard No-op。确定性 Fallback 只能生成一次临时的 Request-only Reducer，用于在明确 Overflow 时让用户看到可恢复的错误或执行 `/compact`；它不能成为持久 Projection，也不能宣称替代了丢失的历史。

OpenAI Native Compaction Item 是 opaque 数据，Validator 不解析或声称检查其语义内容。该 Strategy 的激活条件改为：Capability 合同已通过、返回 Item 结构完整、Issuer/Provider/Model 匹配、Replay 合同测试成功、Source Range 完整且 Token 目标达成；语义连续性通过隔离的 Replay Probe/Eval 评估，而不是修改 encrypted item。

### 5.7 原子激活

1. 取得带 TTL 的 Session Compaction Lease，并创建 Attempt ID。
2. 短事务把最新消息刷入 Canonical Transcript，创建 `pending` Compaction 和不可变 Snapshot，然后释放数据库事务。
3. 事务外调用 Compactor Provider；Timeout/Cancel 由 Commit Fence 管理，迟到结果不得提交。
4. 校验结果并计算实际 Token、压缩率和语义连续性指标。
5. Commit Fence 获准后，使用 CAS 检查 Session Revision、Active Projection Revision、Source Range 和 Lease Holder。
6. 在一个数据库事务中写入 Compaction、Projection Segments、Active Revision、状态机 Low-watermark 闩锁和 Outbox Event。
7. 并发新增消息作为未压缩 Tail 续接；Source Range 冲突或租约丢失则拒绝提交。
8. 提交后用下一次 Provider 真实 Usage 验证是否降到 Low Watermark；未降到则记录无效压缩 Strike，不立即循环重压。

不能直接用通用 `OpenAIResponsesCompactionSession` 的 `clear_session()` + `add_items()` 替换当前数据库历史，因为这会跨越两个数据库事务。

### 5.8 组件接口

不复制 Hermes 的单一大 `ContextEngine` 接口，拆成以下边界：

```python
class ContextPolicy(Protocol):
    def record_usage(self, usage: CanonicalUsage) -> None: ...
    def evaluate(self, request: ContextEstimate) -> CompactionDecision: ...

class CompactionStrategy(Protocol):
    def compact(self, snapshot: CompactionSnapshot) -> CompactionCandidate: ...

class CompactionValidator(Protocol):
    def validate(self, snapshot, candidate) -> ValidationReport: ...

class ContextAssembler(Protocol):
    def assemble(self, session_id, current_input) -> ModelInputProjection: ...

class ContextProjectionRepository(Protocol):
    def activate(self, candidate, expected_revision, lease) -> ProjectionRevision: ...
```

`ContextPolicy` 只做预算和状态机；`CompactionStrategy` 只处理 Snapshot；`ContextAssembler` 才能读取 Skills、Control State、Artifact 和 Memory Retrieval；Repository 只做持久化与 CAS。插件可以替换 Strategy 或 Policy，但不能绕过 Validator 和原子激活。

## 6. 数据模型与 API

扩展 `compactions`：

```text
status
strategy
trigger
parent_compaction_id
source_from_seq
source_to_seq
source_revision
provider
model
schema_version
summary_json
native_items_json / encrypted_blob_ref
validation_json
tokens_before
tokens_after
compression_ratio
failure_reason
attempt_id
lease_holder
engine_name / engine_version
summary_generation
summary_model_context_window
summary_input_tokens
summary_output_tokens
source_chunk_count
all_chunks_covered
```

新增：

```text
context_projections
context_projection_segments
provider_capabilities
compaction_leases
compaction_state
compaction_source_chunks
```

`context_projection_segments` 使用显式类型：`native_checkpoint`、`portable_checkpoint`、`recent_raw`、`artifact_ref`、`control_ref`。长期记忆不保存在这里；Request 级的 `memory_retrieval` 只出现在 Trace/Context Preview 中，并带 Memory Record ID、版本和检索分数。

API：

```text
POST /v1/sessions/{id}/compact
GET  /v1/sessions/{id}/compactions
GET  /v1/sessions/{id}/compactions/{compaction_id}
POST /v1/sessions/{id}/compactions/{compaction_id}/restore
GET  /v1/sessions/{id}/context-preview
```

手动压缩请求支持：

```json
{
  "strategy": "auto",
  "focus": "保留 API 设计决定和未完成测试",
  "dry_run": false
}
```

## 7. 落地清单（核心路径已完成）

- 删除当前伪装成 SDK 官方能力的 `DatabaseSession.run_compaction()`。
- 删除 `source[-max_chars:]` 和所有字符阈值压缩路径。
- `runner._prepare_context()` 改为先调用 `ContextPolicy.evaluate()`，再由 `ContextAssembler.assemble()` 生成本次请求投影。
- 新增 `ContextPolicy`、`CompactionOrchestrator`、Provider Strategy、Validator、Context Assembler 和 Context Projection Repository。
- Artifact、Tool Execution Ledger 和事务 Outbox 作为权威数据源接入；Memory 只通过 Context Assembler 的只读 Retrieval Adapter 接入。
- 压缩代码中不得引用 Memory Writer、Memory Extractor、`on_pre_compress`、Session-end Memory Commit 或等价接口。
- 摘要失败策略固定为 Hard No-op，且不可被 Provider Strategy 降级覆盖；确定性 Fallback 不允许持久化为 Active Projection。
- 为 Compression Worker 增加有界执行池、进度感知超时、Session Lease、Commit Fence、Cooldown 和 Anti-thrashing 持久状态。
- Summary Model 必须声明 Context Window/Tokenizer；增加原子交互分块、Partial Checkpoint 合并和周期性 Rebase。
- 对 MiMo 单独测试 `/responses/compact`、`context_management`、Compaction Item Replay；任一项失败则使用 Portable Structured Summary。
- 测试目标从“消息数量减少”改成语义连续性、精确状态完整性和恢复能力。

## 8. 验收标准

- 关键约束、审批、Tool ID、Artifact ID 保留率 100%。
- Tool Call/Result 孤儿数为 0。
- Overflow Retry 不重复执行副作用工具。
- 连续 5 次压缩后仍能正确回答目标、当前进度、关键决定和下一步。
- 原始 Transcript 可完整恢复。
- Compactor 超时、空输出、非法 JSON 和数据库冲突不会破坏当前 Session。
- 摘要模型 Context 小于待压缩区间时自动分块，不发生字符头尾截断或中段丢弃。
- 压缩 Attempt 不产生任何 Memory 写入、Session-end Memory Commit 或 Memory Provider 生命周期回调。
- 压缩运行期间并发到达新消息、Worker 超时后迟到、进程重启和 Lease 过期都不能造成双重激活或 Transcript/Projection 分叉。
- 连续无效压缩会进入持久冷却；只有真实 Provider Usage 低于 Low Watermark 或恢复探针成功才解除。
- Prompt Cache 的静态前缀在普通 Turn 与压缩后保持字节稳定；Micro-compaction 默认关闭。
- OpenAI Native、MiMo Responses、MiMo Chat Completions 分别有 Provider 合同测试。
- 记录压缩前后 Token、压缩率、成本、耗时、Strategy、验证结果和失败原因。
- 不再存在任何按字符截断历史的代码路径。
