from __future__ import annotations

import os
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

import httpx
from openai import AsyncOpenAI
from sqlalchemy import select

from .config import Settings
from .crypto import StateCipher
from .db import Database
from .models import AgentVersionRecord, ProviderConnectionRecord, ProviderModelRecord
from .schemas import ProviderConnectionCreate, ProviderConnectionPatch, ProviderModelCreate


def _model(
    model_id: str,
    *,
    display_name: str | None = None,
    context_window: int | None = None,
    max_input_tokens: int | None = None,
    max_output_tokens: int | None = None,
    context_window_type: str = "total",
    dynamic_context: bool = False,
    tools: bool = True,
    vision: bool = False,
    structured_output: str = "prompt",
    reasoning: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "id": model_id,
        "display_name": display_name or model_id,
        "capabilities": {
            "streaming": True,
            "tools": tools,
            "vision": vision,
            "structured_output": structured_output,
            "context_window": context_window,
            "max_input_tokens": max_input_tokens,
            "max_output_tokens": max_output_tokens,
            "context_window_type": context_window_type,
            "dynamic_context": dynamic_context,
            "capability_source": "catalog",
            "capability_verified_at": "2026-08-10",
            "reasoning": reasoning or {"supported": False, "effort_values": []},
        },
    }


REASONING_STANDARD = {
    "supported": True,
    "adapter": "reasoning_effort",
    "effort_values": ["none", "low", "medium", "high", "xhigh"],
}

REASONING_DEEPSEEK = {
    "supported": True,
    "adapter": "reasoning_effort",
    "effort_values": ["low", "high", "max"],
}

REASONING_MIMO = {
    "supported": True,
    "adapter": "reasoning_effort",
    "effort_values": ["none", "high"],
    "value_map": {"none": "none", "high": "high"},
    "note": "MiMo v2.5 currently exposes reasoning as off/on; non-none efforts are equivalent.",
}

REASONING_LOW_MEDIUM_HIGH = {
    "supported": True,
    "adapter": "reasoning_effort",
    "effort_values": ["low", "medium", "high"],
}

REASONING_CODEX_BRIDGE = {
    "supported": True,
    "adapter": "reasoning_effort",
    "effort_values": ["none", "low", "medium", "high", "xhigh", "max"],
}


