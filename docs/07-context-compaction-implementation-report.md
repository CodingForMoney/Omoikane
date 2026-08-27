# Context Compaction 实现与实测报告

> 文档类型：实现验收快照
> 状态：历史证据；实现不变量仍适用，测试数字不动态更新
> 最后核对：2026-08-26
> 适用版本：2026-08-10 验收代码、`openai-agents==0.19.4`、Compaction 迁移 `0004`

更新日期：2026-08-10（Asia/Taipei）

## 1. 结论

已删除原先按字符截断历史的伪压缩路径，并按 `06-context-compaction-design.md` 落地为：

- 不可变 Canonical Transcript；压缩只切换 Active Context Projection。
- Token 高/低水位策略和真实 Provider Usage 反馈，不再用字符数触发。
- 经能力合同验证的 OpenAI Native Compaction 路径，以及跨 Provider 的 Portable Structured Summary 路径。
- Session 单写租约、心跳续租、Snapshot、Source Checksum、Projection Revision CAS 和事务内原子激活。
- 完整对话轮次原子分组、按 Token 分块、Partial Checkpoint 归并和周期性 Canonical Rebase；User Request 与其 Assistant/Tool 链不得跨越 Checkpoint/Tail 边界。
- System/Developer、Pending Tool、最近用户回合和精确标识符保护。
- 大型 Tool Output Artifact Offloading；Artifact 与 Projection 同事务激活，失败 Attempt 只留下 `orphaned` 补偿状态。
- v2 Checkpoint 将 `execution_state`、`active_task`、`completed_actions` 和 `progress` 改为 Runtime 从 Transcript/Tool/Approval 确定性派生；摘要模型不能决定任务状态。
- 摘要 Schema、Runtime Execution State、Token 降幅、Low Watermark、Pending Tool、Identifier、Chunk Coverage 校验。
- 长期记忆与压缩完全分离：Memory Retrieval 通过 SDK `call_model_input_filter` 只在 Model Call 前临时注入，既不进入 Transcript，也不进入 Checkpoint；压缩 Attempt 的 Memory Write 为 0。
- 管理 API、上下文预览、压缩历史、详情和恢复点。

这不是“把摘要消息写回 Session”。`session_items` 始终是审计和恢复用的事实记录；`context_projections` 才是模型下一轮看到的窗口。

## 2. 主要实现位置

| 能力 | 实现 |
|---|---|
| 策略、Tokenizer、分块、Portable/Native Strategy、校验、租约/CAS | `src/agent_system/compaction.py` |
| Canonical Transcript 与 Projection Overlay | `src/agent_system/sessions.py` |
| 自动 Preflight、真实 Usage 反馈、Request-only Memory | `src/agent_system/runner.py` |
| Projection、Lease、State、Chunk、Capability 数据模型 | `src/agent_system/models.py` |
| 数据库迁移 | `migrations/versions/0004_context_projections.py` |
| REST API | `src/agent_system/api.py` |
| 故障和连续性测试 | `tests/test_compaction.py` |
| 真实 Provider 合同测试 | `scripts/provider_e2e.py` |

## 3. 一致性与失败语义

压缩的提交规则如下：

1. 获取 Session 级 TTL Lease，记录 Attempt ID。
2. 在短事务中创建不可变 Snapshot 和 `pending` Compaction。
3. 在事务外调用摘要 Provider；Provider 调用由有界执行池限制，Lease 持续刷新。
4. 每个完成的 Source Chunk 单独记录进度，但不改变 Active Projection。
5. 校验 Candidate；任何错误都执行 Hard No-op。
6. 激活事务重新检查 Lease、Active Projection Revision 和 Snapshot Source Checksum。
7. Projection、Segments、Compaction、Artifact 状态、Compaction State 和 Run Outbox Event 在同一事务提交。
8. Snapshot 之后到达的新消息不造成冲突，作为 Projection 后的 Canonical Tail 自动续接；Snapshot 范围内发生修改则 CAS 拒绝提交。

失败、超时、非法 JSON、低压缩率、Low Watermark 未达标、Identifier 丢失、租约丢失和 Source 冲突均不能覆盖旧 Projection，也不能把原 Transcript 标记为 inactive。

## 4. 本地自动化结果

最终命令：

```text
ruff check src tests scripts                              All checks passed
pytest -q                                                 55 passed
```

压缩专项覆盖：

- 摘要 Provider 失败后的 Hard No-op 和持久 Cooldown。
- 两个 Worker 同时压缩同一 Session 时只有一个持有 Lease。
- 摘要期间追加新消息，提交成功且新消息保留为 Tail。
- Snapshot 范围被修改时 Source Checksum CAS 拒绝激活。
- 大型 Tool Output 外置，Canonical 原值不变。
- 外置后摘要失败，Artifact 不会成为 active。
- 已验证 Capability 时 `auto` 选择 Native Compaction Item。
- 连续 5 次 Portable Compaction 后，Checkpoint Lineage、绝对路径和 Canonical Transcript 仍完整。
- System 约束和 Pending Tool Call 不丢失。
- User/Assistant 完整轮次不跨 Checkpoint/Tail 边界。
- 已响应用户轮次不会被 checkpoint 标记为未完成；模型状态与 Runtime 状态不一致时 Hard No-op。
- Tool Call/Result 和 Approval 状态由 Runtime 确定性派生并进入 Snapshot Checksum。
- Memory Retrieval 只影响当次 Model Input，不写入 Session 历史。
- Runner Token Preflight 自动压缩、真实 Usage 更新状态、Outbox Event 与 Projection 一致。
- Alembic `upgrade head`/`downgrade base` 覆盖迁移 `0004`。

