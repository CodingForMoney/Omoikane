# Provider 注册中心、模型目录与国内外厂商支持

> 文档类型：现行 Provider 合同
> 状态：现行；模型与远端能力必须按 Provider 实测重新核对
> 最后核对：2026-08-26
> 适用版本：AgentSDK `0.1.0`、Provider 迁移 `0005` 及后续版本

## 1. 已实现的边界

Provider 是 AgentSDK 的平台能力，不再由每个业务 Agent 重复配置 URL、协议和环境变量名。新建 AgentVersion 保存：

```json
{
  "provider_connection_id": "uuid",
  "provider_model_id": "uuid",
  "provider_options": {"structured_output_mode": "prompt"},
  "reasoning_effort": "high"
}
```

运行时由 `ProviderService` 原子解析 Connection、Model、凭据、固定端点、协议和能力元数据，再装配 OpenAI Agents SDK 的 `OpenAIResponsesModel`、`OpenAIChatCompletionsModel` 或 `LitellmModel`。旧版内嵌 `provider` 配置仍可运行；启动时会把可识别的环境变量连接导入注册中心，但不会改写不可变的历史 AgentVersion。

OpenAI、OpenAI-Compatible 与非兼容原生协议是三条不同运行路径。Anthropic、Google Gemini 使用 Agents SDK 官方扩展中的 LiteLLM 模型适配器；Cohere 使用其官方 OpenAI Compatibility API；其余本批国外厂商使用官方 OpenAI 兼容端点。LiteLLM 模型名称在运行时才添加 `anthropic/` 或 `gemini/` 前缀，数据库仍保存厂商原始模型 ID。

## 2. 数据与秘密

- `provider_connections`：租户内命名连接、厂商、端点配置档、固定 URL/协议、默认模型、状态、验证结果和连接参数。
- `provider_models`：连接下的远端模型 ID、来源、可用状态、最后发现时间和能力合同。
- API Key 二选一：一次性提交后使用 `AGENT_RUN_STATE_SECRET` 加域分隔符派生的 Fernet 密钥加密，或保存 `api_key_env` 引用。
- API 永不返回明文、密文和校验和，只返回 `has_credential`、来源与尾部提示。
- 普通内置厂商拒绝 `custom_base_url` 和 `custom_protocol`；只有 `custom_openai_compatible` 可设置。

加密存储能防止数据库文件单独泄漏直接暴露 Key，但不能抵御同时取得数据库与应用主密钥的攻击。生产环境优先使用外部 Secret Manager；轮换 `AGENT_RUN_STATE_SECRET` 前必须设计 Provider 凭据重加密流程。

## 3. REST API

| API | 作用 |
|---|---|
| `GET /v1/provider-definitions` | 内置厂商、端点配置档、种子模型和能力 |
| `POST /v1/provider-connections` | 用 Key 或环境变量引用创建连接，并默认自动验证和同步模型；可用 `sync_models=false` 跳过 |
| `GET/PATCH /v1/provider-connections/{id}` | 查看脱敏连接或轮换凭据/切换固定配置档 |
| `POST /v1/provider-connections/{id}/validate` | 调用厂商模型目录验证凭据并可同步模型 |
| `GET /v1/provider-connections/{id}/models` | 读取连接的模型目录 |
| `POST /v1/provider-connections/{id}/models` | 在 Provider 不提供 `/models` 时手工补录模型 |

创建 ProviderConnection 后会立即自动尝试模型发现。模型同步采用合并语义：新模型新增，仍返回的模型激活，历史上发现但本次消失的模型标记 `unavailable`，不会物理删除。厂商不支持 `/models`、环境变量凭据尚未注入或远端暂时不可用时，连接仍会保存为 `configured`，同步错误被记录，内置/手工模型继续可用；这避免把模型列表端点当成生成端点可用性的绝对证明。

Provider 与 Agent 使用两段式配置：先创建 ProviderConnection、同步模型并保存 `default_model`；再创建 AgentVersion，引用连接 ID 和一个具体的 ProviderModel 记录 ID。新连接优先使用该厂商的第一个内置种子模型作为默认模型；成功同步后，如果原默认模型不在远端目录中，则自动改为第一个可用的同步模型。启动时会为升级前已经存在但没有默认模型的连接做幂等回填。默认模型用于创建 Agent 时的初始选择，不会偷偷改写已经发布的不可变 AgentVersion。

## 4. 内置国外厂商

| Provider ID | 厂商 | 固定协议/适配器 | 端点配置档 |
|---|---|---|---|
| `openai` | OpenAI | Responses | OpenAI API |
| `anthropic` | Anthropic Claude | Agents SDK `LitellmModel` | Anthropic API |
| `google_gemini` | Google Gemini | Agents SDK `LitellmModel` | Google AI Gemini API |
| `cohere` | Cohere | Chat Completions | Cohere Compatibility API |
| `xai` | xAI Grok | Chat Completions | xAI API |
| `mistral` | Mistral AI | Chat Completions | Mistral API |
| `groq` | Groq | Chat Completions | Groq OpenAI-Compatible API |
| `together` | Together AI | Chat Completions | Together API |
| `openrouter` | OpenRouter | Chat Completions | OpenRouter API |
| `perplexity` | Perplexity | Chat Completions | Sonar API |
| `cerebras` | Cerebras Inference | Chat Completions | Cerebras API |

