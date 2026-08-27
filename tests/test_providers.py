from __future__ import annotations

import httpx
from sqlalchemy import select

from agent_system.api import create_app
from agent_system.models import ProviderConnectionRecord
from agent_system.providers import ProviderService


async def test_managed_provider_connection_and_agent_reference(test_settings):
    app = create_app(settings=test_settings, start_worker=False)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            definitions = (await client.get("/v1/provider-definitions")).json()["data"]
            provider_ids = {item["id"] for item in definitions}
            assert {
                "codex_bridge",
                "anthropic",
                "google_gemini",
                "cohere",
                "xai",
                "mistral",
                "groq",
                "together",
                "openrouter",
                "perplexity",
                "cerebras",
                "xiaomi_mimo",
                "deepseek",
                "alibaba_qwen",
                "zhipu_glm",
                "moonshot_kimi",
                "volcengine_ark",
                "baidu_qianfan",
                "tencent_hunyuan",
                "minimax",
                "siliconflow",
                "stepfun",
                "iflytek_spark",
                "modelscope",
                "custom_openai_compatible",
            } <= provider_ids
            reasoning_by_provider = {item["id"]: item["reasoning_effort"] for item in definitions}
            assert reasoning_by_provider["openai"]["scope"] == "all"
            assert reasoning_by_provider["codex_bridge"]["scope"] == "all"
            assert reasoning_by_provider["xiaomi_mimo"]["scope"] == "all"
            assert reasoning_by_provider["deepseek"]["scope"] == "all"
            assert reasoning_by_provider["together"]["scope"] == "some"
            assert reasoning_by_provider["anthropic"]["supported"] is False
            openai = next(item for item in definitions if item["id"] == "openai")
            sol = next(item for item in openai["models"] if item["id"] == "gpt-5.6-sol")
            assert sol["capabilities"]["context_window"] == 1_050_000
            assert sol["capabilities"]["max_output_tokens"] == 128_000

            secret = "provider-secret-value"
            created = await client.post(
                "/v1/provider-connections?sync_models=false",
                json={
                    "name": "MiMo managed",
                    "provider": "xiaomi_mimo",
                    "endpoint_profile": "token_plan_cn",
                    "api_key": secret,
                },
            )
            assert created.status_code == 201, created.text
            connection = created.json()
            assert connection["has_credential"] is True
            assert connection["credential_source"] == "encrypted"
            assert connection["custom_base_url"] is None
            assert connection["default_model"] == "mimo-v2.5"
            assert secret not in created.text

            listed = await client.get("/v1/provider-connections")
            assert secret not in listed.text
            assert listed.json()["data"][0]["key_hint"] == "…alue"

            models = (
                await client.get(f"/v1/provider-connections/{connection['id']}/models")
            ).json()["data"]
            mimo = next(item for item in models if item["model_id"] == "mimo-v2.5")
            mimo_pro = next(item for item in models if item["model_id"] == "mimo-v2.5-pro")
            assert mimo["capabilities_json"]["reasoning"]["effort_values"] == [
                "none",
                "high",
            ]
            changed_default = await client.patch(
                f"/v1/provider-connections/{connection['id']}",
                json={"default_model": mimo_pro["model_id"]},
            )
            assert changed_default.status_code == 200, changed_default.text
            assert changed_default.json()["default_model"] == "mimo-v2.5-pro"

            agent = (
                await client.post(
                    "/v1/agents",
                    json={"slug": "managed-provider", "name": "Managed Provider"},
                )
            ).json()
            version_response = await client.post(
                f"/v1/agents/{agent['id']}/versions",
                json={
                    "config": {
                        "name": "Managed Provider",
                        "instructions": "Be helpful.",
                        "provider_connection_id": connection["id"],
                        "provider_model_id": mimo["id"],
                        "provider_options": {"structured_output_mode": "prompt"},
                        "reasoning_effort": "high",
                        "compaction": {
                            "strategy": "auto",
                        },
                    }
                },
            )
            assert version_response.status_code == 201, version_response.text
            stored_config = version_response.json()["config_json"]
            assert "provider" not in stored_config
            assert "model" not in stored_config
            assert stored_config["provider_connection_id"] == connection["id"]
            assert stored_config["compaction"]["context_window"] == 1_048_576
            assert stored_config["compaction"]["context_window_type"] == "total"
            assert stored_config["compaction"]["context_window_source"] == "model_capability"

            resolved = await app.state.container.providers.resolve_agent_config(
                stored_config, "default"
            )
            assert resolved["model"] == "mimo-v2.5"
            assert resolved["provider"]["protocol"] == "responses"
            assert resolved["provider"]["_api_key"] == secret
            assert resolved["model_settings"]["reasoning"] == {"effort": "high"}

            async with app.state.container.db.sessions() as session:
                record = await session.scalar(
                    select(ProviderConnectionRecord).where(
                        ProviderConnectionRecord.id == connection["id"]
                    )
                )
            assert record is not None
            assert record.api_key_ciphertext is not None
            assert secret.encode() not in record.api_key_ciphertext


