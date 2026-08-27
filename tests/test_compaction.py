from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

from agent_system.compaction import (
    CHECKPOINT_SCHEMA,
    CompactionBusy,
    CompactionConfig,
    CompactionConflict,
    DeterministicTokenCounter,
    NativeResponsesStrategy,
    PortableSummaryStrategy,
    ProjectedItem,
    SummaryValidationError,
    derive_authoritative_checkpoint_state,
)
from agent_system.models import (
    ArtifactRecord,
    CompactionRecord,
    CompactionStateRecord,
    ContextProjectionRecord,
    MemoryRecord,
    ProviderCapabilityRecord,
    SessionRecord,
)
from agent_system.sessions import DatabaseSession

from .helpers import deterministic_compaction_config


def historical_items(count: int, *, prefix: str = "history") -> list[dict]:
    return [
        {
            "role": "user",
            "content": f"{prefix}-{index} " + "repeated historical context " * 100,
        }
        for index in range(count)
    ]


def test_input_limit_context_does_not_double_reserve_output_tokens():
    config = CompactionConfig.from_agent_config(
        {
            "model": "input-limited-model",
            "provider": {"type": "openai_compatible"},
            "compaction": {
                "context_window": 100_000,
                "max_input_tokens": 100_000,
                "context_window_type": "input",
                "reserved_output_tokens": 10_000,
                "reserved_tool_loop_tokens": 0,
                "safety_margin_tokens": 0,
                "trigger_ratio": 0.5,
                "summary_prompt_reserve_tokens": 4_096,
                "summary_output_tokens": 8_192,
            },
        }
    )

    assert config.high_watermark_tokens == 50_000
    assert config.summary_input_budget == 95_904


async def test_portable_summary_uses_litellm_provider_prefix(monkeypatch):
    checkpoint = {
        "objective": {"current_goal": "test", "success_criteria": []},
        "constraints": [],
        "decisions": [],
        "progress": {"done": [], "in_progress": [], "blocked": [], "next_actions": []},
        "execution_state": {
            "authority": "runtime_derived",
            "source_to_seq": 0,
            "responded_user_turn_count": 0,
            "last_responded_user_source_seq": 0,
            "pending_user_turn_count": 0,
            "recent_pending_user_inputs": [],
            "completed_tool_call_count": 0,
            "recent_completed_tool_calls": [],
            "pending_tool_calls": [],
            "approvals": [],
        },
        "active_task": {"latest_unfulfilled_user_input": "test", "source_seq": 1},
        "completed_actions": [],
        "artifacts": [],
        "relevant_files": [],
        "unresolved_questions": [],
        "exact_identifiers": [],
        "tool_and_approval_state_refs": [],
        "narrative_summary": "test",
    }
    captured: dict = {}

    async def fake_completion(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    finish_reason="stop",
                    message=SimpleNamespace(content=json.dumps(checkpoint)),
                )
            ],
            usage=SimpleNamespace(prompt_tokens=21, completion_tokens=13),
        )

    monkeypatch.setattr("litellm.acompletion", fake_completion)
    agent_config = deterministic_compaction_config()
    agent_config["model"] = "claude-sonnet-4-6"
    agent_config["provider"] = {
        "type": "litellm",
        "protocol": "litellm",
        "litellm_prefix": "anthropic",
        "_api_key": "test-key",
    }
    config = CompactionConfig.from_agent_config(agent_config)
    strategy = PortableSummaryStrategy(DeterministicTokenCounter(), config)

    result = await strategy._call("summarize")

    assert result == checkpoint
    assert captured["model"] == "anthropic/claude-sonnet-4-6"
    assert captured["api_key"] == "test-key"
    assert strategy.input_tokens == 21
    assert strategy.output_tokens == 13


