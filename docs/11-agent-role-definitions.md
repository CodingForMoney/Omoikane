# Agent 角色定义、全局默认与平台策略

> 文档类型：现行角色定义合同
> 状态：现行
> 最后核对：2026-08-26
> 适用版本：AgentSDK `0.1.0`、角色定义迁移 `0006`

## 1. 设计结论

AgentSDK 采用类似 `CLAUDE.md` 的 Markdown 角色文档，但不照搬 Claude Code 的项目指令发现机制：

- `AGENT.md` 只描述某个 Agent 的身份、适用场景、职责、边界和少量必要覆盖。
- Provider、默认模型、运行限额、Compaction、Memory、Sandbox、审批、Tracing 等共同配置放在全局设置。
- 平台安全上限和禁止项属于强制策略，角色不能降低或绕过。
- 角色文档经类型校验和资源解析后，编译成不可变 `AgentVersion` 快照。
- 修改全局默认只影响此后编译的新版本；已发布版本不会漂移。
- 当前平台强制策略会在 Run 开始时再次执行，因此可以收紧历史版本的权限和上限。

最终优先级为：

```text
运行时平台强制策略 > 角色显式覆盖 > 已发布时的全局默认快照
Instructions = 全局 Instructions + 角色 Markdown 正文
```

角色文档通过 REST 提交，可以来自 Git 仓库、数据库、管理界面或调用方文件系统。SDK 不自行扫描业务项目目录，也不把角色定义耦合到某个固定路径。

## 2. 最小角色文档

```markdown
---
apiVersion: agentsdk/v1
kind: Agent
name: research-agent
displayName: Research Agent
description: 当任务需要证据核对和结构化研究时使用。
---

# 角色

你是一名严谨的研究助理。

# 工作方式

- 区分事实、推断和未知事项。
- 对关键结论说明依据。
- 不确定时明确说明，不编造结果。
```

`name` 是稳定 slug，只允许小写字母、数字、`_` 和 `-`。`description` 同时作为 Handoff 路由描述；Markdown 正文是这个角色特有的 Instructions。未声明的运行配置全部继承全局默认。

## 3. 可选覆盖

Frontmatter 是严格类型合同，未知字段直接拒绝，不会静默忽略。完整覆盖示例：

```yaml
---
apiVersion: agentsdk/v1
kind: Agent
name: code-reviewer
displayName: Code Reviewer
description: 审查代码正确性、安全性和可维护性。

model:
  providerConnection: provider-connection-uuid
  model: provider-model-record-uuid
  reasoningEffort: high

tools:
  inherit: true
  allow: [repository-search]
  deny: [production-deploy]

mcpServers:
  inherit: true
  allow: [github-mcp]

skills:
  inherit: true
  allow: [secure-code-review]

agents:
  handoffs:
    inherit: true
    allow: [research-agent]
  asTools:
    inherit: false
    allow: [test-runner-agent]

memory:
  enabled: true
  readScopes: [agent, project, global]
  writeMode: candidates
  maxRetrievedItems: 12

context:
  compaction:
    enabled: true
    strategy: auto
    triggerRatio: 0.75

runtime:
  maxTurns: 30
  maxToolCalls: 80
  maxDurationSeconds: 1200
  maxHandoffDepth: 4
  maxCostUsd: 2.5

sandbox:
  enabled: true
  profile: docker-default
  cpuLimit: 1.5
  memoryMb: 1024
  diskMb: 2048
  timeoutSeconds: 120
  networkEnabled: false

approvals:
  externalSideEffects: required
  destructiveOperations: required

output:
  mode: structured
  structuredOutputMode: prompt
  schema:
    type: object
    properties:
      summary: {type: string}
    required: [summary]

guardrails:
  inputBlockPatterns: []
  outputBlockPatterns: []

tracing:
  enabled: true
---
```

资源引用可使用稳定 slug；Provider 模型也可使用数据库记录 ID。编译器会把 Tool、MCP、Skill、Handoff 和 Agent-as-Tool 解析为不可变目标 ID。`inherit: true` 表示在全局允许列表上增删；`inherit: false` 表示从空列表开始。

## 4. 全局设置

每个 `tenant_id` 有一条 `agent_settings` 记录：

