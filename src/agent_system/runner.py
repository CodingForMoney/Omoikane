from __future__ import annotations

import asyncio
import hashlib
import json
import socket
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from agents import RunConfig, RunHooks, Runner, RunState
from jsonschema import Draft202012Validator
from sqlalchemy import func, select

from .agent_definitions import AgentDefinitionService
from .agent_factory import AgentFactory
from .compaction import CompactionService
from .config import Settings
from .costs import BudgetExceeded, CostService
from .crypto import StateCipher
from .db import Database
from .events import EventStore
from .memory import MemoryService
from .models import (
    AgentVersionRecord,
    ApprovalRecord,
    ArtifactRecord,
    BindingRecord,
    RunRecord,
    RunStateRecord,
    SessionRecord,
    ToolExecutionRecord,
    now_utc,
)
from .providers import ProviderService
from .runtime_versions import OPENAI_AGENTS_SDK_VERSION, RUN_STATE_FORMAT_VERSION
from .sandbox import SandboxHandle, SandboxProvider, SandboxSpec
from .serialization import canonical_json, to_jsonable
from .sessions import DatabaseSession
from .skills import SkillService
from .tool_executions import ToolExecutionService

TERMINAL_STATUSES = {"completed", "failed", "cancelled"}

RAW_RESPONSE_DELTA_EVENTS = {
    "response.output_text.delta": "model.output_delta",
    "response.reasoning_text.delta": "model.reasoning_delta",
    "response.reasoning_summary_text.delta": "model.reasoning_summary_delta",
}


def classify_raw_response_delta(data: Any) -> tuple[str, dict[str, str]] | None:
    """Preserve the semantic channel of an Agents SDK raw response delta."""
    if isinstance(data, dict):
        source_type = data.get("type")
        delta = data.get("delta")
    else:
        source_type = getattr(data, "type", None)
        delta = getattr(data, "delta", None)
    platform_type = RAW_RESPONSE_DELTA_EVENTS.get(str(source_type))
    if platform_type is None or not isinstance(delta, str) or not delta:
        return None
    return platform_type, {"delta": delta, "source_type": str(source_type)}


def interruption_id(item: Any) -> str:
    raw = to_jsonable(item.raw_item)
    if isinstance(raw, dict):
        value = raw.get("call_id") or raw.get("id")
        if value:
            return str(value)
    return hashlib.sha256(canonical_json(raw).encode("utf-8")).hexdigest()


class PlatformRunHooks(RunHooks):
    def __init__(
        self,
        *,
        run_id: str,
        events: EventStore,
        costs: CostService,
        provider: str,
        model: str,
        limits: dict[str, Any],
    ):
        self.run_id = run_id
        self.events = events
        self.costs = costs
        self.provider = provider
        self.model = model
        self.limits = limits
        self.tool_calls = 0
        self.handoffs = 0

    async def on_agent_start(self, context, agent) -> None:
        await self.events.append(self.run_id, "agent.started", {"agent": agent.name})

    async def on_agent_end(self, context, agent, output) -> None:
        await self.events.append(
            self.run_id, "agent.completed", {"agent": agent.name, "output": to_jsonable(output)}
        )

    async def on_handoff(self, context, from_agent, to_agent) -> None:
        self.handoffs += 1
        if self.handoffs > int(self.limits.get("max_handoffs", 20)):
            raise RuntimeError("maximum handoff count exceeded")
        await self.events.append(
            self.run_id,
            "handoff.started",
            {"from_agent": from_agent.name, "to_agent": to_agent.name},
        )

    async def on_tool_start(self, context, agent, tool) -> None:
        self.tool_calls += 1
        if self.tool_calls > int(self.limits.get("max_tool_calls", 50)):
            raise RuntimeError("maximum tool-call count exceeded")
        await self.events.append(
            self.run_id,
            "tool.called",
            {
                "agent": agent.name,
                "tool": getattr(tool, "name", type(tool).__name__),
                "tool_call_id": str(getattr(context, "tool_call_id", "")),
            },
        )

    async def on_tool_end(self, context, agent, tool, result) -> None:
        await self.events.append(
            self.run_id,
            "tool.completed",
            {
                "agent": agent.name,
                "tool": getattr(tool, "name", type(tool).__name__),
                "tool_call_id": str(getattr(context, "tool_call_id", "")),
                "result": to_jsonable(result),
            },
        )

    async def on_llm_start(self, context, agent, system_prompt, input_items) -> None:
        usage = context.usage
        await self.costs.assert_within_run_budget(
            provider=self.provider,
            model=self.model,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            limit_usd=self.limits.get("max_cost_usd"),
            run_id=self.run_id,
        )
        await self.events.append(
            self.run_id,
            "model.started",
            {"agent": agent.name, "request_number": usage.requests + 1},
        )

    async def on_llm_end(self, context, agent, response) -> None:
        usage = context.usage
        await self.events.append(
            self.run_id,
            "model.completed",
            {
                "agent": agent.name,
                "usage": {
                    "requests": usage.requests,
                    "input_tokens": usage.input_tokens,
                    "output_tokens": usage.output_tokens,
                    "total_tokens": usage.total_tokens,
                },
                "response_id": response.response_id,
            },
        )


