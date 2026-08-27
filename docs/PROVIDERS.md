# Provider、模型与上下文目录

> 实现事实来源：`src/providers.ts`；目录最后核对：2026-08-27

本文统一说明 Provider Registry、协议、模型同步、Reasoning Effort、上下文默认值和 Secret。创建流程见[开发者手册](DEVELOPER_GUIDE.md#2-provider-先于-agent)。

## 1. 资源模型

```text
Provider Definition
  └── Endpoint Profile + Protocol + Known Model Capabilities
Provider Connection
  └── selected Provider/Profile + encrypted key/env ref + settings
Provider Model
  └── model_id + context/output/reasoning/vision/structured capability
Agent Version
  └── connection_id + model_id + optional overrides
```

Provider Definition 是代码内版本化 Catalog；Provider Connection 是数据库资源；Provider Model 是连接下同步或手工添加的模型记录。Agent 不设置任意 URL，只有 `custom_openai_compatible` 允许 `custom_base_url` 和 `custom_protocol`。

## 2. 协议与内置 Provider

| Protocol | Adapter |
|---|---|
| `responses` | OpenAI Agents `OpenAIProvider`，Responses API |
| `chat_completions` | OpenAI Agents `OpenAIProvider`，Chat Completions |
| `anthropic` | Agents AI SDK adapter + Anthropic provider |
| `google_gemini` | Agents AI SDK adapter + Google Generative AI provider |

当前 Catalog 内置 28 个 Provider，覆盖 OpenAI、Anthropic、Google、xAI、Mistral、Cohere、Groq、Together、OpenRouter、Perplexity、Cerebras，以及 MiMo、DeepSeek、Qwen、智谱、Kimi、火山 Ark、百度、腾讯、MiniMax、SiliconFlow、StepFun、百川、零一万物、讯飞、ModelScope 和本地 Codex Bridge。

## 3. 模型同步

- OpenAI-compatible：`GET /models`；
- Anthropic：Anthropic `/models`；
- Gemini：Google `/models`；
- 远程没有返回结果时回退 Catalog。

同步结果只可靠表示“当前可见的模型 ID”。多数 `/models` 不提供准确上下文、最大输出、Vision、Structured Output 或 Effort，因此这些能力来自版本化 Catalog 或用户覆盖，不能从一个通用 endpoint 推断。

## 4. Reasoning Effort

Effort 是模型能力，不是 API 协议的统一保证。UI 必须读取模型 capability：

```json
{
  "supported": true,
  "effort_values": ["none", "low", "medium", "high"],
  "adapter": "reasoning_effort"
}
```

不支持时不展示选择器；服务端仍会拒绝非法值。平台字段：

```yaml
model_settings:
  reasoning_effort: high
```

在 Run 前映射为 SDK `modelSettings.reasoning.effort`。Provider 枚举不同的情况下由 `value_map` 转换。

## 5. 上下文默认值

下表用于 UI 初始值和 Compaction 水位。用户仍可通过 `model_context_window` 覆盖。

| Provider | 模型示例 | 默认上下文 tokens | 备注 |
|---|---|---:|---|
| OpenAI | `gpt-5.6-sol` / `terra` / `luna` | 1,050,000 | Catalog 默认 |
| OpenAI | `gpt-5.4` | 1,050,000 | Catalog 默认 |
| OpenAI | `gpt-5.4-mini` | 400,000 | Catalog 默认 |
| Codex Bridge | `gpt-5.6-sol` / `gpt-5.6-luna` | **258,400** | 本地 Bridge 明确约定 |
| Xiaomi MiMo | `mimo-v2.5` / `mimo-v2.5-pro` | 1,048,576 | Token Plan/PAYG profile |
| Anthropic | Claude Opus/Sonnet 5、4.6 | 1,000,000 input | input window |
| Anthropic | Claude Haiku 4.5 | 200,000 input | input window |
| Google | Gemini 3.x | 1,000,000 input | output 默认 64K |
| xAI | `grok-4.3` | 1,000,000 | Catalog 默认 |
| xAI | `grok-4.5` | 500,000 | Catalog 默认 |
| Mistral | large/small latest | 256,000 | Catalog 默认 |
| Groq | `openai/gpt-oss-120b` 等 | 131,072 | 模型输出上限不同 |
| DeepSeek | v4 pro/flash | 1,000,000 | Catalog 默认 |
| Alibaba Qwen | Qwen 3.6/3.7/3.8 常见模型 | 1,000,000 | Catalog 默认 |
| Zhipu | `glm-5.2` | 1,000,000 | 其他常见 GLM 为 200K |
| Moonshot/Kimi | K2.5/K2.6/K2.7 | 262,144 | Catalog 默认 |
| MiniMax | M2.1/M2.5/M2.7 | 204,800 | Catalog 默认 |
| StepFun | Step 3.5 Flash | 262,144 | Catalog 默认 |
| Cohere | Command A Plus | 128,000 | Command A 为 256K |

解析规则：

```text
effective_context_window = Agent override ?? model catalog default ?? 128000
```

覆盖是为自定义部署、实验额度和 Catalog 更新滞后准备的，不代表 Provider 一定接受该长度。输出上限不是上下文窗口；目录用 `context_window_type` 区分 total context 与 max input。

## 6. Secret

推荐使用 `api_key_env`，由 Worker 环境提供真实值。直接提交 `api_key` 时，Runtime 使用 `AGENT_RUN_STATE_SECRET` 派生密钥并以 AES-256-GCM 保存；API 只返回 key hint，不返回明文或密文。

该加密可以防止数据库单独泄漏直接暴露 Key，无法抵御数据库和应用主密钥同时泄漏。`.env` 被 Git 忽略，`.env.example` 只保留空占位，测试日志和 npm tarball 必须经过 Secret scan。

## 7. 维护规则

1. Provider 官方文档或实际 endpoint 优先，第三方聚合列表只作线索。
2. 修改目录时记录核对日期，并测试 UI 默认值、Effort 显隐、服务端校验和 Compaction 水位。
3. 远程发现的新模型可以手工添加 capability，不能仅凭模型名称猜测上下文和 Effort。
4. Provider 目录的来源管理和自动漂移检测仍列在[生产就绪清单](PRODUCTION_READINESS.md)。
