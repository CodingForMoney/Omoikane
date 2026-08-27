from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .db import Database
from .models import ToolExecutionRecord, now_utc
from .serialization import canonical_json, to_jsonable


class ToolExecutionConflict(RuntimeError):
    """The same logical tool call was replayed with incompatible data."""


class ToolExecutionInProgress(RuntimeError):
    """Another worker still owns this logical tool execution."""


class ToolExecutionOutcomeUnknown(RuntimeError):
    """A worker disappeared while an external side effect may have been in flight."""


class ToolExecutionPreviouslyFailed(RuntimeError):
    """A prior attempt failed and policy does not permit an automatic replay."""


@dataclass(slots=True)
class ToolExecutionClaim:
    record: ToolExecutionRecord
    cached: bool


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


class ToolExecutionService:
    """Durable at-most-once guard for Function Tool side effects.

    A completed call can be replayed from its cached JSON result. A call whose lease
    expires while running is deliberately moved to ``unknown`` and is never retried
    automatically: the side effect may have happened even though the worker did not
    persist the result.
    """

    def __init__(self, db: Database):
        self.db = db

    @staticmethod
    def make_idempotency_key(
        *, tenant_id: str, run_id: str, tool_call_id: str, implementation_key: str
    ) -> str:
        value = canonical_json(
            {
                "tenant_id": tenant_id,
                "run_id": run_id,
                "tool_call_id": tool_call_id,
                "implementation_key": implementation_key,
            }
        )
        return hashlib.sha256(value.encode("utf-8")).hexdigest()

    async def claim(
        self,
        *,
        tenant_id: str,
        run_id: str,
        tool_call_id: str,
        tool_name: str,
        implementation_key: str,
        arguments: dict[str, Any],
        lease_seconds: float,
        retry_failed: bool = False,
    ) -> ToolExecutionClaim:
        if not run_id:
            raise ValueError("durable tool idempotency requires a run_id")
        if not tool_call_id:
            raise ValueError("durable tool idempotency requires a tool_call_id")
        idempotency_key = self.make_idempotency_key(
            tenant_id=tenant_id,
            run_id=run_id,
            tool_call_id=tool_call_id,
            implementation_key=implementation_key,
        )
        arguments_hash = hashlib.sha256(canonical_json(arguments).encode("utf-8")).hexdigest()
        lease_expires_at = now_utc() + timedelta(seconds=max(float(lease_seconds), 1.0))
        created = ToolExecutionRecord(
            tenant_id=tenant_id,
            run_id=run_id,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            implementation_key=implementation_key,
            idempotency_key=idempotency_key,
            arguments_hash=arguments_hash,
            status="running",
            attempt_count=1,
            lease_expires_at=lease_expires_at,
        )
        try:
            async with self.db.sessions() as session, session.begin():
                session.add(created)
                await session.flush()
            return ToolExecutionClaim(record=created, cached=False)
        except IntegrityError:
            # A concurrent worker won the unique idempotency-key insert. Inspect the
            # durable winner in a fresh transaction because this one was rolled back.
            pass

        outcome: str
        existing: ToolExecutionRecord | None
        async with self.db.sessions() as session, session.begin():
            existing = await session.scalar(
                select(ToolExecutionRecord)
                .where(
                    ToolExecutionRecord.tenant_id == tenant_id,
                    ToolExecutionRecord.idempotency_key == idempotency_key,
                )
                .with_for_update()
            )
            if existing is None:
                raise RuntimeError("tool execution disappeared after idempotency conflict")
            if existing.arguments_hash != arguments_hash:
                outcome = "conflict"
            elif existing.implementation_key != implementation_key:
                outcome = "conflict"
            elif existing.status == "completed":
                outcome = "cached"
            elif existing.status == "running":
                expires_at = existing.lease_expires_at
                if expires_at is not None and _as_utc(expires_at) <= now_utc():
                    existing.status = "unknown"
                    existing.error_json = {
                        "code": "worker_lost",
                        "message": (
                            "tool execution lease expired; the external outcome must be "
                            "reconciled before any retry"
                        ),
                    }
                    existing.lease_expires_at = None
                    outcome = "unknown"
                else:
                    outcome = "running"
            elif existing.status == "failed" and retry_failed:
                existing.status = "running"
                existing.attempt_count += 1
                existing.error_json = None
                existing.output_json = None
                existing.lease_expires_at = lease_expires_at
                existing.completed_at = None
                outcome = "claimed"
            elif existing.status == "failed":
                outcome = "failed"
            else:
                outcome = "unknown"

        if outcome == "cached":
            return ToolExecutionClaim(record=existing, cached=True)
        if outcome == "claimed":
            return ToolExecutionClaim(record=existing, cached=False)
        if outcome == "conflict":
            raise ToolExecutionConflict(
                "tool_call_id was replayed with different arguments or implementation"
            )
        if outcome == "running":
            raise ToolExecutionInProgress(
                "the same logical tool call is already executing on another worker"
            )
        if outcome == "failed":
            raise ToolExecutionPreviouslyFailed(
                "the same logical tool call failed previously; automatic replay is disabled"
            )
        raise ToolExecutionOutcomeUnknown(
            "the previous worker disappeared while the tool side effect may have been in flight"
        )

    async def complete(self, execution_id: str, output: Any) -> ToolExecutionRecord:
        async with self.db.sessions() as session, session.begin():
            record = await session.scalar(
                select(ToolExecutionRecord)
                .where(ToolExecutionRecord.id == execution_id)
                .with_for_update()
            )
            if record is None:
                raise KeyError("tool execution not found")
            if record.status != "running":
                raise ToolExecutionConflict(
                    f"cannot complete tool execution in {record.status} state"
                )
            record.status = "completed"
            record.output_json = to_jsonable(output)
            record.error_json = None
            record.lease_expires_at = None
            record.completed_at = now_utc()
        return record

    async def fail(self, execution_id: str, error: Exception) -> ToolExecutionRecord:
        async with self.db.sessions() as session, session.begin():
            record = await session.scalar(
                select(ToolExecutionRecord)
                .where(ToolExecutionRecord.id == execution_id)
                .with_for_update()
            )
            if record is None:
                raise KeyError("tool execution not found")
            if record.status != "running":
                return record
            record.status = "failed"
            record.error_json = {
                "code": type(error).__name__,
                "message": str(error)[:4000],
                "automatic_replay": False,
            }
            record.lease_expires_at = None
            record.completed_at = now_utc()
        return record

    async def reap_expired(self, run_id: str | None = None) -> int:
        conditions = [
            ToolExecutionRecord.status == "running",
            ToolExecutionRecord.lease_expires_at.is_not(None),
            ToolExecutionRecord.lease_expires_at <= now_utc(),
        ]
        if run_id is not None:
            conditions.append(ToolExecutionRecord.run_id == run_id)
        async with self.db.sessions() as session, session.begin():
            result = await session.execute(
                update(ToolExecutionRecord)
                .where(*conditions)
                .values(
                    status="unknown",
                    error_json={
                        "code": "worker_lost",
                        "message": (
                            "tool execution lease expired; the external outcome must be "
                            "reconciled before any retry"
                        ),
                    },
                    lease_expires_at=None,
                    updated_at=now_utc(),
                )
            )
        return int(result.rowcount or 0)

    async def resolve(
        self,
        *,
        tenant_id: str,
        execution_id: str,
        status: str,
        actor_id: str,
        reason: str,
        output: Any = None,
        error: dict[str, Any] | None = None,
    ) -> ToolExecutionRecord:
        async with self.db.sessions() as session, session.begin():
            return await self.resolve_in_transaction(
                session,
                tenant_id=tenant_id,
                execution_id=execution_id,
                status=status,
                actor_id=actor_id,
                reason=reason,
                output=output,
                error=error,
            )

    async def resolve_in_transaction(
        self,
        session: AsyncSession,
        *,
        tenant_id: str,
        execution_id: str,
        status: str,
        actor_id: str,
        reason: str,
        output: Any = None,
        error: dict[str, Any] | None = None,
    ) -> ToolExecutionRecord:
        if status not in {"completed", "failed"}:
            raise ValueError("tool execution resolution status must be completed or failed")
        record = await session.scalar(
            select(ToolExecutionRecord)
            .where(
                ToolExecutionRecord.id == execution_id,
                ToolExecutionRecord.tenant_id == tenant_id,
            )
            .with_for_update()
        )
        if record is None:
            raise KeyError("tool execution not found")
        if record.status != "unknown":
            raise ToolExecutionConflict(
                f"only unknown tool executions can be reconciled, got {record.status}"
            )
        record.status = status
        record.output_json = to_jsonable(output) if status == "completed" else None
        record.error_json = error if status == "failed" else None
        record.completed_at = now_utc()
        record.resolved_by = actor_id
        record.resolution_reason = reason
        return record
