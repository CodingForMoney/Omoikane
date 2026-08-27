from __future__ import annotations

from datetime import UTC, datetime

import pytest

from agent_system.models import CompactionRecord, SessionRecord
from agent_system.sessions import DatabaseSession

from .helpers import deterministic_compaction_config, published_agent


async def test_database_session_and_compaction_preserve_audit(container):
    record = SessionRecord(tenant_id="default")
    async with container.db.sessions() as session, session.begin():
        session.add(record)
    sdk_session = DatabaseSession(container.db, record.id)
    await sdk_session.add_items(
        [
            {
                "role": "user",
                "content": f"message-{index} " + "historical-padding " * 120,
            }
            for index in range(15)
        ]
    )
    compaction = await container.compaction.compact_session(
        record.id,
        deterministic_compaction_config(),
        force=True,
        strategy="portable",
    )
    assert compaction is not None
    projected = await sdk_session.get_items()
    canonical = await sdk_session.canonical_items()
    assert len(canonical) == 15
    assert len(projected) < len(canonical)
    assert projected[-1]["content"].startswith("message-14")
    assert projected[0]["role"] == "assistant"
    async with container.db.sessions() as session:
        stored = await session.get(CompactionRecord, compaction.id)
        assert stored.metrics_json["source_items"] == 15
        assert stored.metrics_json["memory_writes"] == 0
        assert stored.all_chunks_covered is True


async def test_database_session_normalizes_reasoning_separately(container):
    record = SessionRecord(tenant_id="default")
    async with container.db.sessions() as session, session.begin():
        session.add(record)
    sdk_session = DatabaseSession(container.db, record.id)
    await sdk_session.add_items(
        [
            {"role": "user", "content": "question"},
            {
                "type": "reasoning",
                "summary": [{"type": "summary_text", "text": "short reasoning"}],
                "content": [{"type": "reasoning_text", "text": "raw reasoning"}],
            },
            {
                "id": "assistant-message",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": "answer"}],
            },
        ]
    )

    messages = await sdk_session.chat_messages()

    assert messages == [
        {
            "id": messages[0]["id"],
            "seq": 1,
            "role": "user",
            "content": "question",
            "status": "completed",
        },
        {
            "id": "assistant-message",
            "seq": 3,
            "role": "assistant",
            "content": "answer",
            "status": "completed",
            "reasoning": "short reasoning",
            "reasoning_kind": "summary",
        },
    ]


async def test_database_session_clone_copies_canonical_items_without_projection(container):
    source = SessionRecord(tenant_id="default", scope={"source": "clone-test"})
    async with container.db.sessions() as session, session.begin():
        session.add(source)
    source_session = DatabaseSession(container.db, source.id)
    await source_session.add_items(
        [
            {"role": "user", "content": "remember CLONE-MARKER"},
            {"role": "assistant", "content": "acknowledged"},
        ]
    )

    clone = await source_session.clone(scope={"variant": "control"})
    cloned_session = DatabaseSession(container.db, clone.id)

    assert [row["item"] for row in await cloned_session.canonical_items()] == [
        row["item"] for row in await source_session.canonical_items()
    ]
    assert await cloned_session.get_items() == await source_session.get_items()
    assert clone.scope == {
        "source": "clone-test",
        "variant": "control",
        "cloned_from_session_id": source.id,
    }
    assert clone.active_projection_revision == 0


async def test_long_term_memory_retrieval_and_secret_rejection(container):
    memory = await container.memory.create(
        tenant_id="default",
        scope_type="project",
        scope_id="alpha",
        kind="procedural",
        content="When generating reports, cite the source artifact before drawing conclusions.",
        confidence=0.95,
        source={"actor": "test"},
    )
    results = await container.memory.retrieve(
        tenant_id="default",
        query="How should a report cite source artifacts?",
        scopes=[("project", "alpha")],
    )
    assert results[0]["id"] == memory.id
    with pytest.raises(ValueError, match="credential"):
        await container.memory.create(
            tenant_id="default",
            scope_type="project",
            scope_id="alpha",
            kind="semantic",
            content="api_key=fixture-secret-credential-value",
            confidence=1,
        )


async def test_compaction_preserves_system_and_pending_tool_state(container):
    record = SessionRecord(tenant_id="default")
    async with container.db.sessions() as session, session.begin():
        session.add(record)
    sdk_session = DatabaseSession(container.db, record.id)
    await sdk_session.add_items(
        [
            {"role": "system", "content": "Never disclose credentials."},
            *[
                {
                    "role": "user",
                    "content": f"ordinary-{index} " + "historical-padding " * 100,
                }
                for index in range(12)
            ],
            {
                "type": "function_call",
                "call_id": "pending-call",
                "name": "external_tool",
                "arguments": "{}",
            },
            {"role": "user", "content": "recent-one"},
            {"role": "user", "content": "recent-two"},
        ]
    )
    compaction = await container.compaction.compact_session(
        record.id,
        deterministic_compaction_config(),
        force=True,
        strategy="portable",
    )
    assert compaction is not None
    projected = await sdk_session.get_items()
    assert any(item.get("content") == "Never disclose credentials." for item in projected)
    assert any(item.get("call_id") == "pending-call" for item in projected)
    assert len(await sdk_session.canonical_items()) == 16


async def test_cost_catalog_is_versioned_and_budget_checked(container):
    from agent_system.models import PriceRecord

    price = PriceRecord(
        provider="test-provider",
        model="test-model",
        version="2026-08",
        input_per_million=1.0,
        output_per_million=2.0,
        effective_from=datetime.now(UTC),
    )
    async with container.db.sessions() as session, session.begin():
        session.add(price)
    _, cost = await container.costs.record(
        tenant_id="default",
        run_id=(await _completed_run_for_cost(container)),
        provider="test-provider",
        model="test-model",
        requests=1,
        input_tokens=1_000_000,
        output_tokens=500_000,
        total_tokens=1_500_000,
        raw={},
    )
    assert cost.amount == 2.0
    with pytest.raises(Exception, match="cost limit"):
        await container.costs.assert_within_run_budget(
            provider="test-provider",
            model="test-model",
            input_tokens=1_000_000,
            output_tokens=500_000,
            limit_usd=2.0,
        )


async def _completed_run_for_cost(container) -> str:
    from agent_system.models import RunRecord

    _, version = await published_agent(container, slug="cost-agent")
    run = RunRecord(
        tenant_id="default",
        agent_version_id=version.id,
        status="completed",
        input_json="x",
        config_hash=version.config_hash,
    )
    async with container.db.sessions() as session, session.begin():
        session.add(run)
    return run.id