async def test_portable_summary_can_use_responses_only_provider():
    checkpoint = {
        "objective": {"current_goal": "test", "success_criteria": []},
        "constraints": [],
        "decisions": [],
        "progress": {"done": [], "in_progress": [], "blocked": [], "next_actions": []},
        "execution_state": {
            "authority": "runtime_derived",
            "source_to_seq": 0,
            "responded_user_turn_count": 0,
            "last_responded_user_source_seq": 0,
            "pending_user_turn_count": 0,
            "recent_pending_user_inputs": [],
            "completed_tool_call_count": 0,
            "recent_completed_tool_calls": [],
            "pending_tool_calls": [],
            "approvals": [],
        },
        "active_task": {"latest_unfulfilled_user_input": "test", "source_seq": 1},
        "completed_actions": [],
        "artifacts": [],
        "relevant_files": [],
        "unresolved_questions": [],
        "exact_identifiers": [],
        "tool_and_approval_state_refs": [],
        "narrative_summary": "test",
    }
    captured: dict = {}

    class FakeResponses:
        async def create(self, **kwargs):
            captured.update(kwargs)
            return SimpleNamespace(
                status="completed",
                output_text=json.dumps(checkpoint),
                usage=SimpleNamespace(input_tokens=34, output_tokens=21),
            )

    class FakeClient:
        responses = FakeResponses()

        async def close(self):
            return None

    agent_config = deterministic_compaction_config()
    agent_config["model"] = "gpt-5.6-sol"
    agent_config["provider"] = {
        "type": "openai_compatible",
        "protocol": "responses",
        "portable_summary_protocol": "responses",
        "supports_native_compaction": False,
        "_api_key": "test-key",
    }
    config = CompactionConfig.from_agent_config(agent_config)
    strategy = PortableSummaryStrategy(DeterministicTokenCounter(), config)
    strategy._client = FakeClient()

    result = await strategy._call("summarize")

    assert result == checkpoint
    assert captured["model"] == "gpt-5.6-sol"
    assert captured["store"] is False
    assert captured["max_output_tokens"] == 1024
    assert captured["text"]["format"]["schema"] == CHECKPOINT_SCHEMA
    assert strategy.input_tokens == 34
    assert strategy.output_tokens == 21


async def test_native_responses_compaction_records_provider_usage():
    captured: dict = {}

    class FakeResponses:
        async def compact(self, **kwargs):
            captured.update(kwargs)
            return SimpleNamespace(
                output=[
                    {
                        "type": "compaction",
                        "id": "cmp_usage_contract",
                        "encrypted_content": "opaque-provider-state",
                    }
                ],
                usage=SimpleNamespace(input_tokens=139, output_tokens=438),
            )

    class FakeClient:
        responses = FakeResponses()

        async def close(self):
            return None

    agent_config = deterministic_compaction_config()
    agent_config["model"] = "gpt-5.6-sol"
    agent_config["provider"] = {
        "type": "openai",
        "protocol": "responses",
        "_api_key": "test-key",
    }
    strategy = NativeResponsesStrategy(CompactionConfig.from_agent_config(agent_config))
    strategy.client = FakeClient()

    result = await strategy.compact([{"role": "user", "content": "compact this"}])

    assert captured == {
        "model": "gpt-5.6-sol",
        "input": [{"role": "user", "content": "compact this"}],
    }
    assert result[0]["type"] == "compaction"
    assert strategy.input_tokens == 139
    assert strategy.output_tokens == 438


async def new_session(container, items: list[dict]) -> tuple[SessionRecord, DatabaseSession]:
    record = SessionRecord(tenant_id="default")
    async with container.db.sessions() as session, session.begin():
        session.add(record)
    sdk_session = DatabaseSession(container.db, record.id)
    await sdk_session.add_items(items)
    return record, sdk_session


async def counts(container, session_id: str) -> tuple[int, int, int]:
    async with container.db.sessions() as session:
        canonical = await session.scalar(select(func.count()).select_from(MemoryRecord))
        projections = await session.scalar(
            select(func.count())
            .select_from(ContextProjectionRecord)
            .where(ContextProjectionRecord.session_id == session_id)
        )
        compactions = await session.scalar(
            select(func.count())
            .select_from(CompactionRecord)
            .where(CompactionRecord.session_id == session_id)
        )
    return int(canonical or 0), int(projections or 0), int(compactions or 0)


