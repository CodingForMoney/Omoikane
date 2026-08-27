from __future__ import annotations

import asyncio
import json
import os
import socket
import uuid
from collections import defaultdict
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any

from redis.asyncio import Redis
from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .config import Settings
from .db import Database
from .models import RunEventRecord, RunRecord, now_utc
from .serialization import canonical_json, to_jsonable


class EventNotifier:
    def __init__(self, settings: Settings):
        self._conditions: dict[str, asyncio.Condition] = defaultdict(asyncio.Condition)
        self._redis: Redis | None = (
            Redis.from_url(settings.redis_url, decode_responses=True)
            if settings.redis_url
            else None
        )

    async def publish(self, run_id: str, seq: int) -> None:
        condition = self._conditions[run_id]
        async with condition:
            condition.notify_all()
        if self._redis is not None:
            await self._redis.publish(f"agent-system:run:{run_id}", str(seq))

    async def wait(self, run_id: str, timeout: float) -> bool:
        if self._redis is not None:
            pubsub = self._redis.pubsub()
            try:
                await pubsub.subscribe(f"agent-system:run:{run_id}")
                message = await pubsub.get_message(
                    ignore_subscribe_messages=True,
                    timeout=timeout,
                )
                return message is not None
            finally:
                await pubsub.unsubscribe(f"agent-system:run:{run_id}")
                await pubsub.aclose()
        condition = self._conditions[run_id]
        try:
            async with condition:
                await asyncio.wait_for(condition.wait(), timeout=timeout)
            return True
        except TimeoutError:
            return False

    async def close(self) -> None:
        if self._redis is not None:
            await self._redis.aclose()


