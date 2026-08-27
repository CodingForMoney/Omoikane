from __future__ import annotations

import sys
from datetime import timedelta
from pathlib import Path

from sqlalchemy import select

from agent_system.models import (
    ApprovalRecord,
    CompactionRecord,
    MemoryCandidateRecord,
    RunRecord,
    RunStateRecord,
    SessionRecord,
    ToolRecord,
    UsageRecord,
    now_utc,
)
from agent_system.runtime_versions import OPENAI_AGENTS_SDK_VERSION, RUN_STATE_FORMAT_VERSION
from agent_system.schemas import MCPServerCreate
from agent_system.sessions import DatabaseSession

from .helpers import deterministic_compaction_config, published_agent


async def test_streamed_run_session_memory_and_structured_output(container):
    schema = {
        "type": "object",
        "properties": {"answer": {"type": "string"}},
        "required": ["answer"],
        "additionalProperties": False,
    }
    _, version = await published_agent(
        container,
        slug="structured-runner",
        provider={"type": "deterministic", "response_text": '{"answer":"ok"}'},
        output_schema=schema,
    )
    conversation = SessionRecord(tenant_id="default")
    async with container.db.sessions() as session, session.begin():
        session.add(conversation)
    run = await container.runner.create_run(
        tenant_id="default",
        agent_version_id=version.id,
        input_value="answer",
        session_id=conversation.id,
        context={},
        limits={},
        idempotency_key="structured-run",
    )
    duplicate = await container.runner.create_run(
        tenant_id="default",
        agent_version_id=version.id,
        input_value="ignored",
        session_id=conversation.id,
        context={},
        limits={},
        idempotency_key="structured-run",
    )
    assert duplicate.id == run.id
    assert await container.runner.process_next()
    async with container.db.sessions() as session:
        current = await session.get(RunRecord, run.id)
        usage = await session.scalar(select(UsageRecord).where(UsageRecord.run_id == run.id))
        candidate = await session.scalar(
            select(MemoryCandidateRecord).where(MemoryCandidateRecord.run_id == run.id)
        )
    assert current.status == "completed"
    assert current.sdk_version == OPENAI_AGENTS_SDK_VERSION
    assert current.output_json == {"answer": "ok"}
    assert usage is not None
    assert candidate.status == "accepted"
    events = await container.events.list(run.id)
    event_types = [event["type"] for event in events]
    assert "model.output_delta" in event_types
    assert "usage.updated" in event_types
    assert "memory.updated" in event_types
    assert event_types[-1] == "memory.updated"


async def test_reasoning_stream_is_separate_from_assistant_output(container):
    _, version = await published_agent(
        container,
        slug="reasoning-stream-runner",
        provider={
            "type": "deterministic",
            "reasoning_text": "INTERNAL-REASONING",
            "response_text": "VISIBLE-FINAL",
        },
    )
    run = await container.runner.create_run(
        tenant_id="default",
        agent_version_id=version.id,
        input_value="answer",
        session_id=None,
        context={},
        limits={},
        idempotency_key=None,
    )

    assert await container.runner.process_next()

    events = await container.events.list(run.id)
    reasoning = [
        event["data"]["delta"]
        for event in events
        if event["type"] == "model.reasoning_summary_delta"
    ]
    visible = [event["data"]["delta"] for event in events if event["type"] == "model.output_delta"]
    completed = next(event for event in events if event["type"] == "run.completed")

    assert reasoning == ["INTERNAL-REASONING"]
    assert visible == ["VISIBLE-FINAL"]
    assert completed["data"]["output"] == "VISIBLE-FINAL"


async def test_retrieved_memory_is_request_only_not_session_history(container):
    memory = await container.memory.create(
        tenant_id="default",
        scope_type="global",
        scope_id="global",
        kind="semantic",
        content="MEMORY-ONLY-MARKER: prefer quarterly comparisons.",
        confidence=0.9,
        source={"test": True},
    )
    _, version = await published_agent(container, slug="request-memory-runner")
    conversation = SessionRecord(tenant_id="default")
    async with container.db.sessions() as session, session.begin():
        session.add(conversation)
    run = await container.runner.create_run(
        tenant_id="default",
        agent_version_id=version.id,
        input_value="compare the quarterly report",
        session_id=conversation.id,
        context={},
        limits={},
        idempotency_key=None,
    )
    await container.runner.process_next()

    canonical = await DatabaseSession(container.db, conversation.id).canonical_items()
    rendered = str(canonical)
    assert memory.id not in rendered
    assert "MEMORY-ONLY-MARKER" not in rendered
    events = await container.events.list(run.id)
    retrieved = [event for event in events if event["type"] == "memory.retrieved"]
    assert retrieved and memory.id in retrieved[0]["data"]["memory_ids"]


