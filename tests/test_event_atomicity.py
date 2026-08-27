from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import select, update

from agent_system.models import RunEventRecord, RunRecord, now_utc

from .helpers import published_agent


async def _queued_run(container, slug: str):
    _, version = await published_agent(container, slug=slug)
    return await container.runner.create_run(
        tenant_id="default",
        agent_version_id=version.id,
        input_value="atomic event test",
        session_id=None,
        context={},
        limits={},
        idempotency_key=None,
    )


async def test_domain_state_and_event_roll_back_together(container):
    run = await _queued_run(container, "atomic-rollback")
    with pytest.raises(RuntimeError, match="abort transaction"):
        async with container.db.sessions() as session, session.begin():
            current = await session.scalar(
                select(RunRecord).where(RunRecord.id == run.id).with_for_update()
            )
            current.status = "failed"
            await container.events.append_in_transaction(
                session, current, "run.failed", {"code": "should_rollback"}
            )
            raise RuntimeError("abort transaction")

    async with container.db.sessions() as session:
        current = await session.get(RunRecord, run.id)
        rolled_back_event = await session.scalar(
            select(RunEventRecord).where(
                RunEventRecord.run_id == run.id,
                RunEventRecord.type == "run.failed",
            )
        )
    assert current.status == "queued"
    assert current.version == 1
    assert rolled_back_event is None


async def test_notification_failure_keeps_durable_outbox_and_retries(container, monkeypatch):
    original_publish = container.notifier.publish

    async def unavailable(run_id: str, seq: int) -> None:
        raise ConnectionError("redis unavailable")

    monkeypatch.setattr(container.notifier, "publish", unavailable)
    run = await _queued_run(container, "outbox-retry")

    async with container.db.sessions() as session:
        current = await session.get(RunRecord, run.id)
        event = await session.scalar(
            select(RunEventRecord).where(
                RunEventRecord.run_id == run.id,
                RunEventRecord.type == "run.created",
            )
        )
    assert current.status == "queued"
    assert event is not None
    assert event.published_at is None
    assert event.publish_attempts == 1
    assert "redis unavailable" in event.last_publish_error
    assert [item["type"] for item in await container.events.list(run.id)] == ["run.created"]

    monkeypatch.setattr(container.notifier, "publish", original_publish)
    async with container.db.sessions() as session, session.begin():
        await session.execute(
            update(RunEventRecord)
            .where(RunEventRecord.id == event.id)
            .values(next_publish_at=now_utc() - timedelta(seconds=1))
        )
    assert await container.events.dispatch_pending(run_id=run.id) == 1
    async with container.db.sessions() as session:
        published = await session.get(RunEventRecord, event.id)
    assert published.published_at is not None
    assert published.publish_attempts == 2
    assert published.last_publish_error is None


async def test_completed_state_cannot_commit_without_completed_event(container, monkeypatch):
    run = await _queued_run(container, "atomic-completion")
    original_append = container.events.append_in_transaction

    async def reject_completed_event(session, current, event_type, payload):
        if event_type == "run.completed":
            raise RuntimeError("simulated event insert failure")
        return await original_append(session, current, event_type, payload)

    monkeypatch.setattr(container.events, "append_in_transaction", reject_completed_event)
    assert await container.runner.process_next()

    async with container.db.sessions() as session:
        current = await session.get(RunRecord, run.id)
    event_types = [item["type"] for item in await container.events.list(run.id)]
    assert current.status == "failed"
    assert "run.completed" not in event_types
    assert event_types[-1] == "run.failed"
    assert current.error_json["code"] == "RuntimeError"


async def test_committed_terminal_state_is_not_overwritten_by_postprocessing_failure(
    container, monkeypatch
):
    run = await _queued_run(container, "terminal-is-immutable")

    async def fail_postprocessing(run_id: str):
        raise RuntimeError("memory postprocessing failed")

    monkeypatch.setattr(container.memory, "create_candidate_from_run", fail_postprocessing)
    assert await container.runner.process_next()

    async with container.db.sessions() as session:
        current = await session.get(RunRecord, run.id)
    event_types = [item["type"] for item in await container.events.list(run.id)]
    assert current.status == "completed"
    assert "run.completed" in event_types
    assert "run.failed" not in event_types
