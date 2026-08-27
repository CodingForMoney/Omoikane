# Context Compaction

> 实现：`src/compaction.ts`；Checkpoint Schema v3

操作方式见[开发者手册的 Context Compaction 章节](DEVELOPER_GUIDE.md#11-context-compaction)；未完成评测和 Native adapter 统一记录在[生产就绪清单](PRODUCTION_READINESS.md)。

## 1. 核心结论

上下文压缩不是删除聊天记录，也不是长期记忆。Omoikane 保留完整 Canonical Transcript，额外生成模型输入用的 Context Projection：

```text
Canonical Transcript = 不可变原始 Session Items
Active Projection     = Checkpoint + 未压缩最近尾部
Long-term Memory      = 独立 Scope/生命周期的数据
```

前端恢复聊天使用 Transcript；下一次模型调用使用 Projection；Memory retrieval 在 Run preflight 独立执行。没有 Memory Flush。

## 2. 触发

每次带 Session 的 Run 在模型调用前估算：

```text
estimated_tokens = bytes(JSON(effective_items))/3 + bytes(current_input)/3
high_watermark   = context_window × high_watermark_ratio
low_watermark    = context_window × low_watermark_ratio
```

默认 high `0.82`、low `0.55`、保留最近 `16,000` tokens、单个摘要 chunk 上限 `32,000` 估算 tokens。当前估算器是偏保守的 UTF-8 字节近似，不是 Provider tokenizer；Provider 目录提供 `model_context_window` 默认值，Agent 仍可覆盖。`current_input` 在触发判断和压缩后的低水位校验中使用同一次估算，不会出现“判断时没算、执行时才加入”的偏差。

## 3. Portable 压缩流程

1. 读取 Session revision 和全部 raw items。
2. 根据低水位扣除当前输入、Checkpoint 预算和安全余量，再从尾部累计 `preserve_recent_tokens`；最近尾部不能挤破低水位。
3. 按 Session item 边界切分较早历史；超大单项带少量 overlap 切分。`chunk_tokens` 默认 `32,000`，且不会超过模型窗口的一半。
4. 使用同一 Provider/Model 生成结构化结果：`summary`、`decisions`、`constraints`、`open_questions`、`artifacts`。
5. 多 chunk 时，若全部局部摘要可放入 Checkpoint 预算，确定性无损合并；超出预算才分批、分层调用模型合并。合并提示明确要求覆盖每个编号 Checkpoint。
6. 验证结构、非空、所有 chunk 已处理、压缩有效且最终 Projection 不超过低水位。`force` 只跳过高水位触发条件，不能跳过这些安全校验。
7. 在事务中锁 Session，使用 revision 做 CAS。
8. 保存 Compaction、创建 Projection、supersede 旧 Projection、切换 active revision。
9. Run preflight 自动压缩时写 `context.compacted` Event。

结构化摘要按 Provider 能力协商：支持原生 Structured Output 时使用严格 `json_schema`；OpenAI-compatible Provider 使用 `json_object` 并在 Runtime 中做 schema 校验；其他 Provider 使用明确 JSON prompt。若兼容端拒绝 JSON 模式，会回退到 prompt JSON，但解析失败、字段缺失或类型错误仍会使压缩失败，不切换 Projection。MiMo Responses 的实际接口不支持 `json_schema`、支持 `json_object`，live E2E 已覆盖该路径。

Checkpoint 作为普通 user input item 注入：

```xml
<context_checkpoint version="3">
Summary...

Decisions:
- ...
</context_checkpoint>
```

## 4. 不变量

- `session_items` 不因压缩被删除或改写。
- Projection 保存 `source_from_seq`、`source_to_seq`、`source_revision`、checksum 和 metrics。
- 读取 Projection 前校验规范化 JSON checksum；不匹配时退回 Canonical Transcript，restore 则拒绝执行。
- 压缩期间 Session 有新写入时，CAS 失败，不覆盖新内容。
- 摘要失败、为空或效果差时不切换 Projection。
- `pop` 或 `clear` 等破坏性 Session 编辑会使关联 Compaction/Projection 失效，并清除 active revision。
- 恢复操作只切换 Projection 状态，不重建 Transcript。
- 压缩不写 Memory；Memory consolidation 不依赖压缩事件。

## 5. API

```text
POST /v1/sessions/:id/compact
GET  /v1/sessions/:id/compactions
GET  /v1/sessions/:id/compactions/:compactionId
POST /v1/sessions/:id/compactions/:compactionId/restore
GET  /v1/sessions/:id/context-preview
```

`dry_run=true` 生成摘要和 metrics 但不切换 Projection。API 默认 `force=false`，只有达到高水位才执行；显式 `force=true` 适合测试或运维，但仍执行 schema、有效性、低水位、checksum/CAS 等校验。

主要 metrics 包括 `source_chunk_count`、`all_chunks_processed`、`merge_levels`、`tail_tokens`、`current_input_tokens`、`effective_tokens_after`、高低水位、`projection_within_low_watermark` 和 `summary_schema_valid`。这些字段描述可验证的处理事实，不把模型摘要的语义正确性伪装成布尔“完整覆盖”。

## 6. 与 Agents SDK 原生能力的关系

Agents SDK TypeScript 提供 Session 和与 Provider compaction 相关的可选接口，但 Omoikane 当前没有把数据库 Session 声明为原生 compaction-aware session。原因是平台需要跨 Provider、一致审计、可恢复 Projection 和 Canonical Transcript 不变量。

未来可以增加 Native engine，但必须满足：

- Provider capability 明确支持；
- 原生返回内容可持久化为 Projection；
- Usage/Cost 真实记录；
- 失败可回退 Portable；
- 不修改 Canonical Transcript；
- 与 Runtime Generation/RunState 兼容。

## 7. 验证证据

离线 Compaction 套件目前包含 12 项测试，覆盖自动触发与 Event 语义、非强制 API、Malformed JSON、Canonical/Projection/restore、checksum fallback、`pop`/`clear` 失效、跨 chunk 无损合并、并发 CAS 和无效压缩拒绝。

`npm run test:e2e:mimo` 通过真实 REST/SSE/Worker 和 MiMo v2.5 验证独立 Compaction：测试关闭 Memory retrieval 和 Focus，仅把随机事实放在 Session 中，压缩后 Canonical Transcript 不变，下一轮仍能回答该事实。当前完整套件为 5/5 通过。

`npm run test:e2e:compaction-100k` 是显式选择的高成本基准：构造超过 100K 估算 tokens 的上下文，将随机事实放在开头、中间和结尾，验证多 chunk、全部事实保留、Canonical hash 不变、有效 Projection 小于原始上下文的 20%、低水位成立，并继续发起一次真实模型 Run。2026-08-27 的 MiMo v2.5 实测在修复跨 chunk 合并后通过，整条测试约 31 秒。

这些证据显著提高了可信度，但不等于“任意内容完全可靠”。模型局部摘要仍是有损、概率性的；重复压缩漂移、对抗性 prompt、多 Provider/语言/代码任务评测、真实 tokenizer、故障注入和 Native adapter 尚未完成，统一记录在[生产就绪清单](PRODUCTION_READINESS.md)。
