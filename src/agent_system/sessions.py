from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select

from .db import Database
from .models import (
    ContextProjectionRecord,
    ContextProjectionSegmentRecord,
    SessionItemRecord,
    SessionRecord,
)
from .serialization import to_jsonable


def session_item_text(value: Any) -> str:
    """Extract display text from an Agents SDK message or content item."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(session_item_text(item) for item in value)
    if not isinstance(value, dict):
        return str(value)
    if isinstance(value.get("text"), str):
        return str(value["text"])
    if isinstance(value.get("content"), (str, list, dict)):
        return session_item_text(value["content"])
    if isinstance(value.get("output"), (str, list, dict)):
        return session_item_text(value["output"])
    return ""


class DatabaseSession:
    """Agents SDK Session backed by an immutable transcript and active projection.

    ``session_items`` is the canonical transcript. Compaction never clears,
    rewrites, or inserts a fake summary into that table. ``get_items`` overlays
    the latest active context projection with transcript rows appended after the
    projection snapshot.

    The class deliberately does *not* implement ``run_compaction``. Defining it
    would make the Agents SDK treat this store as an
    ``OpenAIResponsesCompactionAwareSession`` and invoke a platform-specific
    protocol that this repository cannot implement atomically.
    """

    session_settings = None

    def __init__(self, db: Database, session_id: str):
        self.db = db
        self.session_id = session_id

    async def clone(self, *, scope: dict[str, Any] | None = None) -> SessionRecord:
        """Atomically clone the active canonical transcript into a new session.

        Context projections are intentionally not copied: a clone starts from the
        same durable source transcript and can then be compacted independently.
        """
        async with self.db.sessions() as session, session.begin():
            source = await session.scalar(
                select(SessionRecord)
                .where(SessionRecord.id == self.session_id)
                .with_for_update()
            )
            if source is None:
                raise KeyError("session not found")
            rows = (
                await session.scalars(
                    select(SessionItemRecord)
                    .where(
                        SessionItemRecord.session_id == self.session_id,
                        SessionItemRecord.active.is_(True),
                    )
                    .order_by(SessionItemRecord.seq.asc())
                )
            ).all()
            cloned_scope = dict(source.scope or {})
            cloned_scope.update(scope or {})
            cloned_scope["cloned_from_session_id"] = self.session_id
            clone = SessionRecord(
                tenant_id=source.tenant_id,
                status="active",
                scope=cloned_scope,
                last_item_seq=max((row.seq for row in rows), default=0),
                revision=1 if rows else 0,
                active_projection_revision=0,
            )
            session.add(clone)
            await session.flush()
            for row in rows:
                session.add(
                    SessionItemRecord(
                        session_id=clone.id,
                        seq=row.seq,
                        item_json=to_jsonable(row.item_json),
                        active=True,
                    )
                )
        return clone

    async def _active_projection(self, session) -> ContextProjectionRecord | None:
        return await session.scalar(
            select(ContextProjectionRecord)
            .where(
                ContextProjectionRecord.session_id == self.session_id,
                ContextProjectionRecord.status == "active",
            )
            .order_by(ContextProjectionRecord.revision.desc())
            .limit(1)
        )

    async def get_items(self, limit: int | None = None) -> list[dict]:
        async with self.db.sessions() as session:
            projection = await self._active_projection(session)
            if projection is None:
                rows = (
                    await session.scalars(
                        select(SessionItemRecord)
                        .where(
                            SessionItemRecord.session_id == self.session_id,
                            SessionItemRecord.active.is_(True),
                        )
                        .order_by(SessionItemRecord.seq.asc())
                    )
                ).all()
                items = [row.item_json for row in rows]
                protected_prefix_count = 0
            else:
                segments = (
                    await session.scalars(
                        select(ContextProjectionSegmentRecord)
                        .where(ContextProjectionSegmentRecord.projection_id == projection.id)
                        .order_by(ContextProjectionSegmentRecord.position.asc())
                    )
                ).all()
                tail = (
                    await session.scalars(
                        select(SessionItemRecord)
                        .where(
                            SessionItemRecord.session_id == self.session_id,
                            SessionItemRecord.active.is_(True),
                            SessionItemRecord.seq > projection.source_to_seq,
                        )
                        .order_by(SessionItemRecord.seq.asc())
                    )
                ).all()
                items = [segment.item_json for segment in segments] + [
                    row.item_json for row in tail
                ]
                protected_prefix_count = 0
                for segment in segments:
                    if segment.segment_type not in {
                        "control_ref",
                        "native_checkpoint",
                        "portable_checkpoint",
                    }:
                        break
                    protected_prefix_count += 1

        if limit is not None and len(items) > limit:
            if protected_prefix_count:
                protected = items[:protected_prefix_count]
                ordinary_limit = max(limit - len(protected), 0)
                items = protected + (items[-ordinary_limit:] if ordinary_limit else [])
            else:
                items = items[-limit:]
        return items

    async def add_items(self, items: list[Any]) -> None:
        if not items:
            return
        async with self.db.sessions() as session, session.begin():
            record = await session.scalar(
                select(SessionRecord).where(SessionRecord.id == self.session_id).with_for_update()
            )
            if record is None:
                raise KeyError("session not found")
            for item in items:
                record.last_item_seq += 1
                session.add(
                    SessionItemRecord(
                        session_id=self.session_id,
                        seq=record.last_item_seq,
                        item_json=to_jsonable(item),
                    )
                )
            record.revision = int(record.revision or 0) + 1

    async def pop_item(self) -> dict | None:
        async with self.db.sessions() as session, session.begin():
            projection = await self._active_projection(session)
            minimum_seq = projection.source_to_seq if projection else 0
            row = await session.scalar(
                select(SessionItemRecord)
                .where(
                    SessionItemRecord.session_id == self.session_id,
                    SessionItemRecord.active.is_(True),
                    SessionItemRecord.seq > minimum_seq,
                )
                .order_by(SessionItemRecord.seq.desc())
                .limit(1)
                .with_for_update()
            )
            if row is None:
                return None
            row.active = False
            record = await session.get(SessionRecord, self.session_id)
            if record is not None:
                record.revision = int(record.revision or 0) + 1
            return row.item_json

    async def clear_session(self) -> None:
        async with self.db.sessions() as session, session.begin():
            record = await session.scalar(
                select(SessionRecord).where(SessionRecord.id == self.session_id).with_for_update()
            )
            if record is None:
                raise KeyError("session not found")
            rows = (
                await session.scalars(
                    select(SessionItemRecord).where(
                        SessionItemRecord.session_id == self.session_id,
                        SessionItemRecord.active.is_(True),
                    )
                )
            ).all()
            for row in rows:
                row.active = False
            projections = (
                await session.scalars(
                    select(ContextProjectionRecord).where(
                        ContextProjectionRecord.session_id == self.session_id,
                        ContextProjectionRecord.status == "active",
                    )
                )
            ).all()
            for projection in projections:
                projection.status = "superseded"
            record.revision = int(record.revision or 0) + 1
            record.active_projection_revision = 0

    async def canonical_items(self, *, include_inactive: bool = False) -> list[dict]:
        """Return the source transcript for audit/recovery, never the projection."""
        async with self.db.sessions() as session:
            query = select(SessionItemRecord).where(SessionItemRecord.session_id == self.session_id)
            if not include_inactive:
                query = query.where(SessionItemRecord.active.is_(True))
            rows = (await session.scalars(query.order_by(SessionItemRecord.seq))).all()
        return [
            {"id": row.id, "seq": row.seq, "item": row.item_json, "active": row.active}
            for row in rows
        ]

    async def chat_messages(self) -> list[dict[str, Any]]:
        """Return canonical user/assistant messages with reasoning kept separate."""
        canonical = await self.canonical_items()
        messages: list[dict[str, Any]] = []
        pending_reasoning: list[str] = []
        pending_reasoning_kind = "raw"
        for row in canonical:
            item = dict(row["item"] or {})
            item_type = str(item.get("type") or "")
            role = str(item.get("role") or "")
            if item_type == "reasoning":
                summary = session_item_text(item.get("summary"))
                raw = session_item_text(item.get("content"))
                if summary:
                    pending_reasoning.append(summary)
                    pending_reasoning_kind = "summary"
                elif raw:
                    pending_reasoning.append(raw)
                    pending_reasoning_kind = "raw"
                continue
            if role not in {"user", "assistant"}:
                continue
            content = session_item_text(item.get("content"))
            if not content and role == "assistant":
                content = session_item_text(item.get("output"))
            message = {
                "id": str(item.get("id") or row["id"]),
                "seq": row["seq"],
                "role": role,
                "content": content,
                "status": str(item.get("status") or "completed"),
            }
            if role == "assistant" and pending_reasoning:
                message["reasoning"] = "\n\n".join(pending_reasoning)
                message["reasoning_kind"] = pending_reasoning_kind
                pending_reasoning = []
                pending_reasoning_kind = "raw"
            messages.append(message)
        return messages


def estimate_items_size(items: list[dict]) -> int:
    """Legacy display-only byte size; never used for compaction decisions."""
    return sum(len(json.dumps(item, ensure_ascii=False).encode("utf-8")) for item in items)