async def test_summary_failure_is_hard_noop_with_cooldown(container, monkeypatch):
    record, sdk_session = await new_session(container, historical_items(14))
    before = await sdk_session.canonical_items()
    memory_before, projection_before, _ = await counts(container, record.id)

    async def fail_summary(self, *args, **kwargs):
        raise SummaryValidationError("synthetic invalid summary")

    monkeypatch.setattr(PortableSummaryStrategy, "summarize_chunk", fail_summary)
    with pytest.raises(SummaryValidationError, match="synthetic invalid summary"):
        await container.compaction.compact_session(
            record.id,
            deterministic_compaction_config(),
            force=True,
            strategy="portable",
        )

    after = await sdk_session.canonical_items()
    memory_after, projection_after, _ = await counts(container, record.id)
    assert after == before
    assert memory_after == memory_before
    assert projection_after == projection_before == 0
    async with container.db.sessions() as session:
        failed = await session.scalar(
            select(CompactionRecord)
            .where(CompactionRecord.session_id == record.id)
            .order_by(CompactionRecord.created_at.desc())
        )
        state = await session.get(CompactionStateRecord, record.id)
    assert failed.status == "failed"
    assert state.state == "compaction_blocked"
    assert state.cooldown_until is not None


def test_runtime_derives_user_tool_and_approval_state_without_model_inference():
    state = derive_authoritative_checkpoint_state(
        [
            ProjectedItem({"role": "user", "content": "first request"}, 1, 1),
            ProjectedItem(
                {
                    "type": "function_call",
                    "call_id": "call-complete",
                    "name": "lookup",
                    "arguments": "{}",
                },
                2,
                2,
            ),
            ProjectedItem(
                {
                    "type": "function_call_output",
                    "call_id": "call-complete",
                    "output": "done",
                },
                3,
                3,
            ),
            ProjectedItem({"role": "assistant", "content": "first answer"}, 4, 4),
            ProjectedItem({"role": "user", "content": "second request"}, 5, 5),
            ProjectedItem(
                {
                    "type": "function_call",
                    "call_id": "call-pending",
                    "name": "publish",
                    "arguments": "{}",
                },
                6,
                6,
            ),
        ],
        [
            {
                "approval_id": "approval-pending",
                "interruption_id": "interrupt-1",
                "tool_name": "publish",
                "status": "pending",
            }
        ],
    )

    execution = state["execution_state"]
    assert execution["authority"] == "runtime_derived"
    assert execution["responded_user_turn_count"] == 1
    assert execution["last_responded_user_source_seq"] == 1
    assert execution["pending_user_turn_count"] == 1
    assert execution["recent_pending_user_inputs"][0]["source_seq"] == 5
    assert execution["recent_completed_tool_calls"] == [
        {"call_id": "call-complete", "call_seq": 2, "output_seq": 3}
    ]
    assert execution["pending_tool_calls"] == [
        {"call_id": "call-pending", "call_seq": 6}
    ]
    assert execution["approvals"][0]["status"] == "pending"
    assert state["active_task"]["source_seq"] == 5
    assert "approval-pending" in state["progress"]["blocked"][0]


async def test_answered_user_turn_is_not_marked_unfulfilled_after_compaction(container):
    items: list[dict] = []
    for turn in range(1, 9):
        marker = f"ACK-{turn:02d}"
        items.extend(
            [
                {
                    "role": "user",
                    "content": f"turn {turn} request " + "context padding " * 100,
                },
                {"role": "assistant", "content": marker},
            ]
        )
    record, _ = await new_session(container, items)
    compaction = await container.compaction.compact_session(
        record.id,
        deterministic_compaction_config(keep_recent_tokens=80, min_tail_user_messages=2),
        force=True,
        strategy="portable",
    )

    summary = compaction.summary_json
    state = summary["execution_state"]
    assert compaction.schema_version == 2
    assert compaction.engine_version == "2"
    assert state["authority"] == "runtime_derived"
    assert state["responded_user_turn_count"] == 6
    assert state["last_responded_user_source_seq"] == 11
    assert state["pending_user_turn_count"] == 0
    assert summary["active_task"] == {
        "latest_unfulfilled_user_input": "",
        "source_seq": 0,
    }
    assert any("ACK-06" in action for action in summary["completed_actions"])
    assert summary["progress"]["in_progress"] == []
    assert compaction.validation_json["execution_state_validated"] is True