async def test_runner_preflight_uses_token_policy_and_activates_projection(container):
    config = deterministic_compaction_config()
    _, version = await published_agent(
        container,
        slug="automatic-compaction-runner",
        compaction=config["compaction"],
    )
    conversation = SessionRecord(tenant_id="default")
    async with container.db.sessions() as session, session.begin():
        session.add(conversation)
    sdk_session = DatabaseSession(container.db, conversation.id)
    await sdk_session.add_items(
        [
            {
                "role": "user",
                "content": f"old-turn-{index} " + "large prior context " * 120,
            }
            for index in range(14)
        ]
    )
    run = await container.runner.create_run(
        tenant_id="default",
        agent_version_id=version.id,
        input_value="continue after compaction",
        session_id=conversation.id,
        context={},
        limits={},
        idempotency_key=None,
    )
    await container.runner.process_next()

    async with container.db.sessions() as session:
        completed = await session.get(RunRecord, run.id)
        compaction = await session.scalar(
            select(CompactionRecord).where(CompactionRecord.run_id == run.id)
        )
    assert completed.status == "completed", completed.error_json
    assert compaction is not None and compaction.status == "active"
    event_types = [event["type"] for event in await container.events.list(run.id)]
    assert "context.compacted" in event_types
    assert len(await sdk_session.canonical_items()) > len(await sdk_session.get_items())


async def test_prompt_structured_output_fallback_is_platform_validated(container):
    schema = {
        "type": "object",
        "properties": {"answer": {"type": "string"}},
        "required": ["answer"],
        "additionalProperties": False,
    }
    _, version = await published_agent(
        container,
        slug="prompt-structured-runner",
        provider={
            "type": "deterministic",
            "response_text": '{"answer":"fallback-ok"}',
            "structured_output_mode": "prompt",
        },
        output_schema=schema,
    )
    run = await container.runner.create_run(
        tenant_id="default",
        agent_version_id=version.id,
        input_value="answer",
        session_id=None,
        context={},
        limits={},
        idempotency_key=None,
    )
    await container.runner.process_next()
    async with container.db.sessions() as session:
        completed = await session.get(RunRecord, run.id)
    assert completed.status == "completed"
    assert completed.output_json == {"answer": "fallback-ok"}


async def test_approval_state_is_persisted_and_resumed(container):
    async with container.db.sessions() as session:
        echo = await session.scalar(select(ToolRecord).where(ToolRecord.slug == "echo"))
    _, version = await published_agent(
        container,
        slug="approval-runner",
        provider={
            "type": "deterministic",
            "response_text": "APPROVED",
            "tool_name": "echo",
            "tool_arguments": {"text": "hello"},
        },
        bindings=[{"kind": "tool", "target_id": echo.id, "config": {"approval_mode": "always"}}],
    )
    run = await container.runner.create_run(
        tenant_id="default",
        agent_version_id=version.id,
        input_value="echo hello",
        session_id=None,
        context={},
        limits={},
        idempotency_key=None,
    )
    await container.runner.process_next()
    async with container.db.sessions() as session:
        paused = await session.get(RunRecord, run.id)
        state = await session.get(RunStateRecord, run.id)
        approval = await session.scalar(
            select(ApprovalRecord).where(ApprovalRecord.run_id == run.id)
        )
    assert paused.status == "waiting_approval"
    assert state.sdk_version == OPENAI_AGENTS_SDK_VERSION
    assert state.format_version == RUN_STATE_FORMAT_VERSION
    assert approval.status == "pending"
    await container.runner.decide_approval(
        tenant_id="default",
        approval_id=approval.id,
        decision="approved",
        actor_id="reviewer",
        reason="approved in test",
    )
    await container.runner.process_next()
    async with container.db.sessions() as session:
        completed = await session.get(RunRecord, run.id)
    assert completed.status == "completed"
    assert completed.output_json == "APPROVED"
    events = [event["type"] for event in await container.events.list(run.id)]
    assert events.count("run.started") == 2
    assert "approval.required" in events
    assert "approval.resolved" in events
    assert "tool.completed" in events


