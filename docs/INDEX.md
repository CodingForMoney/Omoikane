# AgentSDK 文档索引

> 文档类型：导航与治理
> 状态：现行
> 最后核对：2026-08-26
> 适用版本：AgentSDK `0.1.0`、`openai-agents==0.22.0`、数据库迁移 `0006`

## 从哪里开始

不同读者不需要按文件编号从头读到尾：

| 目标 | 推荐阅读顺序 |
|---|---|
| 第一次运行系统 | [README](../README.md) → [运行、API 与部署](03-operations.md) → [Agent 角色定义](11-agent-role-definitions.md) |
| 接入业务 Agent 平台 | [范围与支持矩阵](01-scope.md) → [运行、API 与部署](03-operations.md) → [Provider 注册中心](08-provider-registry.md) → [Agent 角色定义](11-agent-role-definitions.md) |
| 理解系统实现 | [总体实现架构](02-implementation-design.md) → [架构决策与 Backlog](05-review-decisions-and-backlog.md) |
| 调试长上下文 | [Compaction 设计](06-context-compaction-design.md) → [实现报告](07-context-compaction-implementation-report.md) → [100K 实验](10-context-compaction-100k-experiment.md) |
| 核对模型能力 | [Provider 注册中心](08-provider-registry.md) → [Context Window 目录](09-model-context-catalog.md) |

## 现行规范与使用文档

这些文档描述当前应当依赖的合同。若文档与可执行代码或 OpenAPI 不一致，以代码、数据库迁移和运行时 OpenAPI 为准，并修正文档。

| 文档 | 作用 |
|---|---|
| [01-scope.md](01-scope.md) | 冻结范围、SDK 与平台职责边界、逐项验收标准 |
| [02-implementation-design.md](02-implementation-design.md) | 当前总体架构、领域模型、状态机与实现约束 |
| [03-operations.md](03-operations.md) | 快速上手、配置、迁移、REST/SSE 和生产运行边界 |
| [08-provider-registry.md](08-provider-registry.md) | Provider、模型目录、协议、Reasoning Effort 和凭据合同 |
| [09-model-context-catalog.md](09-model-context-catalog.md) | Context Window 字段语义、默认目录和覆盖规则 |
| [11-agent-role-definitions.md](11-agent-role-definitions.md) | `AGENT.md`、全局默认、平台策略和不可变版本 |
| [12-openai-agents-sdk-0.22-upgrade.md](12-openai-agents-sdk-0.22-upgrade.md) | SDK `0.19.4` → `0.22.0` 的依赖、兼容边界和验收记录 |

## 架构决策与专题设计

| 文档 | 状态与用途 |
|---|---|
| [05-review-decisions-and-backlog.md](05-review-decisions-and-backlog.md) | 当前决策和遗留问题；其中明确标注的旧实现只保留为决策背景 |
| [06-context-compaction-design.md](06-context-compaction-design.md) | 已接受并实现的 Compaction 设计；用于解释算法和不变量 |

## 验收与实验快照

这些文件记录某个日期、某个代码版本和某个 Provider 环境下的事实。它们是可审计证据，不是动态的“当前状态页”，其中的测试数量、耗时、模型响应和限制不会随代码自动更新。

| 文档 | 快照日期 | 说明 |
|---|---:|---|
| [04-validation.md](04-validation.md) | 2026-08-10 | 首轮本地合同、Docker Sandbox 和 MiMo Provider 实测 |
| [07-context-compaction-implementation-report.md](07-context-compaction-implementation-report.md) | 2026-08-10 | Compaction 实现与连续性验证 |
| [10-context-compaction-100k-experiment.md](10-context-compaction-100k-experiment.md) | 2026-08-10 | 100K 上下文复制、压缩与状态修复复测 |

## 事实来源优先级

发生冲突时按下列顺序判断：

1. 可执行代码、`pyproject.toml`/`uv.lock`、Alembic 迁移和运行时 `/openapi.json`。
2. 本索引中列出的现行规范与使用文档。
3. 架构决策记录；最新且明确标为“已接受”的决策优先。
4. 带日期的验收与实验快照。
5. 外部调研材料。上游能力可能变化，必须回到官方资料重新核对。

## 维护规则

- 现行文档必须包含“文档类型、状态、最后核对、适用版本”。
- 历史实验数据不回写成新结果；新验证应增加新小节或新快照，并更新本索引。
- API 的完整事实来源是服务启动后的 `/openapi.json` 和 `/docs`，Markdown 只维护主工作流和关键语义。
- OpenAI Agents SDK 升级、迁移 head 变化、Provider 合同变化或核心状态机变化时，必须同步检查现行文档。
- 提交前运行 `uv run python scripts/check_docs.py`，检查内部链接、文档索引、官方旧路径、锁定版本、迁移 head 和 `.env.example` 配置覆盖。
