# MiMo 2.5：100K 上下文压缩实测

> 文档类型：实验快照
> 状态：历史证据；不代表当前 Provider 可用性或性能
> 最后核对：2026-08-26
> 适用版本：2026-08-10 验收代码、MiMo v2.5 当日环境

实验时间：2026-08-10
实验编号：`20260810083420`
模型：`mimo-v2.5`
压缩策略：`portable`
Token 估算器：`tiktoken:o200k_base`

## 结论

这次实验成功完成了 8 轮真实 MiMo 2.5 对话，形成 100,246 Token 的 Canonical Transcript；随后原子复制 3 份，只压缩其中 1 份。压缩后的模型投影为 25,410 Token，减少 74.65%，约缩小 3.94 倍。Canonical Transcript 在压缩前后的 SHA-256 完全一致。

压缩后继续调用 MiMo 2.5，模型准确且按原顺序恢复了全部 8 个 UUID。两个未压缩对照副本在实验结束后仍与原件完全一致。

首轮实测发现 checkpoint 把已经完成的第 6 轮 ACK 错误标成了未完成，而旧 validator 仍给出 `valid=true`。该问题随后完成修复和同一 100K Transcript 复测，结果见“状态正确性修复复测”。

## 实验设计

- 新建独立实验 Agent，固定使用托管 Provider 中的 `mimo-v2.5`，`reasoning_effort=none`。
- 自动压缩阈值设为 900,000 Token，确保构建 100K 原始样本时不会提前压缩。
- 每轮用户消息约 12.4K Token，并包含一个必须长期精确保留的 UUID；模型只回复对应 ACK。
- 原始会话达到约 100K 后，校验消息序列、全部 UUID、全部 ACK、Canonical/Projection 一致性和 Transcript 哈希。
- 使用 SDK 内部原子克隆能力复制 3 份。克隆只复制 Canonical Transcript，不复制 Context Projection。
- 保留两个 archive control；仅对第三份强制执行 portable compaction。
- 压缩后继续真实调用 MiMo，要求按首次出现顺序恢复全部 8 个 UUID。

## 原始对话与存储完整性

| 指标 | 结果 |
|---|---:|
| 真实对话轮数 | 8 |
| Canonical Items | 16 |
| Canonical Tokens | 100,246 |
| Projection Tokens（压缩前） | 100,246 |
| Transcript SHA-256 | `582fa70fe93e793a975f0ad885befc7ec5ffa5d019358729caff1786948cf51f` |
| 8 个 UUID 全部存在 | 是 |
| 8 个 ACK 全部正确 | 是 |
| Item Seq 连续 | 是 |
| 压缩前 Canonical 与 Projection 一致 | 是 |

原始 Session：`019feace-fa82-7375-bb59-ea8294d88fe6`

每轮完成后的 Canonical Token 数依次为：12,712、25,425、38,136、50,851、63,574、76,298、89,006、100,246。

## 三个副本

| 变体 | Session ID | 压缩前 Tokens | 与原件哈希一致 |
|---|---|---:|---|
| archive-control-1 | `019fead0-6926-79a6-8485-3ed79a886fd4` | 100,246 | 是 |
| archive-control-2 | `019fead0-6953-7762-94d2-92a633a751fd` | 100,246 | 是 |
| compressed-experiment | `019fead0-697e-78f1-bfcb-05f1d262f0ec` | 100,246 | 是 |

实验结束后，两个 archive control 的 Canonical 和 Projection 哈希仍与原始会话一致。

## 压缩结果

| 指标 | 结果 |
|---|---:|
| Compaction ID | `019fead0-69c1-7a92-a2d6-3c5b6ea25101` |
| 状态 | `active` |
| 策略 | `portable` |
| 压缩耗时 | 96.0 秒 |
| Projection Items | 16 → 6 |
| Projection Tokens | 100,246 → 25,410 |
| 减少 Token | 74,836 |
| 节省比例 | 74.65% |
| 缩小倍数 | 3.94× |
| Source Chunks | 1 |
| All Chunks Covered | 是 |
| Summary Input Tokens | 78,894 |
| Summary Output Tokens | 2,463 |
| Validator | `valid=true`，无 error/warning |
| Memory Writes | 0 |
| Canonical Transcript 改写 | 否 |

压缩只生成新的 Context Projection；Canonical Items 仍为 16，Token 仍为 100,246，SHA-256 仍为 `582fa70f…f51f`。

## 压缩后连续性

压缩后向同一个 Session 追加验证问题，MiMo 2.5 返回了全部 8 个 UUID：

- 每个 UUID 恰好出现一次。
- 顺序与首次出现顺序一致。
- 前 6 个 UUID 来自 portable checkpoint；最近两轮仍位于 raw tail。
- 原始 16 个 Canonical Items 的前缀哈希仍与压缩前完全相同。

验证调用完成后，压缩副本的 Canonical Transcript 正常追加为 18 Items、100,603 Token；模型投影为 8 Items、25,767 Token。

