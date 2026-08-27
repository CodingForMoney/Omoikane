# 模型 Context Window 能力目录与自动注入

> 文档类型：现行能力目录合同
> 状态：现行字段语义；内置模型数值为带日期快照
> 最后核对：2026-08-26
> 适用版本：AgentSDK `0.1.0`、Provider 迁移 `0005` 及后续版本

## 1. 结论

Agent 创建界面会为已知模型自动填入准确的 Context Window 默认值，同时允许用户修改。平台按以下优先级获得最终配置，并在创建不可变 `AgentVersion` 时写入快照：

1. 用户在 Agent 配置中明确填写的值；
2. Provider `/models` 返回且字段语义明确的远端默认值；
3. AgentSDK 版本化内置默认值；
4. 无可靠数据时保持空值，不猜测、不继承上一个模型的值，由用户自行填写。

如果 Agent 启用了 Context Compaction，而模型没有默认值且用户也没有填写，版本创建会被拒绝。动态路由和手工添加的模型不会获得虚假的默认窗口，但用户可以根据实际下游模型自行配置。

## 2. 能力字段语义

`provider_models.capabilities_json` 使用下列字段：

| 字段 | 语义 |
|---|---|
| `context_window` | 厂商声明的总上下文窗口；为兼容旧配置，输入上限型模型也保留同值用于展示 |
| `max_input_tokens` | 厂商单独声明的最大输入 Token；优先于 `context_window` 参与输入预算 |
| `max_output_tokens` | 单次生成输出上限；不是普通 Run 的默认生成预算 |
| `context_window_type` | `total` 表示输入与输出共享总窗口；`input` 表示该值是独立输入上限 |
| `dynamic_context` | 当前模型 ID 是路由器，实际窗口取决于被路由的下游模型 |
| `capability_source` | `catalog` 或 `remote` |
| `capability_verified_at` / `capability_observed_at` | 内置目录核对时间或远端观测时间 |

AgentVersion 的 `compaction.context_window_source` 记录最终窗口来自 `user` 还是 `model_capability`。该字段用于诊断，不影响运行时预算。

对于 `context_window_type=input`，压缩高水位不会再次扣除输出预算；摘要输入预算也只扣摘要 Prompt 预留和安全余量。对于 `total`，平台继续从总窗口扣除输出预算。这避免 Anthropic、Gemini 等输入上限型 API 被重复预留输出 Token。

## 3. 2026-08-10 内置默认值

表中 `1M` 采用厂商公布的十进制值；`128K/256K` 若厂商使用二进制规格则保存为 `131072/262144`。未列出的同步模型保持未知，等待远端元数据或下一版目录更新。

| Provider | 内置模型 | 输入/总窗口 | 最大输出 | 类型 |
|---|---|---:|---:|---|
| OpenAI | `gpt-5.6-sol` / `terra` / `luna` | 1,050,000 | 128,000 | total |
| OpenAI | `gpt-5.4` | 1,050,000 | 128,000 | total |
| OpenAI | `gpt-5.4-mini` | 400,000 | 128,000 | total |
| Codex Bridge | `gpt-5.6-sol` / `luna` | 258,400 | 128,000 | total |
| Anthropic | Claude Opus/Sonnet 5、Opus/Sonnet 4.6 | 1,000,000 | 远端优先 | input |
| Anthropic | Claude Haiku 4.5 | 200,000 | 远端优先 | input |
| Gemini | 3.1 Pro Preview、3 Flash Preview、3.1 Flash Lite | 1,000,000 | 64,000 | input |
| Cohere | Command A+ 05-2026 | 128,000 | 64,000 | total |
| Cohere | Command A 03-2025 | 256,000 | 未知 | total |
| xAI | Grok 4.3 / 4.5 / Build 0.1 | 1,000,000 / 500,000 / 256,000 | 未知 | total |
| Mistral | Large / Small / Codestral latest | 256,000 / 256,000 / 128,000 | 未知 | total |
| Groq | GPT-OSS 120B / Qwen 3.6 27B / MiniMax M2.7 | 131,072 / 131,072 / 196,608 | 65,536 / 16,384 / 131,072 | total |
| Together | GPT-OSS 120B / 20B | 131,072 | 未知 | total |
| Perplexity | Sonar / Sonar Pro | 128,000 / 200,000 | 未知 | total |
| Cerebras | GPT-OSS 120B | 131,072 | 40,960 | total |
| MiMo | v2.5 / v2.5 Pro | 1,048,576 | 32,768 / 131,072 | total |
| DeepSeek | V4 Pro / V4 Flash | 1,000,000 | 未知 | total |
| Qwen | 3.8 Max Preview、3.7 Max/Plus、3.6 Flash | 1,000,000 | 未知 | total |
| GLM | 5.2 | 1,000,000 | 128,000 | total |
| GLM | 5.1 / 5 / 4.7 | 200,000 | 128,000 | total |
| Kimi | K2.7 Code / K2.6 / K2.5 | 262,144 | 未知 | total |
| Baidu | ERNIE 4.5 Turbo 128K / X1.1 Preview | 128,000 / 64,000 | 未知 | total |
| MiniMax | M2.7 / M2.5 / M2.1 | 204,800 | 未知 | total |
| StepFun | 3.5 Flash / 3.5 Flash 2603 | 262,144 | 未知 | total |
| Baichuan | Baichuan3 Turbo 128K | 131,072 | 未知 | total |
| Spark | 4.0 Ultra | 32,768 | 32,768 | input |

