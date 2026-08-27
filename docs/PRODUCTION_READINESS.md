# 生产就绪清单

> 最后核对：2026-08-27

本文不是按日期追加的进度日志，只记录当前源码尚未完成的功能、验证和生产门槛。功能覆盖以[架构与能力矩阵](ARCHITECTURE.md#2-能力矩阵)为准；完成一项后应直接删除或更新对应条目，不保留流水账。

## 已有验证

- TypeScript typecheck、Vitest 离线合同测试、文档检查和 build；
- PGlite 下 Session、Run、审批、Event/Outbox 原子性、Tool 幂等和 Compaction；
- MiMo v2.5 live E2E：Provider/模型同步、`AGENT.md`、`SKILL.md`、Function Tool、stdio MCP、Session 恢复、长期记忆、独立 Compaction、Usage 和 Artifact；
- MiMo v2.5 100K+ Compaction 基准：开头/中间/结尾事实保留、Canonical hash、低水位、压缩率和压缩后继续对话；
- Docker Sandbox 基础 smoke test。

这些验证证明主链路可运行，但不能替代 PostgreSQL/S3/Docker/网络故障、安全和压测验证。

## P0：生产前必须完成

| 类型 | 未完成项 |
|---|---|
| 验证 | 在 PostgreSQL 下执行 Run claim、审批恢复、Event/Outbox 原子性和 migration 集成测试 |
| 验证 | Docker Sandbox 逃逸面、安全参数、超时、并发、孤儿容器和磁盘耗尽测试 |
| 验证 | S3/MinIO Artifact 大文件、失败重试、删除、校验和与权限测试 |
| 功能 | Provider Key/RunState 主密钥轮换和存量密文重加密流程 |
| 功能 | 未知模型价格从 `0 USD` 改为显式 `unpriced`，避免预算闸门误判 |
| 功能 | MCP `allowed_tools`、审批、结果大小和超时策略进入执行层 |
| 功能 | 所有 API body 使用完整 Zod/JSON Schema 验证，移除手工类型转换缺口 |

## P1：质量与可靠性

- 用真实 embedding + hybrid retrieval 替换确定性 hash embedding，并增加记忆候选、批准、冲突、过期和评估集；
- Compaction 扩展为多轮重复压缩、对抗性 prompt、多语言/代码任务、多 Provider 的事实覆盖率与关键约束评测，并增加真实 tokenizer、故障注入和 Provider Native adapter；
- SSE 从数据库轮询升级为 PostgreSQL LISTEN/NOTIFY 或 Redis 通知，数据库仍是事实来源；
- 统一写 API 的 `Idempotency-Key`，列表端点统一 cursor pagination；
- 增加深层 Handoff、MCP 断连、Guardrail tripwire 和结构化输出错误恢复测试；
- Webhook Worker 增加失租回收，签名增加时间戳和 replay window；
- Tracing 增加可插拔 exporter 和内容采集策略。

## P2：开发体验

- CLI 完整扫描 `omoikane.yaml`，支持 project validate/diff/publish/rollback；
- 生成完整 OpenAPI 文档和 Client 类型；
- Provider Catalog 增加来源、核对日期和自动漂移检测；
- Skill 增加 manifest schema、依赖声明、签名、策略审核和只读资源物化；
- Sandbox 增加镜像 allowlist、域名级 egress、快照和缓存。

## 生产放行条件

至少满足：P0 全部关闭；PostgreSQL 备份恢复演练通过；Provider/业务 MCP/S3/Docker socket 的 Secret 和网络边界审查通过；完成目标负载压测；建立事件、成本、失败率和队列积压监控；固定 npm 版本和镜像 digest；具备 Runtime Generation 升级与回滚演练记录。