## Provider 实际用量

| 环节 | Requests | Input Tokens | Output Tokens |
|---|---:|---:|---:|
| 构建 8 轮 100K 对话 | 8 | 499,560 | 303 |
| 生成 checkpoint | 1 | 78,894 | 2,463 |
| 压缩后连续性验证 | 1 | 38,225 | 287 |
| 合计 | 10 | 616,679 | 3,053 |

构建一个 100K 的多轮会话并不只消耗 100K 输入，因为每一轮都会再次发送累计历史。这次 8 轮构建实际消耗约 499.6K 输入 Token。

Projection 的 25,410 Token 是 `o200k_base` 本地估算；连续性请求的 Provider 实际输入为 38,225 Token。差异来自模型实际 tokenizer、系统指令和协议序列化等开销，因此配额和成本控制应以 Provider 返回的 usage 为准，本地计数主要用于触发压缩和相对比较。

目前 MiMo 价格没有配置到 SDK Price Catalog，所以这次记录到完整 usage，但 `summary_cost=null`、`cost_status=unpriced`，不能报告可靠金额。

## 发现的问题

1. **任务状态发生语义错误。** Canonical Transcript 中第 6 轮用户消息后已经存在 `ACK-06`，但 checkpoint 的 `active_task` 仍把第 6 轮列为未完成，`completed_actions` 只列出 ACK-01 至 ACK-05。
2. **Validator 没发现上述错误。** 当前 validator 能验证 Schema、压缩收益、chunk 覆盖、精确标识符和工具调用原子性，但无法证明任务状态与原始 transcript 的因果关系一致。
3. **精确标识符提取存在噪声。** 除实验 UUID 外，一些看起来像 commit hash 的内部十六进制 ID 也被加入 `exact_identifiers`。这不会破坏正确性，但会浪费 checkpoint 空间。
4. **这次语义验证范围有限。** 实验证明了精确标识符连续性和 Transcript 不变性，没有证明长篇自然语言中的所有细节都能无损恢复。
5. **成本暂不可计算。** Usage 已记录，但 MiMo 单价表尚未配置。

## 状态正确性修复复测

根因包含三层：Tail Selector 按单个 Item 计数，可能把 User Request 与 Assistant Response 切到边界两侧；摘要模型自行推断完成状态；旧 Validator 只验证 Schema 和标识符，没有对照 Canonical Transcript。

修复内容：

- Tail Selector 改为按完整对话轮次选择：`User + Reasoning/Tool Chain + Assistant Response` 不可拆分。
- Checkpoint Schema 升级为 v2，新增 `execution_state.authority=runtime_derived`。
- Runtime 从 Canonical Transcript、Tool Call/Result 和 Approval Record 确定性生成 `execution_state`、`active_task`、`completed_actions` 和 `progress`，覆盖模型输出。
- Approval 状态加入 Snapshot Checksum；压缩期间状态变化会触发 CAS 冲突。
- Validator 逐字段比较 checkpoint 与 Runtime 派生状态；不一致时 Hard No-op，不激活 Projection。

使用未压缩 archive control 重新克隆并调用 MiMo 2.5：

| 指标 | 修复后结果 |
|---|---:|
| 复测 Session | `019febb4-843e-7040-98fe-ea07494c8876` |
| Compaction ID | `019febb4-8473-78dd-9b69-670ab311fa28` |
| 原始 Tokens | 100,246 |
| 压缩后 Tokens | 37,821 |
| Token 减少比例 | 62.27% |
| 压缩耗时 | 57.2 秒 |
| Schema / Engine | v2 / v2 |
| `execution_state_validated` | `true` |
| Checkpoint 覆盖范围 | Seq 1–10，5 个完整且已响应轮次 |
| Checkpoint Pending User | 0 |
| Raw Tail | Seq 11–16，第 6～8 轮全部成对保留 |

修复后没有强行把第 6 轮塞入 checkpoint，而是把第 6 轮 User 与 ACK-06 一起保留在 Raw Tail。压缩后继续真实调用 MiMo，返回：`ACK-06=<已完成>; PENDING=0`。

修复后的压缩率低于首轮 74.65%，因为原子边界要求额外保留一个完整的约 12K Token 轮次；这是用更大的 Raw Tail 换取正确任务状态的预期结果。完整测试为 55 项通过。

## 复现与原始结果

- 实验脚本：[context_compaction_100k_demo.py](../scripts/context_compaction_100k_demo.py)
- 机器可读结果：[context-compaction-100k-result.json](../var/reports/context-compaction-100k-result.json)
- 修复复测结果：[context-compaction-state-fix-retest.json](../var/reports/context-compaction-state-fix-retest.json)
- 修复复测脚本：[retest_context_compaction_state_fix.py](../scripts/retest_context_compaction_state_fix.py)

运行命令：

```bash
.venv/bin/python scripts/context_compaction_100k_demo.py
```

脚本和报告不会记录 Provider API Key。