火山方舟 `ark-code-latest`、StepFun `step-router-v1` 和 Spark `spark-x` 标记为 `dynamic_context=true`，不提供单一固定默认值，但创建 Agent 时允许用户填写。豆包、腾讯混元、零一万物以及只通过 SiliconFlow/ModelScope/OpenRouter 暴露的任意下游模型，如果远端目录没有明确能力字段，也不会填入猜测值。

已经停止服务、已被替换或容易产生歧义的别名不再作为新连接的默认种子，包括 `deepseek-chat`、`deepseek-reasoner`、`grok-latest`、`qwen-max`、`qwen-plus`、`moonshot-v1-auto`、`generalv3.5` 等。历史 AgentVersion 不会被改写；旧的 builtin 模型记录在启动回填时标记为 `unavailable`。

## 4. 远端同步与合并规则

模型同步不是整份 JSON 覆盖：

- `manual` 模型记录由用户维护，同步不覆盖其能力；
- `builtin` / `discovered` 记录使用“内置目录为基线、远端非空字段优先”的递归合并；
- 远端缺少某个字段不会把已有可靠值清空；
- Anthropic、Gemini、Cohere、Mistral、Together、Groq、OpenRouter 使用专用解析器；
- 通用 OpenAI `/models` 通常只提供 ID，因此只做模型发现，不虚构上下文能力；
- 远端观测值记录 `capability_source=remote` 与观测时间。

启动时会刷新现有 `builtin` 记录的目录值、停用已从目录移除的旧 builtin，并在当前默认模型失效时按最新目录顺序选择一个可用默认模型。已发布 AgentVersion 保存的是创建当时的能力快照，因此目录升级不会悄悄改变其压缩阈值。

## 5. Agent 与 Demo 行为

Demo 选择模型时把目录值预填到 Context Window 输入框，用户可以修改；切换到未知模型时输入框会清空，不会继承上一个模型的值。`ProviderService.apply_model_defaults()` 对用户值和默认值使用相同的校验与快照流程：

```json
{
  "context_window": 1000000,
  "context_window_source": "user",
  "max_input_tokens": 1000000,
  "context_window_type": "input",
  "summary_context_window": 1000000,
  "summary_context_window_type": "input",
  "summary_max_input_tokens": 1000000
}
```

用户没有提交 `context_window` 时，SDK 才从模型能力填入默认值，并把来源记录为 `model_capability`。用户覆盖输入上限型模型时，`max_input_tokens` 会同步使用用户值，确保压缩预算确实按修改后的窗口计算。该快照在 Registry 校验和配置哈希计算之前完成；REST 客户端即使绕过 Demo，也执行相同规则。

## 6. 维护规则与资料

- 每次更新目录都应记录核对日期，并以厂商官方模型文档为主。
- 模型别名会漂移；能从 `/models` 获得明确数字时以连接实测为准。
- `max_output_tokens` 只描述上限，不应自动作为每轮 Run 的硬生成预算。
- 路由模型只有在 Provider 能返回最终下游模型及其能力时，才可以自动给出默认值；当前行为是不猜测，但允许用户显式配置。

主要资料：[OpenAI 模型目录](https://developers.openai.com/api/docs/models)、[Anthropic Models API](https://docs.anthropic.com/en/api/models-list)、[Gemini Models API](https://ai.google.dev/api/models)、[Mistral Models API](https://docs.mistral.ai/api/endpoint/models)、[OpenRouter Models API](https://openrouter.ai/docs/api/reference/list-available-models)。其他厂商入口见 [Provider 注册中心](08-provider-registry.md)。
