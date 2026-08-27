# 验收与 Provider 实测报告

> 文档类型：验收快照
> 状态：历史证据；不代表当前测试数量或当前上游 Provider 状态
> 最后核对：2026-08-26
> 适用版本：2026-08-10 验收代码、`openai-agents==0.19.4`、当日 MiMo Provider

本报告保留 2026-08-10 的可重复命令和已脱敏结果，数字不会随着当前代码自动更新。当前验证命令和状态见 [运行手册](03-operations.md) 与 [文档索引](INDEX.md)。任何 API Key 都不得写入本文件、Git、数据库明文或测试输出。

## 1. 本地合同测试

验收时间：2026-08-10（Asia/Taipei）。

```text
ruff check .                 All checks passed
pytest -q                    35 passed
uv lock --check              resolved and locked
docker compose config        valid
docker build                 agent-system:test built successfully
container import smoke       agent-system 0.1.0 / agents 0.19.4
```

当时的 35 个测试覆盖下列范围；凡涉及 Agent loop、工具、MCP、编排、Guardrail 或审批的测试，均使用真实 `openai-agents==0.19.4` Runner：

- Agent 注册、不可变版本、发布校验、Secret 拒绝和多 Agent 图校验。
- Responses 风格流式事件、数据库 Session、原生结构化输出和 Prompt 结构化输出。
- 输入 Guardrail、Function Tool、审批暂停/加密 RunState/恢复、审批过期。
- stdio MCP 的连接、健康检查、工具发现与实际调用。
- Agent-as-Tool 的实际委派执行；Handoff 装配合同。
- Compaction 的不可变 Transcript/Projection、Token 水位、System/Pending Tool 保护、Lease/CAS、失败无损、并发追加、Artifact 外置、Native Capability Gate、连续 5 次压缩和恢复。
- Memory Retrieval 只在 Model Call 前临时注入，不进入 Session Transcript 或 Compaction Checkpoint。
- 长期记忆写入/检索/去重/来源、凭据拒绝和 pgvector 字段。
- 版本化价格、成本上限、REST/SSE、Skill、Local Sandbox 和 Artifact。
- Alembic 从空库 upgrade/downgrade。

## 2. Docker Sandbox

基础镜像：`python:3.12-slim`，digest `sha256:229a2c5bfa27522db7815ea81f9bed70af17ccb9de9fc7ad142b1877b5830d36`。

`scripts/sandbox_smoke.py` 实测结果：

| 检查 | 结果 |
|---|---|
| 容器用户为 UID 65534 | 通过 |
| `/workspace` 可写 | 通过 |
| 根文件系统只读 | 通过 |
| 默认外网不可达 | 通过 |
| 测试容器结束后销毁 | 通过 |

## 3. 目标 Provider

目标：

```text
Base URL  https://token-plan-cn.xiaomimimo.com/v1
Model     mimo-v2.5
SDK       openai-agents 0.19.4
```

API Key 通过 `getpass` 无回显输入，只存在于测试进程环境；AgentVersion 只保存 `MIMO_API_KEY` 这个变量名。代码、数据库和报告均未写入明文 Key。普通 Agent Run 没有设置 `max_tokens`、`max_output_tokens` 或 `max_completion_tokens`；3.3 的结构化 Summary 单独使用 4096 Token 输出预算。

### 3.1 实测结果

| 能力 | 状态 | 关键证据 |
|---|---|---|
| Responses API 流式 | 通过 | 1 请求；49 input、311 output、360 total Token；116 字符输出；连续 delta 事件 |
| Chat Completions 流式 | 通过 | 1 请求；49 input、337 output、386 total Token；123 字符输出；连续 delta 事件 |
| Session 多轮 | 通过 | 第二轮准确返回首轮代号 `ORCHID-731`；2 请求、216 total Token |
| Function Tool | 通过 | 模型调用 `add(37.5, 4.25)`，工具结果为 `41.75`；存在 `tool.called/tool.completed` |
| 人工审批恢复 | 通过 | 首次运行进入 `waiting_approval`；审批后由持久化 RunState 恢复并完成 echo 调用 |
| Chat 原生 JSON Schema | 不兼容 | Provider 返回的 JSON 不完整，Agents SDK 抛出 `ModelBehaviorError`；平台正确标记 Run failed，并未接受非法输出 |
| Prompt JSON + 平台 Schema | 通过 | 返回并验证 `{"answer":"42","confidence":1}`；93 input、294 output、387 total Token |

两种协议的输出均远大于 16 Token，因此 Provider 调用链本身不存在“只能生成 16 Token”的问题。Responses 测试对“不少于 120 字符”的指令少了 4 个字符，但仍生成 311 个输出 Token；这属于模型指令遵循偏差，不是输出预算截断。

### 3.2 推荐配置

该 Provider 的普通文本、流式、Session、Function Tool 和审批链路可直接使用。结构化输出应配置：

```json
{
  "provider": {
    "type": "openai_compatible",
    "protocol": "chat_completions",
    "base_url": "https://token-plan-cn.xiaomimimo.com/v1",
    "api_key_env": "MIMO_API_KEY",
    "structured_output_mode": "prompt"
  }
}
```

若未来 Provider 修复原生 `json_schema` 兼容性，可用合同测试通过后切回 `native`。本次未提供 Provider 价格，因此用量已完整记账，实际货币成本保持未定价状态。

### 3.3 Context Compaction 实测

2026-08-10 使用相同 MiMo Provider 执行 `scripts/provider_e2e.py --compaction-only`：

| 检查 | 结果 |
|---|---|
| `/responses/compact` | 不支持；HTTP 400/404 NOT_FOUND |
| Responses `context_management` | 不支持；`responses_feature_not_supported` |
| 实际 Strategy | `portable` |
| Canonical Transcript | 41 项，压缩前后完全不变 |
| Active Projection | 41 项降到 11 项 |
| Token | 4,994 降到 2,043，降幅 59.0909% |
| Summary Usage | 4,845 input、1,622 output Token；输出预算 4,096 Token；耗时 49,241.216 ms |
| Validation | 0 error、0 warning；1/1 Source Chunk 覆盖；Memory Write 0 |
| 压缩后连续性 | UUID、绝对路径、安全约束、当前任务、未决问题 5/5 恢复 |
| 验证 Run Usage | 1,910 input、505 output、2,415 total Token |

完整数据、实现边界和可重复配置见 `docs/07-context-compaction-implementation-report.md`。

## 4. 安全说明

测试凭据此前已经出现在对话消息中。虽然实现没有把它写入项目，但仍建议在 Provider 控制台轮换该 Key，并用新 Key 作为正式部署 Secret。
