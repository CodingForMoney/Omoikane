from __future__ import annotations

import httpx

from agent_system.api import create_app
from agent_system.runtime_versions import OPENAI_AGENTS_SDK_VERSION
from agent_system.sessions import DatabaseSession

from .helpers import deterministic_compaction_config


async def test_rest_api_resources_and_run(test_settings):
    app = create_app(settings=test_settings, start_worker=False)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            health = await client.get("/healthz")
            assert health.json()["status"] == "ok"
            assert health.json()["sdk_version"] == OPENAI_AGENTS_SDK_VERSION
            agent = (
                await client.post("/v1/agents", json={"slug": "api-agent", "name": "API Agent"})
            ).json()
            version_response = await client.post(
                f"/v1/agents/{agent['id']}/versions",
                json={
                    "config": {
                        "name": "API Agent",
                        "model": "deterministic-test-model",
                        "instructions": "Return API-OK.",
                        "provider": {"type": "deterministic", "response_text": "API-OK"},
                        "compaction": deterministic_compaction_config()["compaction"],
                    }
                },
            )
            assert version_response.status_code == 201, version_response.text
            version = version_response.json()
            publish = await client.post(f"/v1/agents/{agent['id']}/versions/1/publish")
            assert publish.status_code == 200
            conversation = (
                await client.post(
                    "/v1/sessions",
                    json={
                        "scope": {
                            "agent_id": agent["id"],
                            "agent_version_id": version["id"],
                            "source": "agent-sdk-demo",
                        }
                    },
                )
            ).json()
            run_response = await client.post(
                "/v1/runs",
                headers={"Idempotency-Key": "api-run"},
                json={
                    "agent_version_id": version["id"],
                    "input": "hello",
                    "session_id": conversation["id"],
                },
            )
            assert run_response.status_code == 202, run_response.text
            run = run_response.json()
            container = app.state.container
            assert await container.runner.process_next()
            completed = (await client.get(f"/v1/runs/{run['id']}")).json()
            assert completed["status"] == "completed"
            assert completed["output_json"] == "API-OK"
            session_list = (await client.get("/v1/sessions")).json()["data"]
            listed_session = next(item for item in session_list if item["id"] == conversation["id"])
            assert listed_session["agent_id"] == agent["id"]
            assert listed_session["agent_version_id"] == version["id"]
            assert listed_session["title"] == "hello"
            chat = (await client.get(f"/v1/sessions/{conversation['id']}/chat-messages")).json()
            assert chat["view"] == "canonical_chat"
            assert [(item["role"], item["content"]) for item in chat["data"]] == [
                ("user", "hello"),
                ("assistant", "API-OK"),
            ]
            events = (await client.get(f"/v1/runs/{run['id']}/events")).json()["data"]
            assert [event["seq"] for event in events] == list(range(1, len(events) + 1))
            assert events[-1]["type"] == "memory.updated"
            stream = await client.get(f"/v1/runs/{run['id']}/stream")
            assert stream.status_code == 200
            assert "event: run.completed" in stream.text
            assert f"id: {events[-1]['seq']}" in stream.text

            sdk_session = DatabaseSession(container.db, conversation["id"])
            await sdk_session.add_items(
                [
                    {
                        "role": "user",
                        "content": f"api-history-{index} " + "old context " * 200,
                    }
                    for index in range(14)
                ]
            )
            compacted = await client.post(
                f"/v1/sessions/{conversation['id']}/compact",
                json={
                    "agent_version_id": version["id"],
                    "strategy": "portable",
                    "force": True,
                },
            )
            assert compacted.status_code == 200, compacted.text
            compaction = compacted.json()["compaction"]
            assert compaction["status"] == "active"
            preview = await client.get(f"/v1/sessions/{conversation['id']}/context-preview")
            assert preview.json()["projection"]["compaction_id"] == compaction["id"]
            listed = await client.get(f"/v1/sessions/{conversation['id']}/compactions")
            assert listed.json()["data"][0]["id"] == compaction["id"]
            detail = await client.get(
                f"/v1/sessions/{conversation['id']}/compactions/{compaction['id']}"
            )
            assert detail.json()["validation_json"]["valid"] is True
            model_view = await client.get(f"/v1/sessions/{conversation['id']}/messages")
            audit_view = await client.get(
                f"/v1/sessions/{conversation['id']}/messages?include_compacted=true"
            )
            assert model_view.json()["view"] == "model_projection"
            assert audit_view.json()["view"] == "canonical_transcript"
            assert len(model_view.json()["data"]) < len(audit_view.json()["data"])
            restored = await client.post(
                f"/v1/sessions/{conversation['id']}/compactions/{compaction['id']}/restore"
            )
            assert restored.status_code == 200
            assert restored.json()["active_projection_revision"] == 0


async def test_artifact_upload_download_and_memory_api(test_settings):
    app = create_app(settings=test_settings, start_worker=False)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            upload = await client.post(
                "/v1/artifacts",
                files={"file": ("note.txt", b"artifact-body", "text/plain")},
            )
            assert upload.status_code == 201
            artifact = upload.json()
            download = await client.get(f"/v1/artifacts/{artifact['id']}/download")
            assert download.content == b"artifact-body"
            deleted = await client.delete(f"/v1/artifacts/{artifact['id']}")
            assert deleted.status_code == 204
            assert (await client.get(f"/v1/artifacts/{artifact['id']}/download")).status_code == 404
            created = await client.post(
                "/v1/memories",
                json={
                    "scope_type": "project",
                    "scope_id": "api-project",
                    "kind": "semantic",
                    "content": "Use concise project reports.",
                    "confidence": 0.9,
                },
            )
            assert created.status_code == 201
            listed = (await client.get("/v1/memories?scope_id=api-project")).json()["data"]
            assert len(listed) == 1