def _merge_non_null(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Recursively merge observed capabilities without erasing known catalog values."""
    result = deepcopy(base)
    for key, value in override.items():
        if value is None:
            continue
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _merge_non_null(result[key], value)
        else:
            result[key] = value
    return result


def _observed_capabilities(**values: Any) -> dict[str, Any]:
    capabilities = {key: value for key, value in values.items() if value is not None}
    capabilities["capability_source"] = "remote"
    capabilities["capability_observed_at"] = datetime.now(UTC).isoformat()
    return capabilities


PROVIDER_CATALOG: dict[str, dict[str, Any]] = {
    "openai": {
        "name": "OpenAI",
        "country": "US",
        "default_profile": "default",
        "profiles": {
            "default": {
                "name": "OpenAI API",
                "base_url": "https://api.openai.com/v1",
                "protocol": "responses",
            }
        },
        "models": [
            _model(
                "gpt-5.6-sol",
                context_window=1_050_000,
                max_output_tokens=128_000,
                structured_output="native",
                vision=True,
                reasoning=REASONING_CODEX_BRIDGE,
            ),
            _model(
                "gpt-5.6-terra",
                context_window=1_050_000,
                max_output_tokens=128_000,
                structured_output="native",
                vision=True,
                reasoning=REASONING_CODEX_BRIDGE,
            ),
            _model(
                "gpt-5.6-luna",
                context_window=1_050_000,
                max_output_tokens=128_000,
                structured_output="native",
                vision=True,
                reasoning=REASONING_CODEX_BRIDGE,
            ),
            _model(
                "gpt-5.4",
                context_window=1_050_000,
                max_output_tokens=128_000,
                structured_output="native",
                vision=True,
                reasoning=REASONING_STANDARD,
            ),
            _model(
                "gpt-5.4-mini",
                context_window=400_000,
                max_output_tokens=128_000,
                structured_output="native",
                vision=True,
                reasoning=REASONING_STANDARD,
            ),
        ],
    },
    "codex_bridge": {
        "name": "Codex Bridge（本地）",
        "country": "local",
        "aliases": ["codex-bridge", "codex_anthropic_bridge"],
        "supports_native_compaction": False,
        "portable_summary_protocol": "responses",
        "required_model_settings": {"store": False},
        "default_profile": "loopback",
        "profiles": {
            "loopback": {
                "name": "本机 127.0.0.1:3456",
                "base_url": "http://127.0.0.1:3456/v1",
                "protocol": "responses",
            }
        },
        "models": [
            _model(
                "gpt-5.6-sol",
                display_name="GPT-5.6 Sol（Codex Bridge）",
                context_window=258_400,
                max_output_tokens=128_000,
                tools=True,
                vision=True,
                structured_output="native",
                reasoning=REASONING_CODEX_BRIDGE,
            ),
            _model(
                "gpt-5.6-luna",
                display_name="GPT-5.6 Luna（Codex Bridge）",
                context_window=258_400,
                max_output_tokens=128_000,
                tools=True,
                vision=True,
                structured_output="native",
                reasoning=REASONING_CODEX_BRIDGE,
            ),
        ],
    },
    "anthropic": {
        "name": "Anthropic Claude",
        "country": "US",
        "aliases": ["claude"],
        "litellm_prefix": "anthropic",
        "model_discovery": "anthropic",
        "default_profile": "default",
        "profiles": {
            "default": {
                "name": "Anthropic API",
                "base_url": "https://api.anthropic.com/v1",
                "protocol": "litellm",
            }
        },
        "models": [
            _model(
                "claude-opus-5",
                context_window=1_000_000,
                max_input_tokens=1_000_000,
                context_window_type="input",
                tools=True,
                vision=True,
            ),
            _model(
                "claude-sonnet-5",
                context_window=1_000_000,
                max_input_tokens=1_000_000,
                context_window_type="input",
                tools=True,
                vision=True,
            ),
            _model(
                "claude-opus-4-6",
                context_window=1_000_000,
                max_input_tokens=1_000_000,
                context_window_type="input",
                tools=True,
                vision=True,
            ),
            _model(
                "claude-sonnet-4-6",
                context_window=1_000_000,
                max_input_tokens=1_000_000,
                context_window_type="input",
                tools=True,
                vision=True,
            ),
            _model(
                "claude-haiku-4-5-20251001",
                context_window=200_000,
                max_input_tokens=200_000,
                context_window_type="input",
                tools=True,
                vision=True,
            ),
        ],
    },
    "google_gemini": {
        "name": "Google Gemini",
        "country": "US",
        "aliases": ["google", "gemini"],
        "litellm_prefix": "gemini",
        "model_discovery": "google_gemini",
        "default_profile": "default",
        "profiles": {
            "default": {
                "name": "Google AI Gemini API",
                "base_url": "https://generativelanguage.googleapis.com/v1beta",
                "protocol": "litellm",
            }
        },
        "models": [
            _model(
                "gemini-3.1-pro-preview",
                context_window=1_000_000,
                max_input_tokens=1_000_000,
                max_output_tokens=64_000,
                context_window_type="input",
                tools=True,
                vision=True,
            ),
            _model(
                "gemini-3-flash-preview",
                context_window=1_000_000,
                max_input_tokens=1_000_000,
                max_output_tokens=64_000,
                context_window_type="input",
                tools=True,
                vision=True,
            ),
            _model(
                "gemini-3.1-flash-lite",
                context_window=1_000_000,
                max_input_tokens=1_000_000,
                max_output_tokens=64_000,
                context_window_type="input",
                tools=True,
                vision=True,
            ),
        ],
    },
    "cohere": {
        "name": "Cohere",
        "country": "CA",
        "model_discovery": "cohere",
        "default_profile": "compatibility",
        "profiles": {
            "compatibility": {
                "name": "Cohere OpenAI Compatibility API",
                "base_url": "https://api.cohere.ai/compatibility/v1",
                "protocol": "chat_completions",
            }
        },
        "models": [
            _model(
                "command-a-plus-05-2026",
                context_window=128_000,
                max_output_tokens=64_000,
                tools=True,
                structured_output="native",
            ),
            _model(
                "command-a-03-2025",
                context_window=256_000,
                tools=True,
                structured_output="native",
            ),
        ],
    },
    "xai": {
        "name": "xAI Grok",
        "country": "US",
        "aliases": ["grok"],
        "default_profile": "default",
        "profiles": {
            "default": {
                "name": "xAI API",
                "base_url": "https://api.x.ai/v1",
                "protocol": "chat_completions",
            }
        },
        "models": [
            _model("grok-4.3", context_window=1_000_000, tools=True, vision=True),
            _model("grok-4.5", context_window=500_000, tools=True, vision=True),
            _model("grok-build-0.1", context_window=256_000, tools=True),
        ],
    },
    "mistral": {
        "name": "Mistral AI",
        "country": "FR",
        "model_discovery": "mistral",
        "default_profile": "default",
        "profiles": {
            "default": {
                "name": "Mistral API",
                "base_url": "https://api.mistral.ai/v1",
                "protocol": "chat_completions",
            }
        },
        "models": [
            _model("mistral-large-latest", context_window=256_000, tools=True),
            _model("mistral-small-latest", context_window=256_000, tools=True),
            _model("codestral-latest", context_window=128_000, tools=True),
        ],
    },
    "groq": {
        "name": "Groq",
        "country": "US",
        "model_discovery": "groq",
        "default_profile": "default",
        "profiles": {
            "default": {
                "name": "Groq OpenAI-Compatible API",
                "base_url": "https://api.groq.com/openai/v1",
                "protocol": "chat_completions",
            }
        },
        "models": [
            _model(
                "openai/gpt-oss-120b",
                context_window=131_072,
                max_output_tokens=65_536,
                tools=True,
            ),
            _model(
                "qwen/qwen3.6-27b",
                context_window=131_072,
                max_output_tokens=16_384,
                tools=True,
            ),
            _model(
                "minimaxai/minimax-m2.7",
                context_window=196_608,
                max_output_tokens=131_072,
                tools=True,
            ),
        ],
    },
    "together": {
        "name": "Together AI",
        "country": "US",
        "model_discovery": "together",
        "default_profile": "default",
        "profiles": {
            "default": {
                "name": "Together OpenAI-Compatible API",
                "base_url": "https://api.together.ai/v1",
                "protocol": "chat_completions",
            }
        },
        "models": [
            _model(
                "openai/gpt-oss-120b",
                context_window=131_072,
                tools=True,
                structured_output="native",
                reasoning=REASONING_LOW_MEDIUM_HIGH,
            ),
            _model(
                "openai/gpt-oss-20b",
                context_window=131_072,
                tools=True,
                structured_output="native",
            ),
        ],
    },
    "openrouter": {
        "name": "OpenRouter",
        "country": "US",
        "model_discovery": "openrouter",
        "default_profile": "default",
        "profiles": {
            "default": {
                "name": "OpenRouter API",
                "base_url": "https://openrouter.ai/api/v1",
                "protocol": "chat_completions",
            }
        },
        "models": [],
    },
    "perplexity": {
        "name": "Perplexity",
        "country": "US",
        "model_discovery": "perplexity",
        "default_profile": "sonar",
        "profiles": {
            "sonar": {
                "name": "Perplexity Sonar API",
                "base_url": "https://api.perplexity.ai",
                "protocol": "chat_completions",
            }
        },
        "models": [
            _model("sonar", context_window=128_000, tools=True),
            _model("sonar-pro", context_window=200_000, tools=True),
        ],
    },
    "cerebras": {
        "name": "Cerebras Inference",
        "country": "US",
        "default_profile": "default",
        "profiles": {
            "default": {
                "name": "Cerebras OpenAI-Compatible API",
                "base_url": "https://api.cerebras.ai/v1",
                "protocol": "chat_completions",
            }
        },
        "models": [
            _model(
                "gpt-oss-120b",
                context_window=131_072,
                max_output_tokens=40_960,
                tools=True,
            )
        ],
    },
    "xiaomi_mimo": {
        "name": "小米 MiMo",
        "country": "CN",
        "aliases": ["mimo", "xiaomi"],
        "default_profile": "token_plan_cn",
        "profiles": {
            "token_plan_cn": {
                "name": "Token Plan（中国）",
                "base_url": "https://token-plan-cn.xiaomimimo.com/v1",
                "protocol": "responses",
            },
            "payg_cn": {
                "name": "按量 API（中国）",
                "base_url": "https://api.xiaomimimo.com/v1",
                "protocol": "responses",
            },
        },
        "models": [
            _model(
                "mimo-v2.5",
                context_window=1_048_576,
                max_output_tokens=32_768,
                tools=True,
                vision=True,
                reasoning=REASONING_MIMO,
            ),
            _model(
                "mimo-v2.5-pro",
                context_window=1_048_576,
                max_output_tokens=131_072,
                tools=True,
                vision=True,
                reasoning=REASONING_MIMO,
            ),
        ],
    },
    "deepseek": {
        "name": "DeepSeek",
        "country": "CN",
        "default_profile": "default",
        "profiles": {
            "default": {
                "name": "DeepSeek API",
                "base_url": "https://api.deepseek.com",
                "protocol": "responses",
            }
        },
        "models": [
            _model(
                "deepseek-v4-pro",
                context_window=1_000_000,
                tools=True,
                reasoning=REASONING_DEEPSEEK,
            ),
            _model(
                "deepseek-v4-flash",
                context_window=1_000_000,
                tools=True,
                reasoning=REASONING_DEEPSEEK,
            ),
        ],
    },
    "alibaba_qwen": {
        "name": "阿里云百炼 / Qwen",
        "country": "CN",
        "aliases": ["qwen", "dashscope", "bailian"],
        "default_profile": "cn_beijing",
        "profiles": {
            "cn_beijing": {
                "name": "中国（北京）",
                "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "protocol": "chat_completions",
            }
        },
        "models": [
            _model("qwen3.8-max-preview", context_window=1_000_000, tools=True, vision=True),
            _model("qwen3.7-max", context_window=1_000_000, tools=True, vision=True),
            _model("qwen3.7-plus", context_window=1_000_000, tools=True, vision=True),
            _model("qwen3.6-flash", context_window=1_000_000, tools=True),
        ],
    },
    "zhipu_glm": {
        "name": "智谱 GLM",
        "country": "CN",
        "aliases": ["zhipu", "glm", "bigmodel"],
        "default_profile": "default",
        "profiles": {
            "default": {
                "name": "智谱开放平台",
                "base_url": "https://open.bigmodel.cn/api/paas/v4",
                "protocol": "chat_completions",
            }
        },
        "models": [
            _model(
                "glm-5.2",
                context_window=1_000_000,
                max_output_tokens=128_000,
                tools=True,
                vision=True,
            ),
            _model("glm-5.1", context_window=200_000, max_output_tokens=128_000, tools=True),
            _model("glm-5", context_window=200_000, max_output_tokens=128_000, tools=True),
            _model("glm-4.7", context_window=200_000, max_output_tokens=128_000, tools=True),
        ],
    },
    "moonshot_kimi": {
        "name": "Moonshot / Kimi",
        "country": "CN",
        "aliases": ["moonshot", "kimi"],
        "default_profile": "cn",
        "profiles": {
            "cn": {
                "name": "中国",
                "base_url": "https://api.moonshot.cn/v1",
                "protocol": "chat_completions",
            },
            "global": {
                "name": "国际",
                "base_url": "https://api.moonshot.ai/v1",
                "protocol": "chat_completions",
            },
        },
        "models": [
            _model("kimi-k2.7-code", context_window=262_144, tools=True),
            _model("kimi-k2.6", context_window=262_144, tools=True, vision=True),
            _model("kimi-k2.5", context_window=262_144, tools=True, vision=True),
        ],
    },
    "volcengine_ark": {
        "name": "火山方舟 / 豆包",
        "country": "CN",
        "aliases": ["ark", "doubao", "volcengine"],
        "default_profile": "cn_beijing",
        "profiles": {
            "cn_beijing": {
                "name": "中国（北京）",
                "base_url": "https://ark.cn-beijing.volces.com/api/v3",
                "protocol": "responses",
            },
            "coding_plan": {
                "name": "Coding Plan",
                "base_url": "https://ark.cn-beijing.volces.com/api/coding/v3",
                "protocol": "responses",
            },
        },
        "models": [
            _model("doubao-seed-2-0-lite-260215", tools=True, vision=True),
            _model("ark-code-latest", tools=True, dynamic_context=True),
        ],
    },
    "baidu_qianfan": {
        "name": "百度智能云千帆",
        "country": "CN",
        "aliases": ["baidu", "qianfan", "ernie"],
        "default_profile": "default",
        "profiles": {
            "default": {
                "name": "千帆 v2",
                "base_url": "https://qianfan.baidubce.com/v2",
                "protocol": "chat_completions",
            }
        },
        "models": [
            _model("ernie-4.5-turbo-128k", context_window=128_000, tools=True),
            _model("ernie-x1.1-preview", context_window=64_000, tools=True),
        ],
    },
    "tencent_hunyuan": {
        "name": "腾讯混元",
        "country": "CN",
        "aliases": ["tencent", "hunyuan"],
        "default_profile": "default",
        "profiles": {
            "default": {
                "name": "混元 OpenAI 兼容",
                "base_url": "https://api.hunyuan.cloud.tencent.com/v1",
                "protocol": "chat_completions",
            }
        },
        "models": [
            _model("hunyuan-turbos-latest", tools=True),
            _model("hunyuan-lite", tools=False),
            _model("hunyuan-vision", tools=True, vision=True),
        ],
    },
    "minimax": {
        "name": "MiniMax",
        "country": "CN",
        "default_profile": "cn",
        "profiles": {
            "cn": {
                "name": "中国",
                "base_url": "https://api.minimaxi.com/v1",
                "protocol": "chat_completions",
            },
            "global": {
                "name": "国际",
                "base_url": "https://api.minimax.io/v1",
                "protocol": "chat_completions",
            },
        },
        "models": [
            _model("MiniMax-M2.7", context_window=204_800, tools=True),
            _model("MiniMax-M2.5", context_window=204_800, tools=True),
            _model("MiniMax-M2.1", context_window=204_800, tools=True),
        ],
    },
    "siliconflow": {
        "name": "SiliconFlow 硅基流动",
        "country": "CN",
        "default_profile": "cn",
        "profiles": {
            "cn": {
                "name": "中国",
                "base_url": "https://api.siliconflow.cn/v1",
                "protocol": "chat_completions",
            }
        },
        "models": [],
    },
    "stepfun": {
        "name": "阶跃星辰 StepFun",
        "country": "CN",
        "default_profile": "standard",
        "profiles": {
            "standard": {
                "name": "开放平台",
                "base_url": "https://api.stepfun.com/v1",
                "protocol": "chat_completions",
            },
            "step_plan": {
                "name": "Step Plan",
                "base_url": "https://api.stepfun.com/step_plan/v1",
                "protocol": "chat_completions",
            },
        },
        "models": [
            _model("step-3.5-flash", context_window=262_144, tools=True),
            _model("step-3.5-flash-2603", context_window=262_144, tools=True),
            _model("step-router-v1", tools=True, dynamic_context=True),
        ],
    },
    "baichuan": {
        "name": "百川智能",
        "country": "CN",
        "default_profile": "default",
        "profiles": {
            "default": {
                "name": "百川 API",
                "base_url": "https://api.baichuan-ai.com/v1",
                "protocol": "chat_completions",
            }
        },
        "models": [
            _model("Baichuan3-Turbo-128k", context_window=131_072, tools=True),
            _model("Baichuan3-Turbo", tools=True),
        ],
    },
    "lingyiwanwu": {
        "name": "零一万物 01.AI",
        "country": "CN",
        "aliases": ["01ai", "yi"],
        "default_profile": "default",
        "profiles": {
            "default": {
                "name": "Yi API",
                "base_url": "https://api.lingyiwanwu.com/v1",
                "protocol": "chat_completions",
            }
        },
        "models": [_model("yi-lightning", tools=True), _model("yi-large", tools=True)],
    },
    "iflytek_spark": {
        "name": "科大讯飞星火",
        "country": "CN",
        "aliases": ["iflytek", "spark", "xfyun"],
        "default_profile": "standard",
        "profiles": {
            "standard": {
                "name": "星火 OpenAI 兼容",
                "base_url": "https://spark-api-open.xf-yun.com/v1",
                "protocol": "chat_completions",
            },
            "spark_x2": {
                "name": "Spark X2 Flash",
                "base_url": "https://spark-api-open.xf-yun.com/agent/v1",
                "protocol": "chat_completions",
            },
            "astron_token_plan": {
                "name": "星辰 MaaS Token Plan",
                "base_url": "https://maas-token-api.cn-huabei-1.xf-yun.com/v2",
                "protocol": "chat_completions",
            },
        },
        "models": [
            _model(
                "4.0Ultra",
                context_window=32_768,
                max_input_tokens=32_768,
                max_output_tokens=32_768,
                context_window_type="input",
                tools=True,
            ),
            _model(
                "spark-x",
                display_name="Spark X2（动态路由）",
                tools=True,
                dynamic_context=True,
            ),
        ],
    },
    "modelscope": {
        "name": "魔搭 ModelScope",
        "country": "CN",
        "default_profile": "inference",
        "profiles": {
            "inference": {
                "name": "API-Inference",
                "base_url": "https://api-inference.modelscope.cn/v1",
                "protocol": "chat_completions",
            }
        },
        "models": [],
    },
    "custom_openai_compatible": {
        "name": "自定义 OpenAI-Compatible",
        "country": "custom",
        "custom_endpoint": True,
        "default_profile": "custom",
        "profiles": {},
        "models": [],
    },
}


def public_provider_catalog() -> list[dict[str, Any]]:
    result = []
    for provider_id, raw in PROVIDER_CATALOG.items():
        item = deepcopy(raw)
        item["id"] = provider_id
        item.pop("aliases", None)
        models = item.get("models", [])
        supported_models = [
            model
            for model in models
            if model.get("capabilities", {}).get("reasoning", {}).get("supported") is True
        ]
        effort_values: list[str] = []
        for model in supported_models:
            for value in model["capabilities"]["reasoning"].get("effort_values", []):
                if value not in effort_values:
                    effort_values.append(value)
        item["reasoning_effort"] = {
            "supported": bool(supported_models),
            "scope": "all"
            if models and len(supported_models) == len(models)
            else "some"
            if supported_models
            else "none",
            "model_ids": [model["id"] for model in supported_models],
            "effort_values": effort_values,
        }
        result.append(item)
    return result


def _valid_http_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def litellm_model_name(provider: dict[str, Any], model_id: str) -> str:
    prefix = str(provider.get("litellm_prefix", "")).strip("/")
    if not prefix or model_id.startswith(f"{prefix}/"):
        return model_id
    return f"{prefix}/{model_id}"


class ProviderService:
    def __init__(self, db: Database, settings: Settings):
        self.db = db
        self.settings = settings
        self.cipher = StateCipher(f"{settings.run_state_secret}:provider-credentials:v1")

    def definition(self, provider: str) -> dict[str, Any]:
        definition = PROVIDER_CATALOG.get(provider)
        if definition is None:
            raise ValueError(f"unsupported provider: {provider}")
        return definition

    def _endpoint(
        self,
        provider: str,
        profile: str | None,
        custom_base_url: str | None = None,
        custom_protocol: str | None = None,
    ) -> tuple[str, str, str]:
        definition = self.definition(provider)
        selected = profile or str(definition.get("default_profile", "default"))
        if definition.get("custom_endpoint"):
            if not custom_base_url or not _valid_http_url(custom_base_url):
                raise ValueError("custom provider requires a valid HTTP(S) base URL")
            return selected, custom_base_url.rstrip("/"), custom_protocol or "responses"
        if custom_base_url or custom_protocol:
            raise ValueError("base URL and protocol are managed by the selected provider")
        endpoint = (definition.get("profiles") or {}).get(selected)
        if endpoint is None:
            raise ValueError(f"unsupported endpoint profile for {provider}: {selected}")
        return selected, str(endpoint["base_url"]).rstrip("/"), str(endpoint["protocol"])

    def _encrypt_key(self, key: str | None) -> tuple[bytes | None, str | None, str | None]:
        if not key:
            return None, None, None
        ciphertext, checksum = self.cipher.encrypt(key.encode("utf-8"))
        hint = f"…{key[-4:]}" if len(key) >= 4 else "configured"
        return ciphertext, checksum, hint

    def resolve_api_key(self, record: ProviderConnectionRecord) -> str:
        if record.api_key_env:
            value = os.environ.get(record.api_key_env)
            if not value:
                raise ValueError(
                    f"provider credential environment variable is missing: {record.api_key_env}"
                )
            return value
        if record.api_key_ciphertext and record.api_key_checksum:
            return self.cipher.decrypt(record.api_key_ciphertext, record.api_key_checksum).decode(
                "utf-8"
            )
        raise ValueError("provider connection has no credential")

    def connection_dict(self, record: ProviderConnectionRecord) -> dict[str, Any]:
        definition = self.definition(record.provider)
        return {
            "id": record.id,
            "tenant_id": record.tenant_id,
            "name": record.name,
            "provider": record.provider,
            "provider_name": definition["name"],
            "endpoint_profile": record.endpoint_profile,
            "protocol": record.protocol,
            "custom_base_url": record.base_url if definition.get("custom_endpoint") else None,
            "credential_source": "environment" if record.api_key_env else "encrypted",
            "api_key_env": record.api_key_env,
            "key_hint": record.key_hint,
            "has_credential": bool(record.api_key_env or record.api_key_ciphertext),
            "status": record.status,
            "default_model": record.settings_json.get("default_model"),
            "last_validated_at": record.last_validated_at.isoformat()
            if record.last_validated_at
            else None,
            "last_error": record.last_error,
            "settings": record.settings_json,
            "created_at": record.created_at.isoformat() if record.created_at else None,
            "updated_at": record.updated_at.isoformat() if record.updated_at else None,
        }

    async def _seed_models(
        self, session, connection: ProviderConnectionRecord, provider: str
    ) -> None:
        for definition in self.definition(provider).get("models", []):
            existing = await session.scalar(
                select(ProviderModelRecord).where(
                    ProviderModelRecord.connection_id == connection.id,
                    ProviderModelRecord.model_id == definition["id"],
                )
            )
            if existing is None:
                session.add(
                    ProviderModelRecord(
                        tenant_id=connection.tenant_id,
                        connection_id=connection.id,
                        model_id=definition["id"],
                        display_name=definition["display_name"],
                        source="builtin",
                        capabilities_json=definition["capabilities"],
                    )
                )
            elif existing.source == "builtin":
                existing.display_name = definition["display_name"]
                existing.capabilities_json = deepcopy(definition["capabilities"])
                existing.status = "active"

    async def backfill_default_models(self) -> None:
        """Refresh builtin capabilities and repair defaults on existing connections."""
        async with self.db.sessions() as session, session.begin():
            connections = (await session.scalars(select(ProviderConnectionRecord))).all()
            for connection in connections:
                await self._seed_models(session, connection, connection.provider)
                rows = (
                    await session.scalars(
                        select(ProviderModelRecord).where(
                            ProviderModelRecord.connection_id == connection.id
                        )
                    )
                ).all()
                catalog_ids = {
                    str(item["id"])
                    for item in self.definition(connection.provider).get("models", [])
                }
                for row in rows:
                    if row.source == "builtin" and row.model_id not in catalog_ids:
                        row.status = "unavailable"
                available_ids = {
                    row.model_id
                    for row in rows
                    if row.status in {"active", "configured"}
                    and not (row.source == "builtin" and row.model_id not in catalog_ids)
                }
                if not available_ids:
                    continue
                catalog_order = [
                    str(item["id"])
                    for item in self.definition(connection.provider).get("models", [])
                ]
                current_default = str(connection.settings_json.get("default_model") or "")
                default_model = (
                    current_default
                    if current_default in available_ids
                    else next(
                        (model_id for model_id in catalog_order if model_id in available_ids),
                        sorted(available_ids)[0],
                    )
                )
                connection.settings_json = {
                    **connection.settings_json,
                    "default_model": default_model,
                }

    async def create_connection(
        self, tenant_id: str, data: ProviderConnectionCreate
    ) -> ProviderConnectionRecord:
        if bool(data.api_key) == bool(data.api_key_env):
            raise ValueError("provide exactly one of api_key or api_key_env")
        profile, base_url, protocol = self._endpoint(
            data.provider,
            data.endpoint_profile,
            data.custom_base_url,
            data.custom_protocol,
        )
        encrypted, checksum, hint = self._encrypt_key(data.api_key)
        settings = dict(data.settings)
        settings.pop("default_model", None)
        builtin_models = self.definition(data.provider).get("models", [])
        if builtin_models:
            settings["default_model"] = str(builtin_models[0]["id"])
        record = ProviderConnectionRecord(
            tenant_id=tenant_id,
            name=data.name,
            provider=data.provider,
            endpoint_profile=profile,
            base_url=base_url,
            protocol=protocol,
            api_key_ciphertext=encrypted,
            api_key_checksum=checksum,
            api_key_env=data.api_key_env,
            key_hint=hint or (f"env:{data.api_key_env}" if data.api_key_env else None),
            settings_json=settings,
        )
        async with self.db.sessions() as session, session.begin():
            session.add(record)
            await session.flush()
            await self._seed_models(session, record, data.provider)
        return record

    async def update_connection(
        self, tenant_id: str, connection_id: str, data: ProviderConnectionPatch
    ) -> ProviderConnectionRecord:
        async with self.db.sessions() as session, session.begin():
            record = await session.scalar(
                select(ProviderConnectionRecord).where(
                    ProviderConnectionRecord.id == connection_id,
                    ProviderConnectionRecord.tenant_id == tenant_id,
                )
            )
            if record is None:
                raise KeyError("provider connection not found")
            changes = data.model_dump(exclude_unset=True)
            if "name" in changes:
                record.name = changes["name"]
            if "status" in changes:
                record.status = changes["status"]
            if "settings" in changes:
                record.settings_json = changes["settings"]
            if "default_model" in changes:
                default_model = changes["default_model"]
                if default_model is None:
                    settings = dict(record.settings_json)
                    settings.pop("default_model", None)
                    record.settings_json = settings
                else:
                    model = await session.scalar(
                        select(ProviderModelRecord).where(
                            ProviderModelRecord.connection_id == connection_id,
                            ProviderModelRecord.tenant_id == tenant_id,
                            ProviderModelRecord.model_id == default_model,
                            ProviderModelRecord.status.in_({"active", "configured"}),
                        )
                    )
                    if model is None:
                        raise ValueError("default model is unavailable for this connection")
                    record.settings_json = {
                        **record.settings_json,
                        "default_model": default_model,
                    }
            endpoint_fields = {"endpoint_profile", "custom_base_url", "custom_protocol"}
            if endpoint_fields & changes.keys():
                profile, base_url, protocol = self._endpoint(
                    record.provider,
                    changes.get("endpoint_profile", record.endpoint_profile),
                    changes.get(
                        "custom_base_url",
                        record.base_url if record.provider == "custom_openai_compatible" else None,
                    ),
                    changes.get(
                        "custom_protocol",
                        record.protocol if record.provider == "custom_openai_compatible" else None,
                    ),
                )
                record.endpoint_profile = profile
                record.base_url = base_url
                record.protocol = protocol
            if "api_key" in changes or "api_key_env" in changes:
                if changes.get("api_key") and changes.get("api_key_env"):
                    raise ValueError("provide either api_key or api_key_env, not both")
                if changes.get("api_key"):
                    encrypted, checksum, hint = self._encrypt_key(changes["api_key"])
                    record.api_key_ciphertext = encrypted
                    record.api_key_checksum = checksum
                    record.api_key_env = None
                    record.key_hint = hint
                elif changes.get("api_key_env"):
                    record.api_key_ciphertext = None
                    record.api_key_checksum = None
                    record.api_key_env = changes["api_key_env"]
                    record.key_hint = f"env:{changes['api_key_env']}"
            if endpoint_fields & changes.keys() or {"api_key", "api_key_env"} & changes.keys():
                record.last_validated_at = None
                record.last_error = None
        return record

    async def add_model(
        self, tenant_id: str, connection_id: str, data: ProviderModelCreate
    ) -> ProviderModelRecord:
        async with self.db.sessions() as session, session.begin():
            connection = await session.scalar(
                select(ProviderConnectionRecord).where(
                    ProviderConnectionRecord.id == connection_id,
                    ProviderConnectionRecord.tenant_id == tenant_id,
                )
            )
            if connection is None:
                raise KeyError("provider connection not found")
            record = ProviderModelRecord(
                tenant_id=tenant_id,
                connection_id=connection_id,
                model_id=data.model_id,
                display_name=data.display_name or data.model_id,
                source="manual",
                capabilities_json=data.capabilities,
            )
            session.add(record)
            if not connection.settings_json.get("default_model"):
                connection.settings_json = {
                    **connection.settings_json,
                    "default_model": data.model_id,
                }
        return record

    async def _discover_models(
        self, record: ProviderConnectionRecord, key: str
    ) -> list[dict[str, Any]]:
        definition = self.definition(record.provider)
        strategy = str(definition.get("model_discovery", "openai"))
        timeout = float(record.settings_json.get("timeout_seconds", 30))
        if strategy == "openai":
            client = AsyncOpenAI(
                api_key=key,
                base_url=record.base_url,
                max_retries=0,
                timeout=timeout,
            )
            try:
                page = await client.models.list()
                return [{"id": str(item.id)} for item in page.data if getattr(item, "id", None)]
            finally:
                await client.close()

        headers: dict[str, str]
        params: dict[str, str] | None = None
        if strategy == "anthropic":
            url = f"{record.base_url.rstrip('/')}/models"
            headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}
            params = {"limit": "1000"}
        elif strategy == "google_gemini":
            url = f"{record.base_url.rstrip('/')}/models"
            headers = {"x-goog-api-key": key}
            params = {"pageSize": "1000"}
        elif strategy == "cohere":
            url = "https://api.cohere.com/v1/models"
            headers = {"Authorization": f"Bearer {key}"}
            params = {"page_size": "1000", "endpoint": "chat"}
        elif strategy == "mistral":
            url = f"{record.base_url.rstrip('/')}/models"
            headers = {"Authorization": f"Bearer {key}"}
        elif strategy == "together":
            url = f"{record.base_url.rstrip('/')}/models"
            headers = {"Authorization": f"Bearer {key}"}
        elif strategy == "perplexity":
            url = "https://api.perplexity.ai/v1/models"
            headers = {"Authorization": f"Bearer {key}"}
        elif strategy in {"groq", "openrouter"}:
            url = f"{record.base_url.rstrip('/')}/models"
            headers = {"Authorization": f"Bearer {key}"}
        else:  # pragma: no cover - catalog definitions are code-reviewed
            raise ValueError(f"unsupported model discovery strategy: {strategy}")

        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.get(url, headers=headers, params=params)
            response.raise_for_status()
            payload = response.json()

        if strategy == "anthropic":
            discovered = []
            for item in payload.get("data", []):
                if not item.get("id"):
                    continue
                max_input = item.get("max_input_tokens") or item.get("input_token_limit")
                max_output = item.get("max_tokens") or item.get("max_output_tokens")
                discovered.append(
                    {
                        "id": str(item["id"]),
                        "display_name": str(item.get("display_name") or item["id"]),
                        "capabilities": _observed_capabilities(
                            context_window=max_input,
                            max_input_tokens=max_input,
                            max_output_tokens=max_output,
                            context_window_type="input" if max_input else None,
                            tools=True,
                            vision=True,
                        ),
                    }
                )
            return discovered
        if strategy == "google_gemini":
            discovered = []
            for item in payload.get("models", []):
                methods = item.get("supportedGenerationMethods") or []
                if "generateContent" not in methods or not item.get("name"):
                    continue
                model_id = str(item["name"]).removeprefix("models/")
                discovered.append(
                    {
                        "id": model_id,
                        "display_name": str(item.get("displayName") or model_id),
                        "capabilities": _observed_capabilities(
                            context_window=item.get("inputTokenLimit"),
                            max_input_tokens=item.get("inputTokenLimit"),
                            max_output_tokens=item.get("outputTokenLimit"),
                            context_window_type="input",
                            tools=True,
                            vision=True,
                        ),
                    }
                )
            return discovered
        if strategy == "cohere":
            return [
                {
                    "id": str(item["name"]),
                    "display_name": str(item["name"]),
                    "capabilities": _observed_capabilities(
                        context_window=item.get("context_length"),
                        tools=True,
                    ),
                }
                for item in payload.get("models", [])
                if item.get("name") and not item.get("is_deprecated", False)
            ]
        if strategy == "mistral":
            items = payload if isinstance(payload, list) else payload.get("data", [])
            discovered = []
            for item in items:
                capabilities = item.get("capabilities") or {}
                if (
                    not item.get("id")
                    or item.get("archived", False)
                    or capabilities.get("completion_chat") is False
                ):
                    continue
                model_id = str(item["id"])
                discovered.append(
                    {
                        "id": model_id,
                        "capabilities": _observed_capabilities(
                            context_window=item.get("max_context_length"),
                            tools=bool(capabilities.get("function_calling", True)),
                            vision=bool(capabilities.get("vision", False)),
                        ),
                    }
                )
            return discovered
        if strategy == "together":
            items = payload if isinstance(payload, list) else payload.get("data", [])
            return [
                {
                    "id": str(item["id"]),
                    "display_name": str(item.get("display_name") or item["id"]),
                    "capabilities": _observed_capabilities(
                        context_window=item.get("context_length"),
                        tools=True,
                    ),
                }
                for item in items
                if item.get("id") and item.get("type") in {"chat", "language", "code"}
            ]
        if strategy == "groq":
            return [
                {
                    "id": str(item["id"]),
                    "capabilities": _observed_capabilities(
                        context_window=item.get("context_window"),
                        max_output_tokens=item.get("max_completion_tokens"),
                    ),
                }
                for item in payload.get("data", [])
                if item.get("id") and item.get("active", True)
            ]
        if strategy == "openrouter":
            discovered = []
            for item in payload.get("data", []):
                if not item.get("id"):
                    continue
                architecture = item.get("architecture") or {}
                modalities = architecture.get("input_modalities") or []
                top_provider = item.get("top_provider") or {}
                discovered.append(
                    {
                        "id": str(item["id"]),
                        "display_name": str(item.get("name") or item["id"]),
                        "capabilities": _observed_capabilities(
                            context_window=item.get("context_length"),
                            max_output_tokens=top_provider.get("max_completion_tokens"),
                            vision="image" in modalities if modalities else None,
                        ),
                    }
                )
            return discovered
        result = []
        for item in payload.get("data", []):
            model_id = str(item.get("id") or "")
            if not model_id or str(item.get("owned_by", "")).lower() != "perplexity":
                continue
            result.append({"id": model_id.removeprefix("perplexity/")})
        return result

    async def validate_connection(
        self, tenant_id: str, connection_id: str, *, sync: bool = False
    ) -> dict[str, Any]:
        async with self.db.sessions() as session:
            record = await session.scalar(
                select(ProviderConnectionRecord).where(
                    ProviderConnectionRecord.id == connection_id,
                    ProviderConnectionRecord.tenant_id == tenant_id,
                )
            )
        if record is None:
            raise KeyError("provider connection not found")
        discovered: list[dict[str, Any]] = []
        error: str | None = None
        try:
            key = self.resolve_api_key(record)
            discovered = await self._discover_models(record, key)
            discovered = sorted(
                {item["id"]: item for item in discovered if item.get("id")}.values(),
                key=lambda item: item["id"],
            )
        except Exception as exc:
            error = f"{type(exc).__name__}: {str(exc)}"[:1000]
        now = datetime.now(UTC)
        async with self.db.sessions() as session, session.begin():
            current = await session.get(ProviderConnectionRecord, record.id)
            if current is None:
                raise KeyError("provider connection not found")
            current.last_validated_at = now
            current.last_error = error
            current.status = "active" if error is None else "configured"
            if discovered and (sync or error is None):
                known = {
                    row.model_id: row
                    for row in (
                        await session.scalars(
                            select(ProviderModelRecord).where(
                                ProviderModelRecord.connection_id == record.id
                            )
                        )
                    ).all()
                }
                builtin = {
                    item["id"]: item for item in self.definition(record.provider).get("models", [])
                }
                for discovered_model in discovered:
                    model_id = str(discovered_model["id"])
                    row = known.get(model_id)
                    definition = builtin.get(model_id, {})
                    catalog_capabilities = dict(definition.get("capabilities") or {})
                    observed_capabilities = dict(discovered_model.get("capabilities") or {})
                    if row is None:
                        row = ProviderModelRecord(
                            tenant_id=tenant_id,
                            connection_id=record.id,
                            model_id=model_id,
                            display_name=definition.get(
                                "display_name",
                                discovered_model.get("display_name", model_id),
                            ),
                            source="discovered",
                            capabilities_json=_merge_non_null(
                                catalog_capabilities,
                                observed_capabilities,
                            ),
                        )
                        session.add(row)
                    elif row.source != "manual":
                        row.display_name = str(
                            discovered_model.get("display_name")
                            or definition.get("display_name")
                            or row.display_name
                            or model_id
                        )
                        base_capabilities = (
                            catalog_capabilities
                            if row.source == "builtin"
                            else _merge_non_null(catalog_capabilities, row.capabilities_json or {})
                        )
                        row.capabilities_json = _merge_non_null(
                            base_capabilities, observed_capabilities
                        )
                    row.status = "active"
                    row.last_seen_at = now
                discovered_ids = {str(item["id"]) for item in discovered}
                for model_id, row in known.items():
                    if row.source == "discovered" and model_id not in discovered_ids:
                        row.status = "unavailable"
                current_default = str(current.settings_json.get("default_model") or "")
                if current_default not in discovered_ids:
                    catalog_order = [
                        str(item["id"])
                        for item in self.definition(record.provider).get("models", [])
                    ]
                    default_model = next(
                        (model_id for model_id in catalog_order if model_id in discovered_ids),
                        str(discovered[0]["id"]),
                    )
                    current.settings_json = {
                        **current.settings_json,
                        "default_model": default_model,
                    }
            default_model = current.settings_json.get("default_model")
        return {
            "status": "active" if error is None else "configured",
            "models_discovered": len(discovered),
            "model_ids": [str(item["id"]) for item in discovered],
            "default_model": default_model,
            "error": error,
        }

    async def validate_agent_reference(self, tenant_id: str, config: dict[str, Any]) -> None:
        connection_id = config.get("provider_connection_id")
        model_id = config.get("provider_model_id")
        if not connection_id and not model_id:
            return
        if not connection_id or not model_id:
            raise ValueError(
                "provider_connection_id and provider_model_id must be provided together"
            )
        async with self.db.sessions() as session:
            connection = await session.scalar(
                select(ProviderConnectionRecord).where(
                    ProviderConnectionRecord.id == connection_id,
                    ProviderConnectionRecord.tenant_id == tenant_id,
                )
            )
            model = await session.scalar(
                select(ProviderModelRecord).where(
                    ProviderModelRecord.id == model_id,
                    ProviderModelRecord.tenant_id == tenant_id,
                    ProviderModelRecord.connection_id == connection_id,
                )
            )
        if connection is None:
            raise ValueError("provider connection not found for this tenant")
        if connection.status == "disabled":
            raise ValueError("provider connection is disabled")
        if model is None or model.status not in {"active", "configured"}:
            raise ValueError("provider model is unavailable for this connection")
        effort = config.get("reasoning_effort")
        if effort is not None:
            reasoning = dict((model.capabilities_json or {}).get("reasoning") or {})
            allowed = reasoning.get("effort_values") or []
            if not reasoning.get("supported") or effort not in allowed:
                raise ValueError(
                    f"reasoning effort {effort!r} is not supported by {model.model_id}"
                )

    async def apply_model_defaults(self, tenant_id: str, config: dict[str, Any]) -> dict[str, Any]:
        """Materialize model capabilities into an immutable managed Agent version."""
        result = deepcopy(config)
        if not result.get("provider_connection_id"):
            return result
        await self.validate_agent_reference(tenant_id, result)
        async with self.db.sessions() as session:
            model = await session.get(ProviderModelRecord, result["provider_model_id"])
        assert model is not None
        compaction = result.get("compaction")
        if not compaction:
            return result
        compaction = dict(compaction)
        capabilities = dict(model.capabilities_json or {})
        catalog_max_input = int(capabilities.get("max_input_tokens") or 0)
        catalog_context_window = int(capabilities.get("context_window") or catalog_max_input or 0)
        configured_context_window = int(compaction.get("context_window") or 0)
        context_window = configured_context_window or catalog_context_window
        if context_window <= 0:
            raise ValueError(
                f"compaction cannot be enabled for {model.model_id}: model context window "
                "is unknown; provide compaction.context_window or synchronize model capabilities"
            )
        compaction["context_window"] = context_window
        context_window_type = str(
            compaction.get("context_window_type")
            or capabilities.get("context_window_type")
            or "total"
        )
        compaction["context_window_type"] = context_window_type
        if context_window_type == "input":
            compaction["max_input_tokens"] = (
                configured_context_window or catalog_max_input or context_window
            )
        else:
            compaction.pop("max_input_tokens", None)
        compaction["context_window_source"] = (
            "user" if configured_context_window > 0 else "model_capability"
        )
        summary_context_window = int(compaction.get("summary_context_window") or context_window)
        summary_context_window_type = str(
            compaction.get("summary_context_window_type") or context_window_type
        )
        compaction["summary_context_window"] = summary_context_window
        compaction["summary_context_window_type"] = summary_context_window_type
        if summary_context_window_type == "input":
            compaction["summary_max_input_tokens"] = int(
                compaction.get("summary_max_input_tokens")
                or (
                    compaction.get("max_input_tokens")
                    if summary_context_window == context_window
                    else summary_context_window
                )
            )
        else:
            compaction.pop("summary_max_input_tokens", None)
        result["compaction"] = compaction
        return result

    async def resolve_agent_config(self, config: dict[str, Any], tenant_id: str) -> dict[str, Any]:
        if not config.get("provider_connection_id"):
            return deepcopy(config)
        await self.validate_agent_reference(tenant_id, config)
        async with self.db.sessions() as session:
            connection = await session.get(
                ProviderConnectionRecord, config["provider_connection_id"]
            )
            model = await session.get(ProviderModelRecord, config["provider_model_id"])
        assert connection is not None and model is not None
        result = deepcopy(config)
        options = dict(result.pop("provider_options", {}) or {})
        forbidden = {"base_url", "protocol", "api_key", "api_key_env", "type", "name"}
        if forbidden & options.keys():
            raise ValueError("provider_options cannot override managed connection fields")
        capabilities = dict(model.capabilities_json or {})
        provider_definition = self.definition(connection.provider)
        provider_type = (
            "litellm"
            if connection.protocol == "litellm"
            else "openai"
            if connection.provider == "openai"
            else "openai_compatible"
        )
        result["model"] = model.model_id
        result["provider"] = {
            **options,
            "type": provider_type,
            "name": connection.provider,
            "protocol": connection.protocol,
            "base_url": connection.base_url,
            "litellm_prefix": provider_definition.get("litellm_prefix"),
            "supports_native_compaction": provider_definition.get(
                "supports_native_compaction", True
            ),
            "portable_summary_protocol": provider_definition.get(
                "portable_summary_protocol", "chat_completions"
            ),
            "_api_key": self.resolve_api_key(connection),
            "structured_output_mode": options.get(
                "structured_output_mode",
                "native" if capabilities.get("structured_output") == "native" else "prompt",
            ),
            "context_window": capabilities.get("context_window"),
            "max_input_tokens": capabilities.get("max_input_tokens"),
            "max_output_tokens": capabilities.get("max_output_tokens"),
            "context_window_type": capabilities.get("context_window_type", "total"),
            "dynamic_context": bool(capabilities.get("dynamic_context", False)),
            "max_retries": int(connection.settings_json.get("max_retries", 2)),
            "timeout_seconds": float(connection.settings_json.get("timeout_seconds", 180)),
        }
        effort = result.pop("reasoning_effort", None)
        if effort is not None:
            reasoning = dict(capabilities.get("reasoning") or {})
            allowed = reasoning.get("effort_values") or []
            if not reasoning.get("supported") or effort not in allowed:
                raise ValueError(
                    f"reasoning effort {effort!r} is not supported by {model.model_id}"
                )
            mapped = (reasoning.get("value_map") or {}).get(effort, effort)
            settings = dict(result.get("model_settings") or {})
            if reasoning.get("adapter") == "reasoning_effort":
                settings["reasoning"] = {"effort": mapped}
            result["model_settings"] = settings
        required_model_settings = dict(provider_definition.get("required_model_settings") or {})
        if required_model_settings:
            settings = dict(result.get("model_settings") or {})
            settings.update(required_model_settings)
            result["model_settings"] = settings
        return result

    def _match_legacy_provider(self, provider: dict[str, Any]) -> str | None:
        name = str(provider.get("name", "")).lower()
        base_url = str(provider.get("base_url", "")).rstrip("/")
        for provider_id, definition in PROVIDER_CATALOG.items():
            aliases = [
                provider_id,
                str(definition.get("name", "")).lower(),
                *definition.get("aliases", []),
            ]
            urls = [
                str(item["base_url"]).rstrip("/")
                for item in definition.get("profiles", {}).values()
            ]
            if base_url and base_url in urls:
                return provider_id
            if name and name in aliases:
                return provider_id
        return None

    async def seed_legacy_connections(self, tenant_id: str = "default") -> None:
        async with self.db.sessions() as session:
            versions = (
                await session.scalars(
                    select(AgentVersionRecord).where(AgentVersionRecord.tenant_id == tenant_id)
                )
            ).all()
        for version in versions:
            config = dict(version.config_json or {})
            provider = dict(config.get("provider") or {})
            if provider.get("type") == "deterministic" or not provider.get("api_key_env"):
                continue
            provider_id = self._match_legacy_provider(provider)
            if not provider_id:
                continue
            async with self.db.sessions() as session:
                existing = await session.scalar(
                    select(ProviderConnectionRecord).where(
                        ProviderConnectionRecord.tenant_id == tenant_id,
                        ProviderConnectionRecord.provider == provider_id,
                        ProviderConnectionRecord.api_key_env == provider.get("api_key_env"),
                        ProviderConnectionRecord.base_url
                        == str(provider.get("base_url", "")).rstrip("/"),
                    )
                )
            if existing is not None:
                continue
            definition = self.definition(provider_id)
            profile = next(
                (
                    key
                    for key, endpoint in definition.get("profiles", {}).items()
                    if str(endpoint["base_url"]).rstrip("/")
                    == str(provider.get("base_url", "")).rstrip("/")
                ),
                definition.get("default_profile", "default"),
            )
            record = await self.create_connection(
                tenant_id,
                ProviderConnectionCreate(
                    name=f"{definition['name']}（已导入）",
                    provider=provider_id,
                    endpoint_profile=str(profile),
                    api_key_env=str(provider["api_key_env"]),
                ),
            )
            model_name = str(config.get("model", ""))
            if model_name:
                async with self.db.sessions() as session:
                    known = await session.scalar(
                        select(ProviderModelRecord).where(
                            ProviderModelRecord.connection_id == record.id,
                            ProviderModelRecord.model_id == model_name,
                        )
                    )
                if known is None:
                    await self.add_model(
                        tenant_id,
                        record.id,
                        ProviderModelCreate(model_id=model_name),
                    )