class EventStore:
    def __init__(self, db: Database, notifier: EventNotifier, settings: Settings):
        self.db = db
        self.notifier = notifier
        self.settings = settings
        self._append_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._dispatcher_id = f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4()}"

    def _payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        payload_json = to_jsonable(payload)
        if (
            len(canonical_json(payload_json).encode("utf-8"))
            > self.settings.max_event_payload_bytes
        ):
            return {
                "truncated": True,
                "message": "event payload exceeded configured maximum",
            }
        return payload_json

    async def append_in_transaction(
        self,
        session: AsyncSession,
        run: RunRecord,
        event_type: str,
        payload: dict[str, Any],
    ) -> int:
        """Append a Run event using the caller's domain-state transaction.

        ``run_events`` is both the durable event log and the notification outbox.
        The caller must lock the Run before changing state and invoking this method.
        Redis publication happens only after that transaction commits.
        """

        await session.flush()
        run.version = int(run.version or 0) + 1
        seq = run.version
        session.add(
            RunEventRecord(
                run_id=run.id,
                seq=seq,
                type=event_type,
                payload_json=self._payload(payload),
                trace_id=run.trace_id,
            )
        )
        return seq

    async def append(self, run_id: str, event_type: str, payload: dict[str, Any]) -> int:
        async with self._append_locks[run_id]:
            async with self.db.sessions() as session, session.begin():
                run = await session.scalar(
                    select(RunRecord).where(RunRecord.id == run_id).with_for_update()
                )
                if run is None:
                    raise KeyError(f"run not found: {run_id}")
                seq = await self.append_in_transaction(session, run, event_type, payload)
        await self.dispatch_pending(run_id=run_id)
        return seq

    async def _claim_pending(self, run_id: str | None) -> RunEventRecord | None:
        now = now_utc()
        conditions = [
            RunEventRecord.published_at.is_(None),
            or_(RunEventRecord.next_publish_at.is_(None), RunEventRecord.next_publish_at <= now),
            or_(
                RunEventRecord.publish_lease_expires_at.is_(None),
                RunEventRecord.publish_lease_expires_at <= now,
            ),
        ]
        if run_id is not None:
            conditions.append(RunEventRecord.run_id == run_id)
        async with self.db.sessions() as session, session.begin():
            event = await session.scalar(
                select(RunEventRecord)
                .where(*conditions)
                .order_by(RunEventRecord.created_at, RunEventRecord.run_id, RunEventRecord.seq)
                .limit(1)
                .with_for_update(skip_locked=True)
            )
            if event is None:
                return None
            event.publish_lease_owner = self._dispatcher_id
            event.publish_lease_expires_at = now + timedelta(seconds=30)
            event.publish_attempts = int(event.publish_attempts or 0) + 1
        return event

    async def _publish_succeeded(self, event_id: str) -> None:
        async with self.db.sessions() as session, session.begin():
            await session.execute(
                update(RunEventRecord)
                .where(
                    RunEventRecord.id == event_id,
                    RunEventRecord.publish_lease_owner == self._dispatcher_id,
                )
                .values(
                    published_at=now_utc(),
                    last_publish_error=None,
                    next_publish_at=None,
                    publish_lease_owner=None,
                    publish_lease_expires_at=None,
                )
            )

    async def _publish_failed(self, event: RunEventRecord, error: Exception) -> None:
        delay = min(2 ** min(int(event.publish_attempts or 1), 8), 300)
        async with self.db.sessions() as session, session.begin():
            await session.execute(
                update(RunEventRecord)
                .where(
                    RunEventRecord.id == event.id,
                    RunEventRecord.publish_lease_owner == self._dispatcher_id,
                )
                .values(
                    last_publish_error=str(error)[:4000],
                    next_publish_at=now_utc() + timedelta(seconds=delay),
                    publish_lease_owner=None,
                    publish_lease_expires_at=None,
                )
            )

    async def dispatch_pending(self, run_id: str | None = None, limit: int = 100) -> int:
        """Best-effort delivery of committed outbox rows to the notification layer.

        Delivery failure never rolls back or falsifies the already committed domain
        operation. The row remains pending and is retried by API/Worker dispatch loops.
        """

        published = 0
        for _ in range(max(int(limit), 0)):
            event = await self._claim_pending(run_id)
            if event is None:
                break
            try:
                await self.notifier.publish(event.run_id, event.seq)
            except Exception as exc:
                await self._publish_failed(event, exc)
                break
            await self._publish_succeeded(event.id)
            published += 1
        return published

    async def list(self, run_id: str, after: int = 0, limit: int = 500) -> list[dict]:
        async with self.db.sessions() as session:
            rows = (
                await session.scalars(
                    select(RunEventRecord)
                    .where(RunEventRecord.run_id == run_id, RunEventRecord.seq > after)
                    .order_by(RunEventRecord.seq)
                    .limit(limit)
                )
            ).all()
        return [
            {
                "schema_version": 1,
                "id": row.id,
                "run_id": row.run_id,
                "seq": row.seq,
                "type": row.type,
                "time": row.created_at.astimezone(UTC).isoformat(),
                "data": row.payload_json,
            }
            for row in rows
        ]

    async def stream(
        self, run_id: str, after: int = 0, heartbeat: float = 15
    ) -> AsyncIterator[dict | None]:
        cursor = after
        terminal = {"completed", "failed", "cancelled"}
        while True:
            await self.dispatch_pending(run_id=run_id)
            events = await self.list(run_id, cursor)
            if events:
                for event in events:
                    cursor = event["seq"]
                    yield event
                continue
            async with self.db.sessions() as session:
                status = await session.scalar(
                    select(RunRecord.status).where(RunRecord.id == run_id)
                )
            if status is None:
                raise KeyError(f"run not found: {run_id}")
            if status in terminal:
                return
            notified = await self.notifier.wait(run_id, heartbeat)
            if not notified:
                yield None


def encode_sse(event: dict | None) -> str:
    if event is None:
        return f": heartbeat {datetime.now(UTC).isoformat()}\n\n"
    data = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    return f"id: {event['seq']}\nevent: {event['type']}\ndata: {data}\n\n"
