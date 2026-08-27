from __future__ import annotations

import httpx

from agent_system.api import create_app

ROLE_DOCUMENT = """---
apiVersion: agentsdk/v1
kind: Agent
name: research-role
displayName: Research Role
description: Use for evidence-based research tasks.
---

# Role

You are a careful research specialist. Separate facts from inferences.
"""


async def _configured_client(test_settings):
    app = create_app(settings=test_settings, start_worker=False)
    lifespan = app.router.lifespan_context(app)
    await lifespan.__aenter__()
    transport = httpx.ASGITransport(app=app)
    client = httpx.AsyncClient(transport=transport, base_url="http://test")
    connection = (
        await client.post(
            "/v1/provider-connections?sync_models=false",
            json={
                "name": "MiMo global default",
                "provider": "xiaomi_mimo",
                "endpoint_profile": "token_plan_cn",
                "api_key": "test-provider-key",
            },
        )
    ).json()
    return app, lifespan, client, connection


async def test_markdown_role_inherits_versioned_global_defaults(test_settings):
    _app, lifespan, client, connection = await _configured_client(test_settings)
    try:
        settings = (await client.get("/v1/agent-settings")).json()
        assert settings["resolved_model"]["connection_id"] == connection["id"]
        assert settings["resolved_model"]["model_id"] == "mimo-v2.5"

        preview_response = await client.post(
            "/v1/agent-definitions/validate", json={"document": ROLE_DOCUMENT}
        )
        assert preview_response.status_code == 200, preview_response.text
        preview = preview_response.json()
        effective = preview["effective_config"]
        assert effective["provider_connection_id"] == connection["id"]
        assert (
            effective["compaction"]["context_window"]
            == settings["resolved_model"]["capabilities"]["context_window"]
        )
        assert "Global agent instructions" in effective["instructions"]
        assert "careful research specialist" in effective["instructions"]
        assert preview["provenance"]["model"] == "global"

        created_response = await client.post(
            "/v1/agents/from-definition",
            json={"document": ROLE_DOCUMENT, "publish": True},
        )
        assert created_response.status_code == 201, created_response.text
        created = created_response.json()
        assert created["agent"]["slug"] == "research-role"
        assert created["version"]["status"] == "published"
        assert created["version"]["definition_format"] == "agent_markdown_v1"
        assert created["version"]["global_defaults_revision"] == settings["defaults_revision"]
        assert created["version"]["config_hash"] == preview["config_hash"]
        assert created["version"]["config_json"] == effective

        exported = (
            await client.get(f"/v1/agents/{created['agent']['id']}/versions/1/definition")
        ).json()
        assert exported["document"].startswith("---\n")
        assert exported["definition"]["displayName"] == "Research Role"
        assert exported["effective_config"]["instructions"] == effective["instructions"]

        changed_defaults = settings["defaults"]
        changed_defaults["runtime"]["maxTurns"] = 33
        updated_response = await client.put(
            "/v1/agent-settings",
            json={
                "expectedRevision": settings["revision"],
                "globalInstructions": settings["global_instructions"] + "\nNew global rule.",
                "defaults": changed_defaults,
                "policy": settings["policy"],
            },
        )
        assert updated_response.status_code == 200, updated_response.text
        updated = updated_response.json()
        assert updated["defaults_revision"] == settings["defaults_revision"] + 1

        unchanged = (
            await client.get(f"/v1/agents/{created['agent']['id']}/versions/1/definition")
        ).json()
        assert "New global rule" not in unchanged["effective_config"]["instructions"]
        assert unchanged["effective_config"]["runtime_policy"]["max_turns"] == 20

        next_version_response = await client.post(
            f"/v1/agents/{created['agent']['id']}/versions/from-definition",
            json={"document": ROLE_DOCUMENT, "publish": True},
        )
        assert next_version_response.status_code == 201, next_version_response.text
        next_version = next_version_response.json()["version"]
        assert next_version["version"] == 2
        assert next_version["status"] == "published"
        assert next_version["global_defaults_revision"] == updated["defaults_revision"]
        assert "New global rule" in next_version["config_json"]["instructions"]
        assert next_version["config_json"]["runtime_policy"]["max_turns"] == 33

        mismatched = ROLE_DOCUMENT.replace("name: research-role", "name: another-role")
        mismatch_response = await client.post(
            f"/v1/agents/{created['agent']['id']}/versions/from-definition",
            json={"document": mismatched},
        )
        assert mismatch_response.status_code == 422
        assert "must match" in mismatch_response.text
    finally:
        await client.aclose()
        await lifespan.__aexit__(None, None, None)


async def test_agent_overrides_are_typed_and_platform_policy_wins(test_settings):
    _app, lifespan, client, _ = await _configured_client(test_settings)
    try:
        settings = (await client.get("/v1/agent-settings")).json()
        settings["policy"]["tools"]["denied"] = ["sandbox-exec"]
        settings["policy"]["runtime"]["maxTurns"] = 25
        update = await client.put(
            "/v1/agent-settings",
            json={
                "expectedRevision": settings["revision"],
                "globalInstructions": settings["global_instructions"],
                "defaults": settings["defaults"],
                "policy": settings["policy"],
            },
        )
        assert update.status_code == 200, update.text

        overridden = ROLE_DOCUMENT.replace(
            "description: Use for evidence-based research tasks.\n",
            "description: Use for evidence-based research tasks.\n"
            "runtime:\n  maxTurns: 80\n"
            "memory:\n  writeMode: disabled\n",
        )
        preview = (
            await client.post("/v1/agent-definitions/validate", json={"document": overridden})
        ).json()
        assert preview["effective_config"]["runtime_policy"]["max_turns"] == 25
        assert preview["effective_config"]["memory"]["write_mode"] == "disabled"
        assert preview["provenance"]["runtime.max_turns"] == "platform"

        forbidden_tool = ROLE_DOCUMENT.replace(
            "description: Use for evidence-based research tasks.\n",
            "description: Use for evidence-based research tasks.\n"
            "tools:\n  inherit: true\n  allow: [sandbox-exec]\n",
        )
        blocked = await client.post(
            "/v1/agent-definitions/validate", json={"document": forbidden_tool}
        )
        assert blocked.status_code == 422
        assert "denied by platform policy" in blocked.text

        unknown = ROLE_DOCUMENT.replace(
            "description: Use for evidence-based research tasks.\n",
            "description: Use for evidence-based research tasks.\nunknownSetting: true\n",
        )
        rejected = await client.post("/v1/agent-definitions/validate", json={"document": unknown})
        assert rejected.status_code == 422
        assert "extra_forbidden" in rejected.text
    finally:
        await client.aclose()
        await lifespan.__aexit__(None, None, None)