Anthropic、Gemini、Cohere、Mistral、Together、Perplexity 使用各自的模型目录响应解析器；其他兼容厂商使用 OpenAI SDK 的 `models.list()`。Together 的官方目录返回顶层数组，不是 OpenAI 的 `{data: [...]}`，因此不能只靠“OpenAI-compatible”假设。模型同步只把目录当作模型发现与凭据检查，不据此推断 Function Tools、视觉、结构化输出或 Effort。

## 5. 本地 Codex Bridge

`codex_bridge` 对接 [CodingForMoney/codex-bridge](https://github.com/CodingForMoney/codex-bridge) 的 OpenAI Responses 接口，固定入口为 `http://127.0.0.1:3456/v1`。它使用与其他 ProviderConnection 相同的加密 Key 存储，不读取或保存 Codex OAuth 凭据。

当前桥接项目 `0.1.4` 的能力合同如下：

- `GET /v1/models` 和 `POST /v1/responses`，模型固定为 `gpt-5.6-sol`、`gpt-5.6-luna`。
- Bridge 提供的两个模型均按其实际限制登记为 `258,400` tokens Context Window；该值独立于 OpenAI 官方直连模型的上下文规格。
- 支持 Responses SSE、函数工具与结果、图像 URL、结构化 `text.format`、Usage，以及 `none/low/medium/high/xhigh/max` reasoning effort。
- 请求必须是无状态模式；AgentSDK 强制 `store=false`，并依靠数据库 Session 重放完整历史，不使用 `previous_response_id` 或服务端 Conversation。
- 不支持 `/responses/compact`。自动压缩不会探测或调用原生 compact，而是使用同一个 Responses 端点生成 portable structured checkpoint；不会错误退回 Chat Completions。
- 不声明 OpenAI 托管工具、后台模式、文件输入和服务端会话能力。

固定 loopback 地址适用于 AgentSDK 与 Bridge 同机直接运行。若 AgentSDK 在容器中，`127.0.0.1` 指向容器自身；必须另行设计受控的宿主机入口，不能把 Bridge 在无网络边界的情况下直接暴露到局域网。

## 6. 内置国内厂商

| Provider ID | 厂商 | 固定协议 | 端点配置档 |
|---|---|---|---|
| `xiaomi_mimo` | 小米 MiMo | Responses | 中国 Token Plan、按量 API |
| `deepseek` | DeepSeek | Responses | 官方 API |
| `alibaba_qwen` | 阿里百炼 / Qwen | Chat Completions | 中国（北京）|
| `zhipu_glm` | 智谱 GLM | Chat Completions | 开放平台 |
| `moonshot_kimi` | Moonshot / Kimi | Chat Completions | 中国、国际 |
| `volcengine_ark` | 火山方舟 / 豆包 | Responses | 中国（北京）、Coding Plan |
| `baidu_qianfan` | 百度千帆 | Chat Completions | 千帆 v2 |
| `tencent_hunyuan` | 腾讯混元 | Chat Completions | OpenAI 兼容接口 |
| `minimax` | MiniMax | Chat Completions | 中国、国际 |
| `siliconflow` | 硅基流动 | Chat Completions | 中国 |
| `stepfun` | 阶跃星辰 | Chat Completions | 开放平台、Step Plan |
| `baichuan` | 百川智能 | Chat Completions | 官方 API |
| `lingyiwanwu` | 零一万物 | Chat Completions | 官方 API |
| `iflytek_spark` | 科大讯飞星火 | Chat Completions | 标准、Spark X2、星辰 Token Plan |
| `modelscope` | 魔搭 ModelScope | Chat Completions | API-Inference |
| `custom_openai_compatible` | 自定义兼容接口 | 用户选择 | 用户 URL |

协议和端点依据厂商当前官方兼容文档登记，例如 [MiMo Responses](https://mimo.mi.com/docs/en-US/api/chat/responses)、[阿里百炼 OpenAI 兼容模式](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)、[智谱 HTTP API](https://docs.bigmodel.cn/cn/guide/develop/http/introduction)、[火山方舟 Responses](https://www.volcengine.com/docs/82379/1795150)、[腾讯混元 OpenAI 兼容接口](https://cloud.tencent.com/document/product/1729/111007)、[MiniMax 文本对话](https://platform.minimaxi.com/docs/guides/text-chat)、[SiliconFlow Chat Completions](https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions)、[StepFun OpenAI 迁移指南](https://platform.stepfun.com/docs/zh/guides/developer/openai) 和 [讯飞星火 HTTP/OpenAI 兼容接口](https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html)。厂商能力会变化，因此 Provider 目录是版本化代码合同，不把 `/models` 的出现等同于工具、结构化输出和 Effort 全部兼容。

国外协议与端点依据厂商当前官方文档登记：[OpenAI Agents SDK 模型与 Provider](https://developers.openai.com/api/docs/guides/agents/models)、[Anthropic 模型 ID](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions)、[Gemini Models API](https://ai.google.dev/api/models)、[Cohere OpenAI Compatibility API](https://docs.cohere.com/docs/compatibility-api)、[xAI Models API](https://docs.x.ai/developers/rest-api-reference/inference/models)、[Mistral 模型目录](https://docs.mistral.ai/api/endpoint/models)、[Groq OpenAI Compatibility](https://console.groq.com/docs/openai)、[Together OpenAI Compatibility](https://docs.together.ai/docs/inference/openai-compatibility)、[OpenRouter Quickstart](https://openrouter.ai/docs/quickstart)、[Perplexity OpenAI Compatibility](https://docs.perplexity.ai/docs/sonar/openai-compatibility) 和 [Cerebras OpenAI Compatibility](https://inference-docs.cerebras.ai/resources/openai)。

## 7. Reasoning Effort

平台使用统一的 `reasoning_effort` 表达，但只允许模型能力合同声明的枚举。适配器把统一值映射为协议参数；当前完整实现的是 OpenAI Responses 风格的 `reasoning.effort`。MiMo v2.5 在界面只暴露 `none/high`，因为官方当前把非 `none` 档位视为相同的“开启推理”。其他厂商的 `thinking`、`enable_thinking`、`thinking_budget` 等非等价参数先记录在能力合同中，不假装为统一语义；在添加专用请求适配器前，界面不应开放不存在的精细 Effort 档位。

Together 的 GPT-OSS 模型按官方兼容文档开放 `low/medium/high`。Anthropic thinking、Gemini thinking budget、OpenRouter 下游模型参数等语义并不等价，因此尚未声明统一 Effort；必须在具体模型适配器和合同测试完成后再开放。

当前能力合同如下。最终开关以模型为准，因为同一个 Provider 下可能只有部分模型支持：

| 状态 | Provider / 模型 | 可选值 |
|---|---|---|
| 全部内置模型支持 | `openai` | `none/low/medium/high/xhigh` |
| 全部内置模型支持 | `codex_bridge` | `none/low/medium/high/xhigh/max` |
| 全部内置模型支持 | `xiaomi_mimo` | `none/high` |
| 全部内置模型支持 | `deepseek` | `low/high/max` |
| 部分模型支持 | `together` 的 `openai/gpt-oss-120b` | `low/medium/high` |
| 当前未启用 | Anthropic、Gemini、Cohere、xAI、Mistral、Groq、OpenRouter、Perplexity、Cerebras，以及其余国内 Provider | 不发送 Effort |
| 未知，默认关闭 | `custom_openai_compatible` 和未识别的同步模型 | 只有模型能力合同显式声明后才能启用 |

Demo 在选中模型后读取 `capabilities_json.reasoning`：未声明支持时清空旧值并禁用 Effort 选择。AgentSDK 在创建 AgentVersion 时再次验证，直接调用 REST 或通过高级 JSON 绕过界面也会被拒绝；不会等到 Run 才失败。

## 8. Context Compaction

Responses Provider 在端点支持时可走原生 compaction；Chat Completions 与 LiteLLM Provider 都走 portable checkpoint。portable summary 对 LiteLLM 使用与主运行相同的带前缀模型和同一连接凭据，因此 Anthropic/Gemini 不会在压缩时错误退回 OpenAI Chat Completions。

Context Window 由模型目录提供准确默认值，Agent 创建者仍可修改。创建 AgentVersion 时，SDK 优先保存用户值；未填写时才从选中的 ProviderModel 注入版本化能力快照。远端同步默认值优先于内置目录，未知值保持空白并由用户填写。`max_input_tokens` 与共享总窗口分开计算，动态路由模型不使用一个猜测的固定默认值。完整模型表、合并语义和升级规则见 [模型 Context Window 能力目录](09-model-context-catalog.md)。

## 9. 已知限制

- Provider 目录是首批稳定入口，不替代厂商实时模型目录；模型 ID 以同步结果为准。
- `/models` 验证不产生生成费用，但不能证明 Function Tools、流式事件或结构化输出一定兼容；最终仍需一次最小真实 Run 合同测试。
- Chat Completions 兼容厂商对 `reasoning_content`、工具调用 ID、JSON Schema 和 Usage 字段存在差异，当前由 Prompt 结构化输出与平台事件适配兜底，仍需逐厂商合同测试。
- 本次没有 Anthropic、Gemini 等国外 Provider 的真实 Key，因此已完成注册、模型装配、模型发现解析和离线合同测试，但真实生成/工具调用合同测试需要对应凭据后执行。
- 当前没有实现主密钥在线轮换和批量重加密；这是上线前运维项。