async def test_only_custom_provider_accepts_base_url(test_settings):
    app = create_app(settings=test_settings, start_worker=False)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            rejected = await client.post(
                "/v1/provider-connections?sync_models=false",
                json={
                    "name": "Bad override",
                    "provider": "deepseek",
                    "api_key": "secret",
                    "custom_base_url": "https://example.invalid/v1",
                },
            )
            assert rejected.status_code == 422
            assert "managed by the selected provider" in rejected.text

            custom = await client.post(
                "/v1/provider-connections?sync_models=false",
                json={
                    "name": "Private gateway",
                    "provider": "custom_openai_compatible",
                    "api_key": "secret",
                    "custom_base_url": "https://llm.example.com/v1",
                    "custom_protocol": "chat_completions",
                },
            )
            assert custom.status_code == 201, custom.text
            assert custom.json()["custom_base_url"] == "https://llm.example.com/v1"
            assert custom.json()["protocol"] == "chat_completions"


async def test_legacy_connection_default_model_is_backfilled(test_settings):
    app = create_app(settings=test_settings, start_worker=False)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            created = (
                await client.post(
                    "/v1/provider-connections?sync_models=false",
                    json={
                        "name": "Legacy MiMo",
                        "provider": "xiaomi_mimo",
                        "api_key": "secret",
                    },
                )
            ).json()
            cleared = await client.patch(
                f"/v1/provider-connections/{created['id']}",
                json={"default_model": None},
            )
            assert cleared.status_code == 200, cleared.text
            assert cleared.json()["default_model"] is None

            await app.state.container.providers.backfill_default_models()
            restored = await client.get(f"/v1/provider-connections/{created['id']}")
            assert restored.json()["default_model"] == "mimo-v2.5"


async def test_agent_version_rejects_effort_for_unsupported_model(test_settings):
    app = create_app(settings=test_settings, start_worker=False)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            connection = (
                await client.post(
                    "/v1/provider-connections?sync_models=false",
                    json={"name": "Cohere", "provider": "cohere", "api_key": "secret"},
                )
            ).json()
            models = (
                await client.get(f"/v1/provider-connections/{connection['id']}/models")
            ).json()["data"]
            model = next(item for item in models if item["model_id"] == "command-a-03-2025")
            agent = (
                await client.post("/v1/agents", json={"slug": "no-effort", "name": "No Effort"})
            ).json()
            config = {
                "name": "No Effort",
                "instructions": "Be helpful.",
                "provider_connection_id": connection["id"],
                "provider_model_id": model["id"],
                "reasoning_effort": "high",
                "compaction": {"strategy": "auto", "context_window": 128_000},
            }
            rejected = await client.post(
                f"/v1/agents/{agent['id']}/versions", json={"config": config}
            )
            assert rejected.status_code == 422, rejected.text
            assert "is not supported" in rejected.text

            config.pop("reasoning_effort")
            accepted = await client.post(
                f"/v1/agents/{agent['id']}/versions", json={"config": config}
            )
            assert accepted.status_code == 201, accepted.text