## 5. MiMo v2.5 真实测试

目标 Provider：

```text
Base URL  https://token-plan-cn.xiaomimimo.com/v1
Model     mimo-v2.5
Protocol  OpenAI-compatible
```

API Key 通过 `getpass` 无回显输入，只存在于测试进程环境；代码、数据库和报告没有写入明文 Key。普通 Agent Run 没有设置生成 Token 上限；Portable Summary 明确预留并设置 `4096` Token 输出预算，不是 16 Token。

执行命令：

```text
python scripts/provider_e2e.py --compaction-only
```

### 5.1 Provider Capability Probe

| 能力 | 实测结果 | Provider 返回 |
|---|---|---|
| `/responses/compact` | 不支持 | HTTP 400；gateway phase 返回 404 NOT_FOUND/Invalid request |
| Responses `context_management` | 不支持 | HTTP 400；`responses_feature_not_supported` |
| Compaction Item Replay | 不支持 | 没有可 replay 的 Native Compaction Item |

因此该 Provider 的 `auto` 策略不能选择 Native，实际正确选择 `portable`。

### 5.2 压缩指标

| 指标 | 实测值 |
|---|---:|
| Canonical Transcript | 41 项，压缩前后完全相同 |
| Active Projection | 41 项降到 11 项 |
| 压缩前 Token 估算 | 4,994 |
| 压缩后 Token 估算 | 2,043 |
| Token 降幅 | 59.0909% |
| Summary Provider input | 4,845 Token |
| Summary Provider output | 1,622 Token |
| Source Chunk | 1，覆盖完成 |
| Validation | 通过；0 error、0 warning |
| Compaction Memory Write | 0 |
| Compaction Provider 耗时 | 49,241.216 ms |

这里的投影 Token 使用明确配置的 `o200k_base` 计算；MiMo 没有公开专用 Tokenizer，因此它是稳定的预算代理。压缩后验证 Run 的 Provider 实际 Usage 为 1,910 input、505 output、2,415 total Token，用于反馈高/低水位状态。MiMo 未提供价格，所以 Summary Cost 记录为 `unpriced`。

### 5.3 语义连续性

在早期历史中放入 UUID、权威文件绝对路径、安全约束；近期历史中放入当前任务和未决问题。压缩后让 MiMo 只根据 Active Projection 恢复：

| 检查 | 结果 |
|---|---|
| UUID `7d9e2fd1-c739-4b5f-a98e-f24cb930be21` | 精确恢复 |
| `/private/tmp/research-agent/critical-ledger.csv` | 精确恢复 |
| `不得访问生产系统` | 正确恢复 |
| 当前任务：MiMo Portable Compaction 实测并报告压缩率 | 正确恢复 |
| 未决问题：能否恢复初始约束、标识符和权威文件 | 正确恢复 |

5/5 语义检查通过。验证回答由 173 个流式 delta 组成，最终 Run 状态为 `completed`。

### 5.4 100K 状态正确性复测

8 轮、100,246 Token 的详细实验及 v2 修复复测见 `10-context-compaction-100k-experiment.md`。修复版按完整对话轮次选择边界，压缩到 37,821 Token（减少 62.27%）；Checkpoint 覆盖 Seq 1–10 的 5 个完整已响应轮次，Seq 11–16 的第 6～8 轮成对保留在 Raw Tail。`execution_state_validated=true`，后续 MiMo 回答 `ACK-06=<已完成>; PENDING=0`。

## 6. 配置要求

启用压缩时必须显式声明 Context Window；无法可靠得到时拒绝发布配置。MiMo 本次使用：

```json
{
  "compaction": {
    "enabled": true,
    "strategy": "auto",
    "context_window": 32768,
    "reserved_output_tokens": 4096,
    "reserved_tool_loop_tokens": 4096,
    "safety_margin_tokens": 2048,
    "trigger_tokens": 22000,
    "target_projection_tokens": 10000,
    "keep_recent_tokens": 1000,
    "min_tail_user_messages": 2,
    "summary_context_window": 32768,
    "summary_output_tokens": 4096,
    "summary_prompt_reserve_tokens": 4096,
    "tokenizer": "o200k_base"
  }
}
```

Registry 会拒绝未知 Context Window、非法 Strategy、无 Summary 输入预算和小于 1024 Token 的摘要输出预算。

## 7. 仍需明确的边界

当前核心路径已经实现并通过真实 Provider 验证，但以下内容不能冒充为已完成的生产证明：

- MiMo 不支持 Native Compaction；Native Adapter 和 Capability Gate 有自动化合同测试，但尚未用一个真实支持 `/responses/compact` 的 Provider 做线上 replay 测试。
- 可选的第二模型语义 Reviewer 尚未默认启用；当前激活门以 Schema、精确状态、原子关系、Token 和 Chunk Coverage 的确定性校验为主，并以离线/真实连续性 Eval 补充。
- Provider 明确返回 Context Overflow 后的“最多一次、不重复副作用工具”紧急重试尚未接入 Runner；当前行为是安全失败，不会自动重跑整个 Tool Loop。
- 多进程 PostgreSQL Worker 崩溃、Lease 过期后的迟到提交、Redis/S3 故障仍需真实基础设施测试；当前并发和冲突自动化使用 SQLite 多任务模拟。
- MiMo 未提供价格，本次 Summary 成本状态为 `unpriced`；Token 用量已记录。

这些边界不影响本次 MiMo Portable Compaction 的实际成功结论，但它们决定了不能把当前结果描述成“所有 Provider、所有基础设施故障均已验证”。