async def test_execution_state_mismatch_is_hard_noop(container, monkeypatch):
    record, sdk_session = await new_session(
        container,
        [
            {"role": "user", "content": "request " + "historical context " * 100},
            {"role": "assistant", "content": "ACK-COMPLETE"},
            *historical_items(12),
        ],
    )
    before = await sdk_session.canonical_items()
    from agent_system import compaction as compaction_module

    original = compaction_module.apply_authoritative_checkpoint_state

    def inject_mismatch(summary, state):
        result = original(summary, state)
        result["active_task"] = {
            "latest_unfulfilled_user_input": "already answered request",
            "source_seq": 1,
        }
        return result

    monkeypatch.setattr(compaction_module, "apply_authoritative_checkpoint_state", inject_mismatch)
    with pytest.raises(SummaryValidationError, match="active_task contradicts"):
        await container.compaction.compact_session(
            record.id,
            deterministic_compaction_config(),
            force=True,
            strategy="portable",
        )

    assert await sdk_session.canonical_items() == before
    _, projections, _ = await counts(container, record.id)
    assert projections == 0


async def test_single_writer_lease_rejects_parallel_compaction(container, monkeypatch):
    record, _ = await new_session(container, historical_items(14))
    entered = asyncio.Event()
    release = asyncio.Event()
    original = PortableSummaryStrategy.summarize_chunk

    async def slow_summary(self, *args, **kwargs):
        entered.set()
        await release.wait()
        return await original(self, *args, **kwargs)

    monkeypatch.setattr(PortableSummaryStrategy, "summarize_chunk", slow_summary)
    first = asyncio.create_task(
        container.compaction.compact_session(
            record.id,
            deterministic_compaction_config(),
            force=True,
            strategy="portable",
        )
    )
    await asyncio.wait_for(entered.wait(), timeout=2)
    with pytest.raises(CompactionBusy):
        await container.compaction.compact_session(
            record.id,
            deterministic_compaction_config(),
            force=True,
            strategy="portable",
        )
    release.set()
    completed = await first
    assert completed is not None
    assert completed.status == "active"


async def test_tail_append_during_summary_is_preserved(container, monkeypatch):
    record, sdk_session = await new_session(container, historical_items(14))
    entered = asyncio.Event()
    release = asyncio.Event()
    original = PortableSummaryStrategy.summarize_chunk

    async def slow_summary(self, *args, **kwargs):
        entered.set()
        await release.wait()
        return await original(self, *args, **kwargs)

    monkeypatch.setattr(PortableSummaryStrategy, "summarize_chunk", slow_summary)
    task = asyncio.create_task(
        container.compaction.compact_session(
            record.id,
            deterministic_compaction_config(),
            force=True,
            strategy="portable",
        )
    )
    await asyncio.wait_for(entered.wait(), timeout=2)
    await sdk_session.add_items([{"role": "user", "content": "arrived-during-summary"}])
    release.set()
    compaction = await task

    assert compaction.status == "active"
    projected = await sdk_session.get_items()
    assert projected[-1]["content"] == "arrived-during-summary"
    assert len(await sdk_session.canonical_items()) == 15


async def test_snapshot_mutation_fails_cas_without_activating_projection(container, monkeypatch):
    record, sdk_session = await new_session(container, historical_items(14))
    entered = asyncio.Event()
    release = asyncio.Event()
    original = PortableSummaryStrategy.summarize_chunk

    async def slow_summary(self, *args, **kwargs):
        entered.set()
        await release.wait()
        return await original(self, *args, **kwargs)

    monkeypatch.setattr(PortableSummaryStrategy, "summarize_chunk", slow_summary)
    task = asyncio.create_task(
        container.compaction.compact_session(
            record.id,
            deterministic_compaction_config(),
            force=True,
            strategy="portable",
        )
    )
    await asyncio.wait_for(entered.wait(), timeout=2)
    assert await sdk_session.pop_item() is not None
    release.set()
    with pytest.raises(CompactionConflict, match="source transcript changed"):
        await task

    _, projections, _ = await counts(container, record.id)
    assert projections == 0
    assert len(await sdk_session.canonical_items()) == 13


