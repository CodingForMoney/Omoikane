from __future__ import annotations

import asyncio
import hashlib
import mimetypes
import os
from datetime import datetime
from pathlib import Path
from typing import Protocol

import boto3
from sqlalchemy import select

from .config import Settings
from .db import Database
from .models import ArtifactRecord


class ObjectStore(Protocol):
    async def put(self, key: str, data: bytes, content_type: str) -> None: ...

    async def get(self, key: str) -> bytes: ...

    async def delete(self, key: str) -> None: ...


class LocalObjectStore:
    def __init__(self, root: Path):
        self.root = root.expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if path != self.root and self.root not in path.parents:
            raise ValueError("object key escapes storage root")
        return path

    async def put(self, key: str, data: bytes, content_type: str) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        await asyncio.to_thread(temporary.write_bytes, data)
        await asyncio.to_thread(os.replace, temporary, path)

    async def get(self, key: str) -> bytes:
        return await asyncio.to_thread(self._path(key).read_bytes)

    async def delete(self, key: str) -> None:
        path = self._path(key)
        if path.exists():
            await asyncio.to_thread(path.unlink)


class S3ObjectStore:
    def __init__(self, settings: Settings):
        if not settings.s3_bucket:
            raise ValueError("AGENT_S3_BUCKET is required for S3 artifact backend")
        self.bucket = settings.s3_bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint_url,
            region_name=settings.s3_region,
        )

    async def put(self, key: str, data: bytes, content_type: str) -> None:
        await asyncio.to_thread(
            self.client.put_object,
            Bucket=self.bucket,
            Key=key,
            Body=data,
            ContentType=content_type,
        )

    async def get(self, key: str) -> bytes:
        response = await asyncio.to_thread(self.client.get_object, Bucket=self.bucket, Key=key)
        return await asyncio.to_thread(response["Body"].read)

    async def delete(self, key: str) -> None:
        await asyncio.to_thread(self.client.delete_object, Bucket=self.bucket, Key=key)


class ArtifactService:
    def __init__(self, db: Database, settings: Settings):
        self.db = db
        self.store: ObjectStore = (
            S3ObjectStore(settings)
            if settings.artifact_backend == "s3"
            else LocalObjectStore(settings.artifact_root)
        )

    async def create(
        self,
        *,
        tenant_id: str,
        filename: str,
        data: bytes,
        mime_type: str | None = None,
        run_id: str | None = None,
        source: str = "upload",
        lineage: dict | None = None,
        status: str = "active",
    ) -> ArtifactRecord:
        safe_filename = Path(filename).name or "artifact.bin"
        digest = hashlib.sha256(data).hexdigest()
        mime = mime_type or mimetypes.guess_type(safe_filename)[0] or "application/octet-stream"
        record = ArtifactRecord(
            tenant_id=tenant_id,
            run_id=run_id,
            source=source,
            filename=safe_filename,
            storage_key="pending",
            sha256=digest,
            mime_type=mime,
            size=len(data),
            lineage_json=lineage or {},
            status=status,
        )
        key = f"{tenant_id}/{record.id}/{digest[:16]}-{safe_filename}"
        await self.store.put(key, data, mime)
        record.storage_key = key
        try:
            async with self.db.sessions() as session, session.begin():
                session.add(record)
        except Exception:
            await self.store.delete(key)
            raise
        return record

    async def read(self, artifact_id: str) -> tuple[ArtifactRecord, bytes]:
        async with self.db.sessions() as session:
            record = await session.scalar(
                select(ArtifactRecord).where(
                    ArtifactRecord.id == artifact_id, ArtifactRecord.status == "active"
                )
            )
        if record is None:
            raise KeyError("artifact not found")
        data = await self.store.get(record.storage_key)
        if hashlib.sha256(data).hexdigest() != record.sha256:
            raise ValueError("artifact checksum mismatch")
        return record, data

    async def delete(self, tenant_id: str, artifact_id: str) -> ArtifactRecord:
        async with self.db.sessions() as session, session.begin():
            record = await session.scalar(
                select(ArtifactRecord).where(
                    ArtifactRecord.id == artifact_id,
                    ArtifactRecord.tenant_id == tenant_id,
                )
            )
            if record is None or record.status == "deleted":
                raise KeyError("artifact not found")
            record.status = "deleting"
            storage_key = record.storage_key
        await self.store.delete(storage_key)
        async with self.db.sessions() as session, session.begin():
            record = await session.get(ArtifactRecord, artifact_id)
            if record is None:
                raise KeyError("artifact not found")
            record.status = "deleted"
        return record

    async def cleanup_expired(self, before: datetime) -> int:
        async with self.db.sessions() as session:
            ids = (
                await session.scalars(
                    select(ArtifactRecord.id).where(
                        ArtifactRecord.status == "active",
                        ArtifactRecord.expires_at.is_not(None),
                        ArtifactRecord.expires_at <= before,
                    )
                )
            ).all()
        deleted = 0
        for artifact_id in ids:
            async with self.db.sessions() as session:
                tenant_id = await session.scalar(
                    select(ArtifactRecord.tenant_id).where(ArtifactRecord.id == artifact_id)
                )
            if tenant_id is not None:
                await self.delete(tenant_id, artifact_id)
                deleted += 1
        return deleted