async def test_native_input_guardrail_blocks_run(container):
    _, version = await published_agent(
        container,
        slug="guarded-runner",
        guardrails={"input_block_patterns": ["forbidden phrase"]},
    )
    run = await container.runner.create_run(
        tenant_id="default",
        agent_version_id=version.id,
        input_value="This contains a forbidden phrase.",
        session_id=None,
        context={},
        limits={},
        idempotency_key=None,
    )
    await container.runner.process_next()
    async with container.db.sessions() as session:
        failed = await session.get(RunRecord, run.id)
    assert failed.status == "failed"
    assert failed.error_json["code"] == "InputGuardrailTripwireTriggered"


async def test_pending_approval_expires_and_fails_run(container):
    async with container.db.sessions() as session:
        echo = await session.scalar(select(ToolRecord).where(ToolRecord.slug == "echo"))
    _, version = await published_agent(
        container,
        slug="approval-expiry-runner",
        provider={
            "type": "deterministic",
            "response_text": "late",
            "tool_name": "echo",
            "tool_arguments": {"text": "hello"},
        },
        bindings=[{"kind": "tool", "target_id": echo.id, "config": {"approval_mode": "always"}}],
    )
    run = await container.runner.create_run(
        tenant_id="default",
        agent_version_id=version.id,
        input_value="echo hello",
        session_id=None,
        context={},
        limits={},
        idempotency_key=None,
    )
    await container.runner.process_next()
    async with container.db.sessions() as session, session.begin():
        approval = await session.scalar(
            select(ApprovalRecord).where(ApprovalRecord.run_id == run.id)
        )
        approval.expires_at = now_utc() - timedelta(seconds=1)
    assert await container.runner.reap_expired() == 1
    async with container.db.sessions() as session:
        failed = await session.get(RunRecord, run.id)
        approval = await session.get(ApprovalRecord, approval.id)
    assert failed.status == "failed"
    assert failed.error_json["code"] == "approval_timeout"
    assert approval.status == "expired"
    events = [event["type"] for event in await container.events.list(run.id)]
    assert events[-2:] == ["approval.expired", "run.failed"]


async def test_stdio_mcp_tool_runs_through_agents_sdk(container):
    server_script = Path(__file__).parent / "fixtures" / "mcp_server.py"
    mcp = await container.registry.create_mcp(
        "default",
        MCPServerCreate(
            slug="contract-mcp",
            name="Contract MCP",
            transport="stdio",
            endpoint_config={"command": sys.executable, "args": [str(server_script)]},
            policy={"allowed_tools": ["multiply"], "max_attempts": 1},
        ),
    )
    _, version = await published_agent(
        container,
        slug="mcp-runner",
        provider={
            "type": "deterministic",
            "response_text": "MCP-OK",
            "tool_name": "multiply",
            "tool_arguments": {"a": 6, "b": 7},
        },
        bindings=[{"kind": "mcp", "target_id": mcp.id}],
    )
    health = await container.factory.check_mcp(mcp)
    assert health == {"status": "healthy", "tools": ["multiply"], "tool_count": 1}
    run = await container.runner.create_run(
        tenant_id="default",
        agent_version_id=version.id,
        input_value="multiply",
        session_id=None,
        context={},
        limits={},
        idempotency_key=None,
    )
    await container.runner.process_next()
    async with container.db.sessions() as session:
        completed = await session.get(RunRecord, run.id)
    assert completed.status == "completed", completed.error_json
    assert completed.output_json == "MCP-OK"
    assert "tool.completed" in [event["type"] for event in await container.events.list(run.id)]


async def test_agent_as_tool_orchestration_runs_through_sdk(container):
    _, child = await published_agent(
        container,
        slug="orchestration-child",
        provider={"type": "deterministic", "response_text": "CHILD-RESULT"},
    )
    _, parent = await published_agent(
        container,
        slug="orchestration-parent",
        provider={
            "type": "deterministic",
            "response_text": "PARENT-DONE",
            "tool_name": "ask_child",
            "tool_arguments": {"input": "do delegated work"},
        },
        bindings=[
            {
                "kind": "agent_tool",
                "target_id": child.id,
                "config": {"tool_name": "ask_child"},
            }
        ],
    )
    run = await container.runner.create_run(
        tenant_id="default",
        agent_version_id=parent.id,
        input_value="delegate",
        session_id=None,
        context={},
        limits={},
        idempotency_key=None,
    )
    await container.runner.process_next()
    async with container.db.sessions() as session:
        completed = await session.get(RunRecord, run.id)
    assert completed.status == "completed", completed.error_json
    assert completed.output_json == "PARENT-DONE"
    event_types = [event["type"] for event in await container.events.list(run.id)]
    assert "tool.called" in event_types
    assert "tool.completed" in event_types
