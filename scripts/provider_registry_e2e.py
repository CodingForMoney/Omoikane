from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path

import httpx
from dotenv import load_dotenv

from agent_system.api import create_app
from agent_system.config import Settings


async def main() -> None:
    load_dotenv(Path.cwd() / ".env", override=False)
    if not os.environ.get("MIMO_API_KEY"):
        raise SystemExit("MIMO_API_KEY is not configured")

    with tempfile.TemporaryDirectory(prefix="agent-provider-e2e-") as raw:
        root = Path(raw)
        settings = Settings(
            environment="development",
            database_url=f"sqlite+aiosqlite:///{root / 'agent-system.db'}",
            artifact_root=root / "artifacts",
            skill_root=root / "skills",
            sandbox_root=root / "sandboxes",
            run_state_secret="temporary-provider-e2e-secret-with-sufficient-entropy",
            tracing_disabled=True,
        )
        app = create_app(settings=settings, start_worker=False)
        async with app.router.lifespan_context(app):
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(
                transport=transport, base_url="http://agent-sdk"
            ) as client:
                connection_response = await client.post(
                    "/v1/provider-connections",
                    json={
                        "name": "MiMo E2E",
                        "provider": "xiaomi_mimo",
                        "endpoint_profile": "token_plan_cn",
                        "api_key_env": "MIMO_API_KEY",
                    },
                )
                connection_response.raise_for_status()
                connection = connection_response.json()

                validation_response = await client.post(
                    f"/v1/provider-connections/{connection['id']}/validate?sync_models=true"
                )
                validation_response.raise_for_status()
                validation = validation_response.json()

                models_response = await client.get(
                    f"/v1/provider-connections/{connection['id']}/models"
                )
                models_response.raise_for_status()
                models = models_response.json()["data"]
                model = next(item for item in models if item["model_id"] == "mimo-v2.5")

                agent_response = await client.post(
                    "/v1/agents",
                    json={"slug": "managed-mimo-e2e", "name": "Managed MiMo E2E"},
                )
                agent_response.raise_for_status()
                agent = agent_response.json()
                version_response = await client.post(
                    f"/v1/agents/{agent['id']}/versions",
                    json={
                        "config": {
                            "name": "Managed MiMo E2E",
                            "instructions": (
                                "Reply exactly with MANAGED-PROVIDER-OK and nothing else."
                            ),
                            "provider_connection_id": connection["id"],
                            "provider_model_id": model["id"],
                            "provider_options": {"structured_output_mode": "prompt"},
                            "reasoning_effort": "none",
                        }
                    },
                )
                version_response.raise_for_status()
                version = version_response.json()
                publish_response = await client.post(
                    f"/v1/agents/{agent['id']}/versions/{version['version']}/publish"
                )
                publish_response.raise_for_status()

                session_response = await client.post(
                    "/v1/sessions",
                    json={"scope": {"agent_version_id": version["id"]}},
                )
                session_response.raise_for_status()
                session = session_response.json()
                run_response = await client.post(
                    "/v1/runs",
                    json={
                        "agent_version_id": version["id"],
                        "session_id": session["id"],
                        "input": "Run the connection smoke test.",
                        "limits": {"max_turns": 5},
                    },
                )
                run_response.raise_for_status()
                run = run_response.json()
                processed = await app.state.container.runner.process_next()
                completed_response = await client.get(f"/v1/runs/{run['id']}")
                completed_response.raise_for_status()
                completed = completed_response.json()

                report = {
                    "connection_status": validation["status"],
                    "models_discovered": validation["models_discovered"],
                    "managed_config_fields": sorted(version["config_json"].keys()),
                    "provider_in_agent_version": "provider" in version["config_json"],
                    "model_in_agent_version": "model" in version["config_json"],
                    "run_processed": processed,
                    "run_status": completed["status"],
                    "output": completed["output_json"],
                    "credential_returned": any(
                        key in connection
                        for key in (
                            "api_key",
                            "api_key_ciphertext",
                            "api_key_checksum",
                        )
                    ),
                }
                print(json.dumps(report, ensure_ascii=False, indent=2))
                if completed["status"] != "completed":
                    raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