- `global_instructions`：所有 Agent 都必须获得的共同工作规则。
- `defaults_json`：默认 Provider/模型、资源绑定、Memory、Compaction、Runtime、Sandbox、Approval、Output、Guardrails 和 Tracing。
- `policy_json`：允许的 Provider、禁止的 Tool、运行上限、生产 Sandbox 要求和最低审批要求。
- `revision`：整条设置的乐观并发版本。
- `defaults_revision`：全局 Instructions 或默认配置变化时递增。
- `policy_revision`：平台策略变化时递增。

更新必须带 `expectedRevision`，避免两个管理端互相覆盖。设置变更写入 `audit_logs`。首次读取时，如果 Provider Registry 已有可用连接及默认模型，系统会自动选取为全局默认；否则角色编译会明确要求先完成 Provider 配置。

全局默认是发布时模板，不是运行时动态引用。平台策略不同：编译时先限制一次，运行时再对当前策略限制一次，确保收紧权限能够立即作用于旧版本。

## 5. 编译与不可变版本

编译过程为：

1. 解析 YAML Frontmatter 和 Markdown 正文。
2. 用 Pydantic 严格校验字段、枚举和数值边界。
3. 合并全局默认与角色显式覆盖，并记录每个顶层配置的来源。
4. 应用平台 Provider、Tool、Runtime、Approval 和生产 Sandbox 策略。
5. 解析 Provider/模型及 Tool、MCP、Skill、多 Agent 引用。
6. 从模型能力目录注入准确的 Context Window 和 Compaction 预算。
7. 生成 `effective_config`、`config_hash`、`defaults_revision` 和 `policy_revision`。
8. 发布时原样固化编译结果；预览哈希必须与已发布哈希相同。

`agent_versions` 同时保存：

- `definition_source`：规范化后的原始 Markdown 文档。
- `definition_json`：解析后的类型化角色定义。
- `overrides_json`：相对于全局默认的显式覆盖。
- `config_json`：Runner 实际使用的完整不可变配置。
- `global_defaults_revision`、`platform_policy_revision` 和 `config_hash`：审计与复现信息。

旧的 JSON AgentVersion API 继续可用，其 `definition_format` 为 `legacy_json`。新角色协议为 `agent_markdown_v1`。

## 6. REST API

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/v1/agent-settings` | 读取全局 Instructions、默认配置、平台策略及已解析默认模型 |
| `PUT` | `/v1/agent-settings` | 以 revision CAS 更新全局设置 |
| `POST` | `/v1/agent-definitions/validate` | 只校验和预览，不写 Agent 数据 |
| `POST` | `/v1/agents/from-definition` | 从角色文档创建逻辑 Agent 和 v1，可选择立即发布 |
| `POST` | `/v1/agents/{id}/versions/from-definition` | 为已有逻辑 Agent 创建下一不可变版本；文档 `name` 必须匹配 Agent slug |
| `GET` | `/v1/agents/{id}/versions/{version}/definition` | 导出源文档、显式覆盖和有效配置 |

最小请求体：

```json
{
  "document": "---\napiVersion: agentsdk/v1\nkind: Agent\nname: research-agent\ndescription: Research tasks.\n---\n\nYou are a research agent.\n",
  "publish": true
}
```

## 7. Demo 验证方式

Demo 将 Provider、全局设置和 Agent 角色分成三个独立入口：

1. 在“Provider 管理”保存连接、同步模型并设置 Provider 默认模型。
2. 在“全局设置”选择默认 Provider/模型，配置共同 Instructions 和运行默认值。
3. “创建 Agent”只需编辑 `AGENT.md`；模型、Context、Memory 等默认继承。
4. 只有确有差异时才开启模型、Reasoning Effort 或 Context Window 覆盖。
5. 选中已有 Agent 后点击“新建版本”，会读取当前版本角色文档并发布下一个不可变版本。

Reasoning Effort 选项继续由模型能力目录驱动；不支持的模型不会显示可选 Effort。Context Window 默认来自模型目录，但角色仍可显式覆盖。

## 8. 数据库迁移

迁移 `0006_agent_role_definitions.py` 创建 `agent_settings`，并扩展 `agent_versions` 的角色源文档、覆盖、revision 和格式字段：

```bash
uv run alembic upgrade head
```

生产环境必须关闭 `AGENT_AUTO_CREATE_SCHEMA`，只允许 Alembic 管理 Schema。早期开发库如果由 `create_all` 建表且没有 Alembic revision，必须先核对其 Schema 对应的迁移版本，再执行 `alembic stamp`；禁止在未核对时盲目 stamp。
