from __future__ import annotations

import hashlib
import math
import re
from datetime import UTC, datetime

from sqlalchemy import select

from .db import Database
from .models import (
    MemoryCandidateRecord,
    MemoryRecord,
    MemorySourceRecord,
    RunRecord,
)

TOKEN_PATTERN = re.compile(r"[\w\u4e00-\u9fff]+", re.UNICODE)
SECRET_PATTERN = re.compile(
    r"(?:sk-|tp-)[A-Za-z0-9_-]{20,}|(?:api[_-]?key|token|secret)\s*[:=]\s*\S+",
    re.IGNORECASE,
)


def tokenize(text: str) -> list[str]:
    return [token.lower() for token in TOKEN_PATTERN.findall(text)]


def hash_embedding(text: str, dimensions: int = 128) -> list[float]:
    vector = [0.0] * dimensions
    for token in tokenize(text):
        digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
        index = int.from_bytes(digest, "big") % dimensions
        vector[index] += 1.0
    norm = math.sqrt(sum(value * value for value in vector)) or 1.0
    return [value / norm for value in vector]


def cosine(left: list[float], right: list[float]) -> float:
    return sum(a * b for a, b in zip(left, right, strict=False))


class MemoryService:
    def __init__(self, db: Database):
        self.db = db

    def _validate_content(self, content: str) -> None:
        if SECRET_PATTERN.search(content):
            raise ValueError("memory content appears to contain a credential")

    async def create(
        self,
        *,
        tenant_id: str,
        scope_type: str,
        scope_id: str,
        kind: str,
        content: str,
        confidence: float,
        source: dict | None = None,
        run_id: str | None = None,
    ) -> MemoryRecord:
        self._validate_content(content)
        digest = hashlib.sha256(content.strip().encode("utf-8")).hexdigest()
        async with self.db.sessions() as session, session.begin():
            existing = await session.scalar(
                select(MemoryRecord).where(
                    MemoryRecord.tenant_id == tenant_id,
                    MemoryRecord.scope_type == scope_type,
                    MemoryRecord.scope_id == scope_id,
                    MemoryRecord.content_hash == digest,
                    MemoryRecord.enabled.is_(True),
                )
            )
            if existing is not None:
                existing.confidence = max(existing.confidence, confidence)
                return existing
            embedding = hash_embedding(content)
            memory = MemoryRecord(
                tenant_id=tenant_id,
                scope_type=scope_type,
                scope_id=scope_id,
                kind=kind,
                content=content.strip(),
                content_hash=digest,
                embedding_json=embedding,
                embedding_vector=embedding,
                confidence=confidence,
            )
            session.add(memory)
            await session.flush()
            session.add(
                MemorySourceRecord(memory_id=memory.id, run_id=run_id, source_json=source or {})
            )
        return memory

    async def create_candidate_from_run(self, run_id: str) -> MemoryCandidateRecord | None:
        async with self.db.sessions() as session:
            run = await session.get(RunRecord, run_id)
            if run is None or run.status != "completed" or run.output_json is None:
                return None
        memory_scope = run.context_json.get("memory_scope") or {}
        scope_type = memory_scope.get("type", "agent")
        scope_id = memory_scope.get("id", run.agent_version_id)
        content = f"Input: {str(run.input_json)[:2000]}\nOutcome: {str(run.output_json)[:4000]}"
        if SECRET_PATTERN.search(content):
            return None
        candidate = MemoryCandidateRecord(
            tenant_id=run.tenant_id,
            run_id=run.id,
            scope_type=scope_type,
            scope_id=scope_id,
            kind="episodic",
            content=content,
            scores_json={"usefulness": 0.6, "confidence": 0.6, "safety": 1.0},
        )
        async with self.db.sessions() as session, session.begin():
            session.add(candidate)
        return candidate

    async def consolidate(self, candidate_id: str) -> MemoryRecord:
        async with self.db.sessions() as session, session.begin():
            candidate = await session.scalar(
                select(MemoryCandidateRecord)
                .where(MemoryCandidateRecord.id == candidate_id)
                .with_for_update()
            )
            if candidate is None:
                raise KeyError("memory candidate not found")
            if candidate.status == "accepted":
                source = await session.scalar(
                    select(MemorySourceRecord).where(MemorySourceRecord.run_id == candidate.run_id)
                )
                if source:
                    memory = await session.get(MemoryRecord, source.memory_id)
                    if memory:
                        return memory
            candidate.status = "processing"
        try:
            memory = await self.create(
                tenant_id=candidate.tenant_id,
                scope_type=candidate.scope_type,
                scope_id=candidate.scope_id,
                kind=candidate.kind,
                content=candidate.content,
                confidence=float(candidate.scores_json.get("confidence", 0.5)),
                source={"candidate_id": candidate.id},
                run_id=candidate.run_id,
            )
        except Exception:
            async with self.db.sessions() as session, session.begin():
                current = await session.get(MemoryCandidateRecord, candidate_id)
                if current:
                    current.status = "rejected"
            raise
        async with self.db.sessions() as session, session.begin():
            current = await session.get(MemoryCandidateRecord, candidate_id)
            if current:
                current.status = "accepted"
        return memory

    async def retrieve(
        self,
        *,
        tenant_id: str,
        query: str,
        scopes: list[tuple[str, str]],
        limit: int = 8,
    ) -> list[dict]:
        if not scopes:
            return []
        now = datetime.now(UTC)
        async with self.db.sessions() as session:
            rows = (
                await session.scalars(
                    select(MemoryRecord).where(
                        MemoryRecord.tenant_id == tenant_id,
                        MemoryRecord.enabled.is_(True),
                    )
                )
            ).all()
        allowed = set(scopes)
        query_tokens = set(tokenize(query))
        query_vector = hash_embedding(query)
        ranked = []
        for row in rows:
            if (row.scope_type, row.scope_id) not in allowed:
                continue
            valid_to = row.valid_to
            if valid_to is not None:
                if valid_to.tzinfo is None:
                    valid_to = valid_to.replace(tzinfo=UTC)
                if valid_to <= now:
                    continue
            memory_tokens = set(tokenize(row.content))
            keyword = len(query_tokens & memory_tokens) / max(len(query_tokens), 1)
            semantic = cosine(query_vector, list(row.embedding_json or []))
            score = 0.55 * semantic + 0.25 * keyword + 0.20 * row.confidence
            ranked.append((score, row))
        ranked.sort(key=lambda item: item[0], reverse=True)
        return [
            {
                "id": row.id,
                "kind": row.kind,
                "content": row.content,
                "confidence": row.confidence,
                "score": round(score, 6),
                "updated_at": row.updated_at.isoformat(),
            }
            for score, row in ranked[:limit]
        ]
