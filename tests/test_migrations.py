from __future__ import annotations

import asyncio
import sqlite3

from alembic import command
from alembic.config import Config


async def test_alembic_upgrades_empty_database(tmp_path, monkeypatch):
    database = tmp_path / "migration.db"
    monkeypatch.setenv("AGENT_DATABASE_URL", f"sqlite+aiosqlite:///{database}")
    config = Config("alembic.ini")
    await asyncio.to_thread(command.upgrade, config, "head")

    def table_names() -> set[str]:
        with sqlite3.connect(database) as connection:
            return {
                row[0]
                for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
            }

    names = await asyncio.to_thread(table_names)
    assert {
        "agents",
        "runs",
        "run_events",
        "tool_executions",
        "memories",
        "artifacts",
        "context_projections",
        "context_projection_segments",
        "compaction_leases",
        "compaction_state",
        "compaction_source_chunks",
        "provider_capabilities",
        "provider_connections",
        "provider_models",
        "agent_settings",
    } <= names

    def column_names(table: str) -> set[str]:
        with sqlite3.connect(database) as connection:
            return {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}

    run_event_columns = await asyncio.to_thread(column_names, "run_events")
    assert {
        "published_at",
        "publish_attempts",
        "last_publish_error",
        "next_publish_at",
        "publish_lease_owner",
        "publish_lease_expires_at",
    } <= run_event_columns

    session_columns = await asyncio.to_thread(column_names, "sessions")
    assert {"revision", "active_projection_revision"} <= session_columns
    compaction_columns = await asyncio.to_thread(column_names, "compactions")
    assert {
        "status",
        "strategy",
        "parent_compaction_id",
        "source_to_seq",
        "source_revision",
        "summary_json",
        "validation_json",
        "tokens_before",
        "tokens_after",
        "attempt_id",
    } <= compaction_columns

    agent_version_columns = await asyncio.to_thread(column_names, "agent_versions")
    assert {
        "definition_format",
        "definition_source",
        "definition_json",
        "overrides_json",
        "global_defaults_revision",
        "platform_policy_revision",
    } <= agent_version_columns

    await asyncio.to_thread(command.downgrade, config, "base")
    assert "agents" not in await asyncio.to_thread(table_names)