async def test_anthropic_connection_uses_agents_sdk_litellm_adapter(test_settings):
    app = create_app(settings=test_settings, start_worker=False)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            connection_response = await client.post(
                "/v1/provider-connections?sync_models=false",
                json={
                    "name": "Claude managed",
                    "provider": "anthropic",
                    "api_key": "anthropic-secret",
                },
            )
            assert connection_response.status_code == 201, connection_response.text
            connection = connection_response.json()
            assert connection["protocol"] == "litellm"
            assert connection["custom_base_url"] is None

            models = (
                await client.get(f"/v1/provider-connections/{connection['id']}/models")
            ).json()["data"]
            sonnet = next(item for item in models if item["model_id"] == "claude-sonnet-4-6")
            configured = {
                "name": "Claude Agent",
                "instructions": "Be helpful.",
                "provider_connection_id": connection["id"],
                "provider_model_id": sonnet["id"],
                "compaction": {"strategy": "auto", "context_window": 300_000},
            }
            configured = await app.state.container.providers.apply_model_defaults(
                "default", configured
            )
            assert configured["compaction"]["context_window"] == 300_000
            assert configured["compaction"]["max_input_tokens"] == 300_000
            assert configured["compaction"]["context_window_source"] == "user"
            resolved = await app.state.container.providers.resolve_agent_config(
                configured, "default"
            )
            assert resolved["provider"]["type"] == "litellm"
            assert resolved["provider"]["litellm_prefix"] == "anthropic"
            assert resolved["provider"]["_api_key"] == "anthropic-secret"

            model = app.state.container.factory._build_model(resolved, [])
            assert type(model).__name__ == "LitellmModel"
            assert model.model == "anthropic/claude-sonnet-4-6"


async def test_codex_bridge_uses_responses_and_forces_stateless_settings(test_settings):
    app = create_app(settings=test_settings, start_worker=False)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            created = await client.post(
                "/v1/provider-connections?sync_models=false",
                json={
                    "name": "Local Codex Bridge",
                    "provider": "codex_bridge",
                    "api_key": "bridge-secret",
                },
            )
            assert created.status_code == 201, created.text
            connection = created.json()
            assert connection["protocol"] == "responses"
            assert connection["custom_base_url"] is None
            assert "bridge-secret" not in created.text

            models = (
                await client.get(f"/v1/provider-connections/{connection['id']}/models")
            ).json()["data"]
            sol = next(item for item in models if item["model_id"] == "gpt-5.6-sol")
            luna = next(item for item in models if item["model_id"] == "gpt-5.6-luna")
            assert sol["capabilities_json"]["context_window"] == 258_400
            assert luna["capabilities_json"]["context_window"] == 258_400
            assert sol["capabilities_json"]["reasoning"]["effort_values"] == [
                "none",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
            ]

            resolved = await app.state.container.providers.resolve_agent_config(
                {
                    "name": "Codex Bridge Agent",
                    "instructions": "Be helpful.",
                    "provider_connection_id": connection["id"],
                    "provider_model_id": sol["id"],
                    "reasoning_effort": "high",
                    "model_settings": {"store": True},
                    "compaction": {"strategy": "auto", "context_window": 258_400},
                },
                "default",
            )
            assert resolved["provider"]["type"] == "openai_compatible"
            assert resolved["provider"]["protocol"] == "responses"
            assert resolved["provider"]["base_url"] == "http://127.0.0.1:3456/v1"
            assert resolved["provider"]["supports_native_compaction"] is False
            assert resolved["provider"]["portable_summary_protocol"] == "responses"
            assert resolved["provider"]["context_window"] == 258_400
            assert resolved["model_settings"]["store"] is False
            assert resolved["model_settings"]["reasoning"] == {"effort": "high"}

            clients = []
            model = app.state.container.factory._build_model(resolved, clients)
            try:
                assert type(model).__name__ == "OpenAIResponsesModel"
                assert model.model == "gpt-5.6-sol"
            finally:
                for openai_client in clients:
                    await openai_client.close()


