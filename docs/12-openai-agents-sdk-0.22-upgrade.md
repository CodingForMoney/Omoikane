# OpenAI Agents SDK 0.22.0 升级记录

> 文档类型：升级与兼容性记录
> 状态：现行
> 最后核对：2026-08-26
> 适用版本：AgentSDK `0.1.0`、`openai-agents==0.22.0`、数据库迁移 `0006`

## 1. 升级范围

本次把 Python OpenAI Agents SDK 从 `0.19.4` 升级到 `0.22.0`，并同步更新底层依赖：

- `openai>=3,<4`；当前锁定 `3.3.1`。
- `mcp>=1.19,<2`；第一轮保持 MCP Python SDK v1，避免把 MCP Server API 迁移混入本次升级。
- OpenAI Python v3 引入的 HTTPX2 由锁文件管理；平台自己的普通 HTTP Provider 探测仍使用 `httpx`。

SDK 版本不再写死在业务代码中。健康检查、新 Run 和暂停状态都读取已安装 distribution 的真实版本；RunState 仍要求 SDK 版本和平台格式版本完全匹配，不静默跨版本恢复。

## 2. 上线边界

升级前核对本地业务库：15 个 Run 已完成、2 个失败、`run_states` 为 0，因此没有遗留的 `0.19.4` 审批暂停状态。其他环境上线前必须单独查询：

```sql
SELECT status, count(*) FROM runs GROUP BY status;
SELECT count(*) FROM run_states;
```

若存在 `running`、`waiting_approval` 或 `run_states` 记录，必须先排空或完成专门的跨版本恢复验证。历史已完成 Run 的 `sdk_version` 保持原值，新 Run 写入 `0.22.0`。

## 3. 平台调整

- `ModelSettings.timeout` 默认继承 Provider Connection 的调用超时，覆盖一次完整模型调用尝试。
- `ModelSettings.preserve_raw_usage=true`，在 SDK/Adapter 支持时保留 Provider 原始 Usage。
- Native Responses Compaction 读取 `CompactedResponse.usage`，记录真实输入和输出 Token，并进入压缩成本估算。
- MiMo Provider 回归中的 Portable Summary 输出预算调整为 8192 Token；这是摘要任务的独立预算，不影响普通 Agent Run。4096 Token 实测出现 `finish_reason=length` 时平台保持 Hard No-op。
- MCP 固定在 v1 后，原有 stdio、SSE 和 Streamable HTTP 配置无需变化。MCP v2 作为独立升级处理。

## 4. 验收要求

每次升级必须通过：

1. `uv lock --check`；
2. Ruff；
3. 完整 pytest；
4. 文档一致性检查；
5. MiMo Responses/Chat Completions、流式、Session、工具和审批恢复；
6. codex-bridge Responses、流式、Reasoning 与结构化输出。

## 5. 2026-08-26 实际验收结果

- 本地测试：`58 passed`；Ruff、锁文件一致性和文档检查通过。
- MiMo `mimo-v2.5`：Responses 与 Chat Completions 流式调用、多轮 Session、结构化输出、Function Tool、审批暂停/恢复全部完成；普通 Run 没有额外设置输出 token 上限。
- MiMo Portable Compaction：canonical transcript 压缩前后均为 41 条且内容完全不变；运行时投影由 41 条降为 12 条；5 项 UUID、路径、安全约束、当前任务和未决问题语义检查全部通过。本次升级回归样本估算由 4,994 降为 4,140 tokens，摘要 Provider Usage 为 7,859 输入、6,546 输出。
- codex-bridge：使用本机 `127.0.0.1:3456` 的 Responses 接口完成真实 Run，输出 `CODEX-BRIDGE-022-OK`，记录 219 输入、24 输出 tokens，新 Run 的 `sdk_version` 为 `0.22.0`。

第一次 MiMo 压缩回归使用 4,096 的摘要输出预算，Provider 返回 `finish_reason=length`；平台没有提交不完整摘要，canonical transcript 未被修改。提高该测试的独立摘要预算到 8,192 后通过。这里的 4,096/8,192 都不是普通对话的生成上限。

官方 Compaction 返回对象包含独立 Usage；参考 [OpenAI Compact a response](https://developers.openai.com/api/reference/java/resources/responses/methods/compact)。
