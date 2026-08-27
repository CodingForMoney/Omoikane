from __future__ import annotations

from pathlib import Path

import pytest
import pytest_asyncio

from agent_system.config import Settings
from agent_system.container import Container, create_container


@pytest.fixture
def test_settings(tmp_path: Path) -> Settings:
    return Settings(
        environment="test",
        database_url=f"sqlite+aiosqlite:///{tmp_path}/agent-system.db",
        artifact_root=tmp_path / "artifacts",
        skill_root=tmp_path / "skills",
        sandbox_root=tmp_path / "sandboxes",
        run_state_secret="test-run-state-secret-with-sufficient-entropy",
        tracing_disabled=True,
        worker_poll_seconds=0.01,
        run_lease_seconds=10,
        sse_heartbeat_seconds=1,
    )


@pytest_asyncio.fixture
async def container(test_settings: Settings) -> Container:
    result = await create_container(settings=test_settings, start_worker=False)
    try:
        yield result
    finally:
        await result.close()