async def test_connection_creation_auto_syncs_models_without_losing_failed_connections(
    test_settings, monkeypatch
):
    async def fake_discover(self, record, key):
        assert record.provider == "xai"
        assert key == "xai-secret"
        return [{"id": "grok-auto-discovered"}]

    monkeypatch.setattr(ProviderService, "_discover_models", fake_discover)
    monkeypatch.delenv("MISSING_PROVIDER_KEY", raising=False)
    app = create_app(settings=test_settings, start_worker=False)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            created = await client.post(
                "/v1/provider-connections",
                json={"name": "Auto sync", "provider": "xai", "api_key": "xai-secret"},
            )
            assert created.status_code == 201, created.text
            payload = created.json()
            assert payload["status"] == "active"
            assert payload["model_sync"] == {
                "status": "active",
                "models_discovered": 1,
                "model_ids": ["grok-auto-discovered"],
                "default_model": "grok-auto-discovered",
                "error": None,
            }
            assert payload["default_model"] == "grok-auto-discovered"
            models = (await client.get(f"/v1/provider-connections/{payload['id']}/models")).json()[
                "data"
            ]
            assert any(item["model_id"] == "grok-auto-discovered" for item in models)

            missing = await client.post(
                "/v1/provider-connections",
                json={
                    "name": "Missing env",
                    "provider": "openai",
                    "api_key_env": "MISSING_PROVIDER_KEY",
                },
            )
            assert missing.status_code == 201, missing.text
            missing_payload = missing.json()
            assert missing_payload["status"] == "configured"
            assert "MISSING_PROVIDER_KEY" in missing_payload["model_sync"]["error"]


async def test_native_foreign_model_discovery_parsers(container, monkeypatch):
    requests: list[dict] = []
    payloads = {
        "https://api.anthropic.com/v1/models": {
            "data": [
                {
                    "id": "claude-sonnet-4-6",
                    "display_name": "Claude Sonnet 4.6",
                    "max_input_tokens": 1_000_000,
                    "max_tokens": 64_000,
                }
            ]
        },
        "https://generativelanguage.googleapis.com/v1beta/models": {
            "models": [
                {
                    "name": "models/gemini-3-flash-preview",
                    "displayName": "Gemini 3 Flash",
                    "supportedGenerationMethods": ["generateContent"],
                    "inputTokenLimit": 1_048_576,
                    "outputTokenLimit": 65_536,
                },
                {
                    "name": "models/text-embedding-004",
                    "supportedGenerationMethods": ["embedContent"],
                },
            ]
        },
        "https://api.cohere.com/v1/models": {
            "models": [
                {"name": "command-a-plus-05-2026", "context_length": 256_000},
                {"name": "retired-command", "is_deprecated": True},
            ]
        },
        "https://api.mistral.ai/v1/models": [
            {
                "id": "mistral-large-latest",
                "max_context_length": 128_000,
                "capabilities": {"completion_chat": True, "function_calling": True},
            },
            {
                "id": "archived-model",
                "archived": True,
                "capabilities": {"completion_chat": True},
            },
        ],
        "https://api.together.ai/v1/models": [
            {
                "id": "openai/gpt-oss-120b",
                "type": "chat",
                "display_name": "GPT-OSS 120B",
                "context_length": 131_072,
            },
            {"id": "image-model", "type": "image"},
        ],
        "https://api.perplexity.ai/v1/models": {
            "data": [
                {"id": "perplexity/sonar", "owned_by": "perplexity"},
                {"id": "anthropic/claude-sonnet-4-6", "owned_by": "anthropic"},
            ]
        },
        "https://api.groq.com/openai/v1/models": {
            "data": [
                {
                    "id": "openai/gpt-oss-120b",
                    "active": True,
                    "context_window": 131_072,
                    "max_completion_tokens": 65_536,
                }
            ]
        },
        "https://openrouter.ai/api/v1/models": {
            "data": [
                {
                    "id": "vendor/vision-model",
                    "name": "Vision Model",
                    "context_length": 262_144,
                    "architecture": {"input_modalities": ["text", "image"]},
                    "top_provider": {"max_completion_tokens": 32_768},
                }
            ]
        },
    }

    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    class FakeAsyncClient:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, **kwargs):
            requests.append({"url": url, **kwargs})
            return FakeResponse(payloads[url])

    monkeypatch.setattr("agent_system.providers.httpx.AsyncClient", FakeAsyncClient)
    cases = [
        ("anthropic", "https://api.anthropic.com/v1", ["claude-sonnet-4-6"]),
        (
            "google_gemini",
            "https://generativelanguage.googleapis.com/v1beta",
            ["gemini-3-flash-preview"],
        ),
        ("cohere", "https://api.cohere.ai/compatibility/v1", ["command-a-plus-05-2026"]),
        ("mistral", "https://api.mistral.ai/v1", ["mistral-large-latest"]),
        ("together", "https://api.together.ai/v1", ["openai/gpt-oss-120b"]),
        ("perplexity", "https://api.perplexity.ai", ["sonar"]),
        ("groq", "https://api.groq.com/openai/v1", ["openai/gpt-oss-120b"]),
        ("openrouter", "https://openrouter.ai/api/v1", ["vendor/vision-model"]),
    ]
    for provider, base_url, expected in cases:
        record = ProviderConnectionRecord(
            tenant_id="default",
            name=provider,
            provider=provider,
            endpoint_profile="default",
            base_url=base_url,
            protocol="litellm"
            if provider in {"anthropic", "google_gemini"}
            else "chat_completions",
            settings_json={},
        )
        discovered = await container.providers._discover_models(record, "provider-key")
        assert [item["id"] for item in discovered] == expected
        if provider == "anthropic":
            assert discovered[0]["capabilities"]["max_input_tokens"] == 1_000_000
            assert discovered[0]["capabilities"]["max_output_tokens"] == 64_000
            assert discovered[0]["capabilities"]["context_window_type"] == "input"
        if provider == "google_gemini":
            assert discovered[0]["capabilities"]["max_input_tokens"] == 1_048_576
        if provider == "groq":
            assert discovered[0]["capabilities"]["context_window"] == 131_072
            assert discovered[0]["capabilities"]["max_output_tokens"] == 65_536
        if provider == "openrouter":
            assert discovered[0]["capabilities"]["vision"] is True

    google_request = next(item for item in requests if "generativelanguage" in item["url"])
    assert google_request["headers"] == {"x-goog-api-key": "provider-key"}
    assert "provider-key" not in google_request["url"]


