from __future__ import annotations

from datetime import timedelta

import pytest
from agents.tool_context import ToolContext
from sqlalchemy import select, update

from agent_system.models import RunRecord, ToolExecutionRecord, now_utc
from agent_system.tool_executions import ToolExecutionConflict

from .helpers import published_agent


async def _queued_run(container, slug: str):
    _, version = await published_agent(container, slug=slug)
    return await container.runner.create_run(
        tenant_id="default",
        agent_version_id=version.id,
        input_value="test a tool side effect",
        session_id=None,
        context={},
        limits={},
        idempotency_key=None,
    )


async def test_side_effecting_function_tool_replays_cached_result(container):
    run = await _queued_run(container, "tool-idempotency")
    calls = 0
    observed_keys: list[str | None] = []

    async def handler(arguments, invocation):
        nonlocal calls
        calls += 1
        observed_keys.append(invocation.idempotency_key)
        return {"call_count": calls, "value": arguments["value"]}

    container.tools.register("test.side_effect", handler)
    tool = container.tools.build(
        name="side_effect",
        description="Test a durable side effect.",
        implementation_key="test.side_effect",
        schema={
            "type": "object",
            "properties": {"value": {"type": "string"}},
            "required": ["value"],
            "additionalProperties": False,
        },
        policy={"side_effect": "external", "timeout_seconds": 10},
    )
    context = ToolContext(
        context={"tenant_id": "default", "run_id": run.id},
        tool_name="side_effect",
        tool_call_id="call-stable-1",
        tool_arguments='{"value":"one"}',
    )

    first = await tool.on_invoke_tool(context, '{"value":"one"}')
    second = await tool.on_invoke_tool(context, '{"value":"one"}')

    assert first == second == {"call_count": 1, "value": "one"}
    assert calls == 1
    assert observed_keys[0]
    async with container.db.sessions() as session:
        execution = await session.scalar(
            select(ToolExecutionRecord).where(ToolExecutionRecord.run_id == run.id)
        )
    assert execution.status == "completed"
    assert execution.output_json == first
    assert execution.arguments_hash

    with pytest.raises(ToolExecutionConflict, match="different arguments"):
        await tool.on_invoke_tool(context, '{"value":"two"}')


async def test_expired_tool_execution_requires_manual_reconciliation(container):
    run = await _queued_run(container, "tool-reconciliation")
    claim = await container.tool_executions.claim(
        tenant_id="default",
        run_id=run.id,
        tool_call_id="call-unknown-1",
        tool_name="external_write",
        implementation_key="test.external_write",
        arguments={"value": "one"},
        lease_seconds=60,
    )
    async with container.db.sessions() as session, session.begin():
        await session.execute(
            update(ToolExecutionRecord)
            .where(ToolExecutionRecord.id == claim.record.id)
            .values(lease_expires_at=now_utc() - timedelta(seconds=1))
        )

    assert await container.tool_executions.reap_expired(run.id) == 1
    resolved = await container.tool_executions.resolve(
        tenant_id="default",
        execution_id=claim.record.id,
        status="completed",
        actor_id="operator",
        reason="downstream confirmed the write",
        output={"external_id": "confirmed-1"},
    )
    assert resolved.status == "completed"
    assert resolved.output_json == {"external_id": "confirmed-1"}
    assert resolved.resolved_by == "operator"


async def test_expired_run_with_inflight_side_effect_is_not_requeued(container):
    run = await _queued_run(container, "tool-run-reconciliation")
    claim = await container.tool_executions.claim(
        tenant_id="default",
        run_id=run.id,
        tool_call_id="call-inflight-1",
        tool_name="external_write",
        implementation_key="test.external_write",
        arguments={"value": "one"},
        lease_seconds=60,
    )
    async with container.db.sessions() as session, session.begin():
        await session.execute(
            update(RunRecord)
            .where(RunRecord.id == run.id)
            .values(
                status="running",
                lease_owner="lost-worker",
                lease_expires_at=now_utc() - timedelta(seconds=1),
            )
        )

    assert await container.runner.reap_expired() == 1
    async with container.db.sessions() as session:
        current_run = await session.get(RunRecord, run.id)
        current_execution = await session.get(ToolExecutionRecord, claim.record.id)
    assert current_run.status == "waiting_reconciliation"
    assert current_execution.status == "unknown"
    assert "tool.reconciliation_required" in [
        item["type"] for item in await container.events.list(run.id)
    ]