class RunnerService:
    def __init__(
        self,
        *,
        db: Database,
        settings: Settings,
        events: EventStore,
        factory: AgentFactory,
        memory: MemoryService,
        skills: SkillService,
        sandbox: SandboxProvider,
        costs: CostService,
        compaction: CompactionService,
        providers: ProviderService,
        definitions: AgentDefinitionService,
        tool_executions: ToolExecutionService,
    ):
        self.db = db
        self.settings = settings
        self.events = events
        self.factory = factory
        self.memory = memory
        self.skills = skills
        self.sandbox = sandbox
        self.costs = costs
        self.compaction = compaction
        self.providers = providers
        self.definitions = definitions
        self.tool_executions = tool_executions
        self.cipher = StateCipher(settings.run_state_secret)
        self.worker_id = f"{socket.gethostname()}:{__import__('os').getpid()}"

    async def create_run(
        self,
        *,
        tenant_id: str,
        agent_version_id: str,
        input_value: str | list[dict],
        session_id: str | None,
        context: dict,
        limits: dict,
        idempotency_key: str | None,
        parent_run_id: str | None = None,
    ) -> RunRecord:
        if self.settings.default_daily_budget_usd is not None:
            current_time = datetime.now(UTC)
            day_start = current_time.replace(hour=0, minute=0, second=0, microsecond=0)
            spent = await self.costs.tenant_spend(tenant_id, day_start)
            if spent >= self.settings.default_daily_budget_usd:
                raise BudgetExceeded("tenant daily budget is exhausted")
        async with self.db.sessions() as session, session.begin():
            if idempotency_key:
                existing = await session.scalar(
                    select(RunRecord).where(
                        RunRecord.tenant_id == tenant_id,
                        RunRecord.idempotency_key == idempotency_key,
                    )
                )
                if existing is not None:
                    return existing
            version = await session.get(AgentVersionRecord, agent_version_id)
            if version is None or version.tenant_id != tenant_id or version.status != "published":
                raise ValueError("run requires a published agent version")
            if session_id and await session.get(SessionRecord, session_id) is None:
                raise KeyError("session not found")
            runtime_policy = dict(version.config_json.get("runtime_policy") or {})
            merged_limits = {**runtime_policy, **limits}
            merged_limits = await self.definitions.clamp_run_limits(tenant_id, merged_limits)
            active_count = await session.scalar(
                select(func.count(RunRecord.id)).where(
                    RunRecord.tenant_id == tenant_id,
                    RunRecord.status.in_(["queued", "running", "waiting_approval"]),
                )
            )
            max_concurrent = int(merged_limits.get("tenant_max_concurrent", 100))
            if int(active_count or 0) >= max_concurrent:
                raise BudgetExceeded("tenant concurrent run limit reached")
            record = RunRecord(
                tenant_id=tenant_id,
                agent_version_id=agent_version_id,
                session_id=session_id,
                parent_run_id=parent_run_id,
                status="queued",
                input_json=input_value,
                limits_json=merged_limits,
                context_json=context,
                idempotency_key=idempotency_key,
                sdk_version=OPENAI_AGENTS_SDK_VERSION,
                config_hash=version.config_hash,
            )
            session.add(record)
            await self.events.append_in_transaction(
                session, record, "run.created", {"status": "queued"}
            )
        await self.events.dispatch_pending(run_id=record.id)
        return record

    async def cancel(self, tenant_id: str, run_id: str) -> RunRecord:
        async with self.db.sessions() as session, session.begin():
            run = await session.scalar(
                select(RunRecord)
                .where(RunRecord.id == run_id, RunRecord.tenant_id == tenant_id)
                .with_for_update()
            )
            if run is None:
                raise KeyError("run not found")
            if run.status in TERMINAL_STATUSES:
                return run
            run.cancel_requested = True
            if run.status in {"queued", "waiting_approval"}:
                run.status = "cancelled"
                run.completed_at = now_utc()
                event_type = "run.cancelled"
            else:
                event_type = "run.cancel_requested"
            await self.events.append_in_transaction(session, run, event_type, {"requested": True})
        await self.events.dispatch_pending(run_id=run_id)
        return run

    async def decide_approval(
        self,
        *,
        tenant_id: str,
        approval_id: str,
        decision: str,
        actor_id: str,
        reason: str | None,
    ) -> ApprovalRecord:
        if decision not in {"approved", "rejected"}:
            raise ValueError("invalid approval decision")
        async with self.db.sessions() as session, session.begin():
            approval = await session.scalar(
                select(ApprovalRecord)
                .where(
                    ApprovalRecord.id == approval_id,
                    ApprovalRecord.tenant_id == tenant_id,
                )
                .with_for_update()
            )
            if approval is None:
                raise KeyError("approval not found")
            if approval.status != "pending":
                if approval.status == decision:
                    return approval
                raise ValueError("approval has already been decided differently")
            run = await session.scalar(
                select(RunRecord).where(RunRecord.id == approval.run_id).with_for_update()
            )
            if run is None or run.status != "waiting_approval":
                raise ValueError("run is not waiting for approval")
            approval.status = decision
            approval.decided_by = actor_id
            approval.decision_reason = reason
            approval.decided_at = now_utc()
            pending = await session.scalar(
                select(func.count(ApprovalRecord.id)).where(
                    ApprovalRecord.run_id == run.id,
                    ApprovalRecord.status == "pending",
                    ApprovalRecord.id != approval.id,
                )
            )
            if not pending:
                run.status = "queued"
                run.lease_owner = None
                run.lease_expires_at = None
            await self.events.append_in_transaction(
                session,
                run,
                "approval.resolved",
                {"approval_id": approval.id, "decision": decision, "actor_id": actor_id},
            )
        await self.events.dispatch_pending(run_id=approval.run_id)
        return approval

    async def claim_next(self) -> RunRecord | None:
        now = now_utc()
        async with self.db.sessions() as session, session.begin():
            run = await session.scalar(
                select(RunRecord)
                .where(
                    RunRecord.status == "queued",
                    RunRecord.cancel_requested.is_(False),
                )
                .order_by(RunRecord.created_at)
                .limit(1)
                .with_for_update(skip_locked=True)
            )
            if run is None:
                return None
            run.status = "running"
            run.started_at = run.started_at or now
            run.lease_owner = self.worker_id
            run.lease_expires_at = now + timedelta(seconds=self.settings.run_lease_seconds)
            await self.events.append_in_transaction(
                session, run, "run.started", {"worker_id": self.worker_id}
            )
        await self.events.dispatch_pending(run_id=run.id)
        return run

    async def reap_expired(self) -> int:
        now = now_utc()
        count = 0
        dispatch_run_ids: set[str] = set()
        async with self.db.sessions() as session, session.begin():
            rows = (
                await session.scalars(
                    select(RunRecord)
                    .where(
                        RunRecord.status == "running",
                        RunRecord.lease_expires_at < now,
                    )
                    .with_for_update(skip_locked=True)
                )
            ).all()
            for run in rows:
                inflight_tools = (
                    await session.scalars(
                        select(ToolExecutionRecord)
                        .where(
                            ToolExecutionRecord.run_id == run.id,
                            ToolExecutionRecord.status.in_(["running", "unknown"]),
                        )
                        .with_for_update(skip_locked=True)
                    )
                ).all()
                if inflight_tools:
                    for execution in inflight_tools:
                        if execution.status == "running":
                            execution.status = "unknown"
                            execution.error_json = {
                                "code": "worker_lost",
                                "message": (
                                    "run lease expired while the tool side effect may have "
                                    "been in flight"
                                ),
                            }
                            execution.lease_expires_at = None
                    run.status = "waiting_reconciliation"
                    run.error_json = {
                        "code": "tool_outcome_unknown",
                        "message": (
                            "a side-effecting tool outcome must be reconciled before the run "
                            "can be closed"
                        ),
                    }
                    await self.events.append_in_transaction(
                        session,
                        run,
                        "tool.reconciliation_required",
                        {"code": "tool_outcome_unknown"},
                    )
                else:
                    run.status = "queued"
                    await self.events.append_in_transaction(
                        session,
                        run,
                        "run.requeued",
                        {"reason": "worker_lease_expired"},
                    )
                run.lease_owner = None
                run.lease_expires_at = None
                dispatch_run_ids.add(run.id)
                count += 1
            approvals = (
                await session.scalars(
                    select(ApprovalRecord)
                    .where(
                        ApprovalRecord.status == "pending",
                        ApprovalRecord.expires_at.is_not(None),
                        ApprovalRecord.expires_at <= now,
                    )
                    .with_for_update(skip_locked=True)
                )
            ).all()
            for approval in approvals:
                run = await session.scalar(
                    select(RunRecord)
                    .where(RunRecord.id == approval.run_id)
                    .with_for_update(skip_locked=True)
                )
                approval.status = "expired"
                approval.decided_by = "system"
                approval.decision_reason = "approval request expired"
                approval.decided_at = now
                if run is not None and run.status == "waiting_approval":
                    run.status = "failed"
                    run.error_json = {
                        "code": "approval_timeout",
                        "message": "approval request expired",
                    }
                    run.completed_at = now
                    run.lease_owner = None
                    run.lease_expires_at = None
                    await self.events.append_in_transaction(
                        session,
                        run,
                        "approval.expired",
                        {"approval_id": approval.id},
                    )
                    await self.events.append_in_transaction(
                        session,
                        run,
                        "run.failed",
                        {"code": "approval_timeout"},
                    )
                    dispatch_run_ids.add(run.id)
                    count += 1
        for run_id in dispatch_run_ids:
            await self.events.dispatch_pending(run_id=run_id)
        count += await self.tool_executions.reap_expired()
        return count

    async def _renew_lease_until_done(self, run_id: str, execution: asyncio.Task) -> None:
        try:
            while not execution.done():
                await asyncio.sleep(max(self.settings.run_lease_seconds / 3, 1))
                async with self.db.sessions() as session, session.begin():
                    run = await session.scalar(
                        select(RunRecord).where(RunRecord.id == run_id).with_for_update()
                    )
                    if run is None or run.status != "running":
                        execution.cancel()
                        return
                    if run.cancel_requested:
                        execution.cancel()
                        return
                    run.lease_expires_at = now_utc() + timedelta(
                        seconds=self.settings.run_lease_seconds
                    )
        except asyncio.CancelledError:
            return

    async def _prepare_context(
        self, run: RunRecord, config: dict[str, Any]
    ) -> tuple[dict[str, Any], DatabaseSession | None, SandboxHandle | None]:
        context = {**run.context_json, "tenant_id": run.tenant_id, "run_id": run.id}
        sdk_session = DatabaseSession(self.db, run.session_id) if run.session_id else None
        if sdk_session:
            decision = await self.compaction.evaluate(
                run.session_id,
                config,
                current_input=run.input_json,
            )
            context["compaction_policy"] = {
                "state": decision.state,
                "reason": decision.reason,
                "estimated_tokens": decision.estimate.tokens,
                "high_watermark_tokens": decision.estimate.high_watermark_tokens,
                "low_watermark_tokens": decision.estimate.low_watermark_tokens,
                "estimate_source": decision.estimate.source,
            }
            if decision.should_compact:
                await self.compaction.compact_session(
                    run.session_id,
                    config,
                    force=False,
                    trigger="preflight",
                    run_id=run.id,
                )

        query = (
            run.input_json if isinstance(run.input_json, str) else canonical_json(run.input_json)
        )
        memory_config = dict(config.get("memory") or {})
        memory_enabled = bool(memory_config.get("enabled", True))
        scopes: list[tuple[str, str]] = []
        for scope_type in memory_config.get("read_scopes", ["agent", "global"]):
            if scope_type == "agent":
                scopes.append(("agent", run.agent_version_id))
            elif scope_type == "global":
                scopes.append(("global", "global"))
            else:
                matching = next(
                    (
                        item
                        for item in context.get("memory_scopes", [])
                        if isinstance(item, dict) and item.get("type") == scope_type
                    ),
                    None,
                )
                if matching and matching.get("id"):
                    scopes.append((str(scope_type), str(matching["id"])))
        for item in context.get("memory_scopes", []):
            if isinstance(item, dict) and item.get("type") and item.get("id"):
                pair = (str(item["type"]), str(item["id"]))
                if pair not in scopes:
                    scopes.append(pair)
        context["retrieved_memories"] = (
            await self.memory.retrieve(
                tenant_id=run.tenant_id,
                query=query,
                scopes=scopes,
                limit=int(memory_config.get("max_retrieved_items", 8)),
            )
            if memory_enabled and scopes
            else []
        )
        if context["retrieved_memories"]:
            await self.events.append(
                run.id,
                "memory.retrieved",
                {"memory_ids": [item["id"] for item in context["retrieved_memories"]]},
            )

        sandbox_handle = None
        sandbox_config = config.get("sandbox") or {}
        existing = context.get("sandbox")
        if isinstance(existing, dict):
            sandbox_handle = SandboxHandle(
                id=existing["id"], root=Path(existing["root"]), provider=existing["provider"]
            )
        elif sandbox_config.get("enabled"):
            sandbox_handle = await self.sandbox.create(
                SandboxSpec(
                    run_id=run.id,
                    cpu_limit=float(sandbox_config.get("cpu_limit", 1.0)),
                    memory_mb=int(sandbox_config.get("memory_mb", 512)),
                    disk_mb=int(sandbox_config.get("disk_mb", 1024)),
                    timeout_seconds=int(sandbox_config.get("timeout_seconds", 60)),
                    network_enabled=bool(sandbox_config.get("network_enabled", False)),
                )
            )
            context["sandbox"] = {
                "id": sandbox_handle.id,
                "root": str(sandbox_handle.root),
                "provider": sandbox_handle.provider,
            }
            async with self.db.sessions() as session, session.begin():
                current = await session.scalar(
                    select(RunRecord).where(RunRecord.id == run.id).with_for_update()
                )
                if current is None:
                    raise KeyError("run not found")
                current.context_json = context
                await self.events.append_in_transaction(
                    session, current, "sandbox.created", context["sandbox"]
                )
            await self.events.dispatch_pending(run_id=run.id)
            async with self.db.sessions() as session:
                skill_ids = (
                    await session.scalars(
                        select(BindingRecord.target_id).where(
                            BindingRecord.agent_version_id == run.agent_version_id,
                            BindingRecord.kind == "skill",
                        )
                    )
                ).all()
            for skill_id in skill_ids:
                materialized = await self.skills.materialize(skill_id, sandbox_handle.root)
                await self.events.append(
                    run.id,
                    "skill.materialized",
                    {"skill_version_id": skill_id, "path": materialized["path"]},
                )
        return context, sdk_session, sandbox_handle

    async def _load_state(self, run_id: str, agent, context: dict) -> RunState | None:
        async with self.db.sessions() as session:
            record = await session.get(RunStateRecord, run_id)
            approvals = (
                await session.scalars(select(ApprovalRecord).where(ApprovalRecord.run_id == run_id))
            ).all()
        if record is None:
            return None
        if (
            record.sdk_version != OPENAI_AGENTS_SDK_VERSION
            or record.format_version != RUN_STATE_FORMAT_VERSION
        ):
            raise RuntimeError(
                "stored run state is incompatible with this runtime: "
                f"stored sdk={record.sdk_version!r}, format={record.format_version}; "
                f"runtime sdk={OPENAI_AGENTS_SDK_VERSION!r}, "
                f"format={RUN_STATE_FORMAT_VERSION}"
            )
        plaintext = self.cipher.decrypt(record.encrypted_state, record.checksum)
        state = await RunState.from_json(
            initial_agent=agent,
            state_json=json.loads(plaintext),
            context_override=context,
        )
        decisions = {item.interruption_id: item for item in approvals if item.status != "pending"}
        for interruption in state.get_interruptions():
            decision = decisions.get(interruption_id(interruption))
            if decision is None:
                raise RuntimeError("resumed run has an unresolved approval")
            if decision.status == "approved":
                state.approve(interruption)
            else:
                state.reject(interruption, rejection_message=decision.decision_reason)
        return state

    async def _save_interruption(self, run: RunRecord, result) -> None:
        state = result.to_state()
        state_json = state.to_json()
        plaintext = json.dumps(state_json, ensure_ascii=False, separators=(",", ":")).encode()
        encrypted, checksum = self.cipher.encrypt(plaintext)
        interruptions = state.get_interruptions()
        timeout_seconds = int(
            run.limits_json.get(
                "approval_timeout_seconds",
                self.settings.default_approval_timeout_seconds,
            )
        )
        expires_at = now_utc() + timedelta(seconds=max(timeout_seconds, 60))
        async with self.db.sessions() as session, session.begin():
            current = await session.scalar(
                select(RunRecord).where(RunRecord.id == run.id).with_for_update()
            )
            current.status = "waiting_approval"
            current.lease_owner = None
            current.lease_expires_at = None
            state_record = await session.get(RunStateRecord, run.id)
            if state_record is None:
                state_record = RunStateRecord(
                    run_id=run.id,
                    format_version=RUN_STATE_FORMAT_VERSION,
                    sdk_version=OPENAI_AGENTS_SDK_VERSION,
                    encrypted_state=encrypted,
                    checksum=checksum,
                )
                session.add(state_record)
            else:
                state_record.format_version = RUN_STATE_FORMAT_VERSION
                state_record.sdk_version = OPENAI_AGENTS_SDK_VERSION
                state_record.encrypted_state = encrypted
                state_record.checksum = checksum
            for item in interruptions:
                key = interruption_id(item)
                existing = await session.scalar(
                    select(ApprovalRecord).where(
                        ApprovalRecord.run_id == run.id,
                        ApprovalRecord.interruption_id == key,
                    )
                )
                if existing is None:
                    raw = to_jsonable(item.raw_item)
                    approval = ApprovalRecord(
                        tenant_id=run.tenant_id,
                        run_id=run.id,
                        interruption_id=key,
                        tool_name=item.tool_name or "unknown",
                        request_json={"raw_item": raw, "tool_name": item.tool_name},
                        expires_at=expires_at,
                    )
                    session.add(approval)
                    await session.flush()
                    await self.events.append_in_transaction(
                        session,
                        current,
                        "approval.required",
                        {
                            "approval_id": approval.id,
                            "tool_name": approval.tool_name,
                            "request": approval.request_json,
                            "expires_at": expires_at.isoformat(),
                        },
                    )
        await self.events.dispatch_pending(run_id=run.id)

    async def _record_usage(self, run: RunRecord, result, config: dict) -> None:
        usage = result.context_wrapper.usage
        provider_config = config.get("provider") or {}
        provider = str(provider_config.get("name", provider_config.get("type", "openai")))
        model = str(config["model"])
        price = await self.costs.find_price(provider, model)
        async with self.db.sessions() as session, session.begin():
            current = await session.scalar(
                select(RunRecord).where(RunRecord.id == run.id).with_for_update()
            )
            if current is None:
                raise KeyError("run not found")
            usage_record, cost = await self.costs.record_in_transaction(
                session,
                tenant_id=run.tenant_id,
                run_id=run.id,
                provider=provider,
                model=model,
                requests=usage.requests,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                total_tokens=usage.total_tokens,
                raw=to_jsonable(usage),
                price=price,
            )
            await self.events.append_in_transaction(
                session,
                current,
                "usage.updated",
                {
                    "usage_id": usage_record.id,
                    "requests": usage.requests,
                    "input_tokens": usage.input_tokens,
                    "output_tokens": usage.output_tokens,
                    "total_tokens": usage.total_tokens,
                    "cost": cost.amount,
                    "currency": cost.currency,
                },
            )
        await self.events.dispatch_pending(run_id=run.id)
        await self.compaction.record_real_usage(
            run.session_id,
            config,
            int(usage.input_tokens or 0),
        )

    async def _execute(self, run: RunRecord) -> None:
        async with self.db.sessions() as session:
            version = await session.get(AgentVersionRecord, run.agent_version_id)
        if version is None:
            raise RuntimeError("agent version disappeared")
        config = await self.definitions.enforce_runtime_config(
            version.tenant_id, dict(version.config_json)
        )
        config = await self.providers.resolve_agent_config(config, version.tenant_id)
        context, sdk_session, _ = await self._prepare_context(run, config)
        provider_config = config.get("provider") or {}
        provider_name = str(provider_config.get("name", provider_config.get("type", "openai")))
        hooks = PlatformRunHooks(
            run_id=run.id,
            events=self.events,
            costs=self.costs,
            provider=provider_name,
            model=str(config["model"]),
            limits=run.limits_json,
        )
        async with self.factory.build(run.agent_version_id, context) as agent:
            state = await self._load_state(run.id, agent, context)
            run_input = state if state is not None else run.input_json
            run_config = RunConfig(
                tracing_disabled=(
                    self.settings.tracing_disabled
                    or not bool((config.get("tracing") or {}).get("enabled", True))
                ),
                workflow_name=str(config.get("name", "Agent workflow")),
                trace_metadata={"run_id": run.id, "tenant_id": run.tenant_id},
                call_model_input_filter=self.compaction.assembler.model_input_filter(
                    context.get("retrieved_memories", [])
                ),
            )
            result = Runner.run_streamed(
                agent,
                run_input,
                context=None if state is not None else context,
                max_turns=int(run.limits_json.get("max_turns", 20)),
                hooks=hooks,
                run_config=run_config,
                session=sdk_session,
            )
            try:
                async for event in result.stream_events():
                    if event.type == "raw_response_event":
                        classified = classify_raw_response_delta(event.data)
                        if classified is not None:
                            event_type, payload = classified
                            await self.events.append(run.id, event_type, payload)
                    elif event.type == "agent_updated_stream_event":
                        await self.events.append(
                            run.id,
                            "agent.updated",
                            {"agent": getattr(event.new_agent, "name", "unknown")},
                        )
            finally:
                await self._record_usage(run, result, config)
            if result.interruptions:
                await self._save_interruption(run, result)
                return
            output = to_jsonable(result.final_output)
            if config.get("output_schema"):
                if isinstance(output, str):
                    candidate = output.strip()
                    if candidate.startswith("```") and candidate.endswith("```"):
                        lines = candidate.splitlines()
                        candidate = "\n".join(lines[1:-1]).strip()
                    output = json.loads(candidate)
                Draft202012Validator(config["output_schema"]).validate(output)
            async with self.db.sessions() as session, session.begin():
                current = await session.scalar(
                    select(RunRecord).where(RunRecord.id == run.id).with_for_update()
                )
                if current.cancel_requested:
                    current.status = "cancelled"
                    event_type = "run.cancelled"
                    event_payload = {"reason": "cancel requested"}
                else:
                    current.status = "completed"
                    current.output_json = output
                    event_type = "run.completed"
                    event_payload = {"output": output}
                current.completed_at = now_utc()
                current.lease_owner = None
                current.lease_expires_at = None
                state_record = await session.get(RunStateRecord, run.id)
                if state_record:
                    await session.delete(state_record)
                await self.events.append_in_transaction(session, current, event_type, event_payload)
            await self.events.dispatch_pending(run_id=run.id)
            candidate = (
                await self.memory.create_candidate_from_run(run.id)
                if (config.get("memory") or {}).get("write_mode", "candidates") != "disabled"
                else None
            )
            if candidate:
                await self.events.append(
                    run.id, "memory.candidate_created", {"candidate_id": candidate.id}
                )
                memory = await self.memory.consolidate(candidate.id)
                await self.events.append(
                    run.id, "memory.updated", {"memory_id": memory.id, "kind": memory.kind}
                )
            async with self.db.sessions() as session:
                artifacts = (
                    await session.scalars(
                        select(ArtifactRecord).where(ArtifactRecord.run_id == run.id)
                    )
                ).all()
            for artifact in artifacts:
                await self.events.append(
                    run.id,
                    "artifact.created",
                    {"artifact_id": artifact.id, "filename": artifact.filename},
                )

    async def _cleanup_terminal_sandbox(self, run_id: str) -> None:
        async with self.db.sessions() as session:
            run = await session.get(RunRecord, run_id)
        if run is None or run.status not in TERMINAL_STATUSES:
            return
        raw = run.context_json.get("sandbox")
        if not isinstance(raw, dict):
            return
        handle = SandboxHandle(id=raw["id"], root=Path(raw["root"]), provider=raw["provider"])
        try:
            await self.sandbox.destroy(handle)
        except Exception as exc:
            await self.events.append(
                run_id,
                "sandbox.cleanup_failed",
                {"id": handle.id, "error": str(exc)[:1000]},
            )
            return
        async with self.db.sessions() as session, session.begin():
            current = await session.scalar(
                select(RunRecord).where(RunRecord.id == run_id).with_for_update()
            )
            if current is None:
                raise KeyError("run not found")
            context = dict(current.context_json)
            context.pop("sandbox", None)
            current.context_json = context
            await self.events.append_in_transaction(
                session, current, "sandbox.destroyed", {"id": handle.id}
            )
        await self.events.dispatch_pending(run_id=run_id)

    async def process_run(self, run: RunRecord) -> None:
        execution = asyncio.create_task(self._execute(run), name=f"run:{run.id}")
        renewal = asyncio.create_task(self._renew_lease_until_done(run.id, execution))
        max_duration = int(run.limits_json.get("max_duration_seconds", 1800))
        try:
            async with asyncio.timeout(max_duration):
                await execution
        except asyncio.CancelledError:
            changed = False
            async with self.db.sessions() as session, session.begin():
                current = await session.scalar(
                    select(RunRecord).where(RunRecord.id == run.id).with_for_update()
                )
                if current and current.status not in TERMINAL_STATUSES:
                    current.status = "cancelled"
                    current.completed_at = now_utc()
                    current.lease_owner = None
                    current.lease_expires_at = None
                    await self.events.append_in_transaction(
                        session,
                        current,
                        "run.cancelled",
                        {"reason": "cancel requested"},
                    )
                    changed = True
            if changed:
                await self.events.dispatch_pending(run_id=run.id)
        except TimeoutError:
            execution.cancel()
            changed = False
            async with self.db.sessions() as session, session.begin():
                current = await session.scalar(
                    select(RunRecord).where(RunRecord.id == run.id).with_for_update()
                )
                if current and current.status not in TERMINAL_STATUSES:
                    current.status = "failed"
                    current.error_json = {"code": "run_timeout", "message": "run duration exceeded"}
                    current.completed_at = now_utc()
                    current.lease_owner = None
                    current.lease_expires_at = None
                    await self.events.append_in_transaction(
                        session, current, "run.failed", {"code": "run_timeout"}
                    )
                    changed = True
            if changed:
                await self.events.dispatch_pending(run_id=run.id)
        except Exception as exc:
            message = str(exc)[:4000]
            changed = False
            async with self.db.sessions() as session, session.begin():
                current = await session.scalar(
                    select(RunRecord).where(RunRecord.id == run.id).with_for_update()
                )
                if current and current.status not in TERMINAL_STATUSES:
                    current.status = "failed"
                    current.error_json = {
                        "code": type(exc).__name__,
                        "message": message,
                    }
                    current.completed_at = now_utc()
                    current.lease_owner = None
                    current.lease_expires_at = None
                    await self.events.append_in_transaction(
                        session,
                        current,
                        "run.failed",
                        {"code": type(exc).__name__, "message": message},
                    )
                    changed = True
                elif current:
                    await self.events.append_in_transaction(
                        session,
                        current,
                        "run.postprocessing_failed",
                        {"code": type(exc).__name__, "message": message},
                    )
                    changed = True
            if changed:
                await self.events.dispatch_pending(run_id=run.id)
        finally:
            renewal.cancel()
            with __import__("contextlib").suppress(asyncio.CancelledError):
                await renewal
            await self._cleanup_terminal_sandbox(run.id)

    async def process_next(self) -> bool:
        run = await self.claim_next()
        if run is None:
            return False
        await self.process_run(run)
        return True

    async def run_forever(self, stop: asyncio.Event | None = None) -> None:
        stop = stop or asyncio.Event()
        while not stop.is_set():
            await self.events.dispatch_pending(limit=100)
            await self.reap_expired()
            if not await self.process_next():
                try:
                    await asyncio.wait_for(stop.wait(), timeout=self.settings.worker_poll_seconds)
                except TimeoutError:
                    pass