async def test_remote_capabilities_override_builtin_without_losing_catalog_contract(
    test_settings, monkeypatch
):
    async def fake_discover(self, record, key):
        assert record.provider == "xai"
        return [
            {
                "id": "grok-4.3",
                "display_name": "Grok 4.3 Live",
                "capabilities": {
                    "context_window": 900_000,
                    "capability_source": "remote",
                },
            }
        ]

    monkeypatch.setattr(ProviderService, "_discover_models", fake_discover)
    app = create_app(settings=test_settings, start_worker=False)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            connection = (
                await client.post(
                    "/v1/provider-connections?sync_models=false",
                    json={"name": "xAI", "provider": "xai", "api_key": "secret"},
                )
            ).json()
            validated = await client.post(
                f"/v1/provider-connections/{connection['id']}/validate?sync_models=true"
            )
            assert validated.status_code == 200, validated.text
            models = (
                await client.get(f"/v1/provider-connections/{connection['id']}/models")
            ).json()["data"]
            grok = next(item for item in models if item["model_id"] == "grok-4.3")
            assert grok["display_name"] == "Grok 4.3 Live"
            assert grok["capabilities_json"]["context_window"] == 900_000
            assert grok["capabilities_json"]["tools"] is True
            assert grok["capabilities_json"]["capability_source"] == "remote"


async def test_dynamic_router_accepts_explicit_agent_context_override(test_settings):
    app = create_app(settings=test_settings, start_worker=False)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            connection = (
                await client.post(
                    "/v1/provider-connections?sync_models=false",
                    json={"name": "Ark", "provider": "volcengine_ark", "api_key": "secret"},
                )
            ).json()
            models = (
                await client.get(f"/v1/provider-connections/{connection['id']}/models")
            ).json()["data"]
            router = next(item for item in models if item["model_id"] == "ark-code-latest")
            agent = (
                await client.post(
                    "/v1/agents", json={"slug": "router-agent", "name": "Router Agent"}
                )
            ).json()
            created = await client.post(
                f"/v1/agents/{agent['id']}/versions",
                json={
                    "config": {
                        "name": "Router Agent",
                        "instructions": "Be helpful.",
                        "provider_connection_id": connection["id"],
                        "provider_model_id": router["id"],
                        "compaction": {
                            "strategy": "auto",
                            "context_window": 999_999,
                        },
                    }
                },
            )
            assert created.status_code == 201, created.text
            compaction = created.json()["config_json"]["compaction"]
            assert compaction["context_window"] == 999_999
            assert compaction["context_window_source"] == "user"