async def test_large_tool_output_is_offloaded_without_mutating_transcript(container):
    large_output = "tool evidence line\n" * 500
    source = [
        {
            "type": "function_call",
            "call_id": "call-artifact-1",
            "name": "read_report",
            "arguments": "{}",
        },
        {
            "type": "function_call_output",
            "call_id": "call-artifact-1",
            "output": large_output,
        },
        *historical_items(10),
    ]
    record, sdk_session = await new_session(container, source)
    compaction = await container.compaction.compact_session(
        record.id,
        deterministic_compaction_config(artifact_threshold_tokens=100),
        force=True,
        strategy="portable",
    )

    assert compaction is not None
    async with container.db.sessions() as session:
        artifacts = (
            await session.scalars(
                select(ArtifactRecord).where(ArtifactRecord.source == "context_compaction")
            )
        ).all()
    assert len(artifacts) == 1
    assert artifacts[0].id in compaction.summary_json["exact_identifiers"]
    canonical = await sdk_session.canonical_items()
    assert canonical[1]["item"]["output"] == large_output
    assert artifacts[0].id in str(await sdk_session.get_items())


async def test_failed_compaction_never_activates_pending_artifact(container, monkeypatch):
    large_output = "evidence\n" * 1000
    record, sdk_session = await new_session(
        container,
        [
            {
                "type": "function_call",
                "call_id": "call-failed-artifact",
                "name": "collect_evidence",
                "arguments": "{}",
            },
            {
                "type": "function_call_output",
                "call_id": "call-failed-artifact",
                "output": large_output,
            },
            *historical_items(10),
        ],
    )

    async def fail_summary(self, *args, **kwargs):
        raise SummaryValidationError("reject after artifact offload")

    monkeypatch.setattr(PortableSummaryStrategy, "summarize_chunk", fail_summary)
    with pytest.raises(SummaryValidationError):
        await container.compaction.compact_session(
            record.id,
            deterministic_compaction_config(artifact_threshold_tokens=100),
            force=True,
            strategy="portable",
        )

    async with container.db.sessions() as session:
        artifact = await session.scalar(
            select(ArtifactRecord).where(ArtifactRecord.source == "context_compaction")
        )
    assert artifact.status == "orphaned"
    assert (await sdk_session.canonical_items())[1]["item"]["output"] == large_output
    _, projections, _ = await counts(container, record.id)
    assert projections == 0


async def test_auto_strategy_uses_verified_native_compaction_item(container, monkeypatch):
    record, sdk_session = await new_session(container, historical_items(14))
    async with container.db.sessions() as session, session.begin():
        session.add(
            ProviderCapabilityRecord(
                provider="deterministic",
                base_url="",
                model="deterministic-test-model",
                responses_compact=True,
                compaction_item_replay=True,
            )
        )

    async def native_compact(self, items):
        return [
            {
                "type": "compaction",
                "id": "cmp_verified_contract",
                "encrypted_content": "opaque-provider-state",
            }
        ]

    monkeypatch.setattr(NativeResponsesStrategy, "compact", native_compact)
    config = deterministic_compaction_config()
    config["provider"]["protocol"] = "responses"
    compaction = await container.compaction.compact_session(
        record.id,
        config,
        force=True,
        strategy="auto",
    )

    assert compaction.strategy == "native"
    assert compaction.native_items_json[0]["type"] == "compaction"
    projected = await sdk_session.get_items()
    assert projected == compaction.native_items_json
    assert len(await sdk_session.canonical_items()) == 14


async def test_five_compactions_preserve_checkpoint_lineage_and_identifiers(container):
    first_batch = historical_items(12, prefix="phase-one")
    first_batch[0]["content"] += " Authoritative file: /private/tmp/critical-ledger.csv"
    record, sdk_session = await new_session(container, first_batch)
    config = deterministic_compaction_config(rebase_every=10)
    first = await container.compaction.compact_session(
        record.id,
        config,
        force=True,
        strategy="portable",
    )
    chain = [first]
    for phase in range(2, 6):
        await sdk_session.add_items(historical_items(12, prefix=f"phase-{phase}"))
        current = await container.compaction.compact_session(
            record.id,
            config,
            force=True,
            strategy="portable",
        )
        assert current.parent_compaction_id == chain[-1].id
        chain.append(current)

    latest = chain[-1]
    assert latest.summary_generation == 5
    assert "/private/tmp/critical-ledger.csv" in latest.summary_json["exact_identifiers"]
    assert latest.source_chunk_count > 1
    assert latest.all_chunks_covered is True
    assert len(await sdk_session.canonical_items()) == 60

    restored = await container.compaction.restore(record.id, latest.id)
    assert restored["active_projection_revision"] == 4
    preview = await container.compaction.context_preview(record.id)
    assert preview["projection"]["compaction_id"] == chain[-2].id
