from __future__ import annotations

import asyncio
import hashlib
import json
import re
import shutil
from pathlib import Path

import yaml
from sqlalchemy import func, select

from .config import Settings
from .db import Database
from .models import SkillRecord, SkillVersionRecord

SLUG_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{1,127}$")
FORBIDDEN_SCRIPT_PATTERNS = (
    re.compile(r"\brm\s+-rf\s+/(?:\s|$)"),
    re.compile(r"\bcurl\b.*\|\s*(?:sh|bash)\b"),
    re.compile(r"\bwget\b.*\|\s*(?:sh|bash)\b"),
)


class SkillValidationError(ValueError):
    pass


class SkillService:
    def __init__(self, db: Database, settings: Settings):
        self.db = db
        self.root = settings.skill_root.expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def parse_skill(self, directory: Path) -> tuple[dict, str, list[dict]]:
        directory = directory.expanduser().resolve()
        skill_file = directory / "SKILL.md"
        if not skill_file.is_file():
            raise SkillValidationError("SKILL.md not found")
        content = skill_file.read_text(encoding="utf-8")
        if not content.startswith("---\n"):
            raise SkillValidationError("SKILL.md must start with YAML front matter")
        parts = content.split("---", 2)
        if len(parts) != 3:
            raise SkillValidationError("invalid SKILL.md front matter")
        metadata = yaml.safe_load(parts[1]) or {}
        if not isinstance(metadata, dict):
            raise SkillValidationError("front matter must be an object")
        slug = str(metadata.get("name", "")).strip()
        description = str(metadata.get("description", "")).strip()
        if not SLUG_PATTERN.fullmatch(slug):
            raise SkillValidationError("skill name must be a lowercase slug")
        if not description:
            raise SkillValidationError("skill description is required")

        files: list[dict] = []
        total_size = 0
        for path in sorted(directory.rglob("*")):
            if path.is_symlink():
                raise SkillValidationError(f"symlinks are not allowed: {path}")
            if not path.is_file():
                continue
            resolved = path.resolve()
            if directory not in resolved.parents:
                raise SkillValidationError(f"path escapes skill directory: {path}")
            size = path.stat().st_size
            total_size += size
            if size > 5_000_000 or total_size > 20_000_000:
                raise SkillValidationError("skill bundle exceeds size limit")
            relative = path.relative_to(directory).as_posix()
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            files.append({"path": relative, "size": size, "sha256": digest})
            if relative.startswith("scripts/") and size <= 1_000_000:
                script = path.read_text(encoding="utf-8", errors="replace")
                for pattern in FORBIDDEN_SCRIPT_PATTERNS:
                    if pattern.search(script):
                        raise SkillValidationError(
                            f"forbidden script pattern in {relative}: {pattern.pattern}"
                        )
        return metadata, content, files

    async def import_directory(self, tenant_id: str, path: str) -> SkillVersionRecord:
        source = Path(path).expanduser().resolve()
        metadata, content, files = await asyncio.to_thread(self.parse_skill, source)
        manifest = {
            "metadata": metadata,
            "files": files,
            "entrypoint": "SKILL.md",
            "content": content,
        }
        content_hash = hashlib.sha256(
            json.dumps(manifest, sort_keys=True, ensure_ascii=False).encode("utf-8")
        ).hexdigest()
        destination = self.root / metadata["name"] / content_hash
        if not destination.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            await asyncio.to_thread(shutil.copytree, source, destination)

        async with self.db.sessions() as session, session.begin():
            skill = await session.scalar(
                select(SkillRecord).where(
                    SkillRecord.tenant_id == tenant_id,
                    SkillRecord.slug == metadata["name"],
                )
            )
            if skill is None:
                skill = SkillRecord(
                    tenant_id=tenant_id,
                    slug=metadata["name"],
                    name=metadata.get("title", metadata["name"]),
                    description=metadata["description"],
                )
                session.add(skill)
                await session.flush()
            existing = await session.scalar(
                select(SkillVersionRecord).where(
                    SkillVersionRecord.skill_id == skill.id,
                    SkillVersionRecord.content_hash == content_hash,
                )
            )
            if existing is not None:
                return existing
            version = (
                await session.scalar(
                    select(func.max(SkillVersionRecord.version)).where(
                        SkillVersionRecord.skill_id == skill.id
                    )
                )
                or 0
            ) + 1
            record = SkillVersionRecord(
                skill_id=skill.id,
                version=version,
                content_hash=content_hash,
                manifest_json=manifest,
                bundle_uri=str(destination),
            )
            session.add(record)
        return record

    async def materialize(self, skill_version_id: str, workspace: Path) -> dict:
        async with self.db.sessions() as session:
            version = await session.get(SkillVersionRecord, skill_version_id)
        if version is None:
            raise KeyError("skill version not found")
        source = Path(version.bundle_uri).resolve()
        target = (workspace.resolve() / ".agents" / "skills" / source.parent.name).resolve()
        if workspace.resolve() not in target.parents:
            raise SkillValidationError("skill target escapes workspace")
        if target.exists():
            await asyncio.to_thread(shutil.rmtree, target)
        target.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(shutil.copytree, source, target)
        return {"path": str(target), "manifest": version.manifest_json}

    async def get_runtime_catalog(self, version_ids: list[str]) -> list[dict]:
        if not version_ids:
            return []
        async with self.db.sessions() as session:
            versions = (
                await session.scalars(
                    select(SkillVersionRecord).where(SkillVersionRecord.id.in_(version_ids))
                )
            ).all()
        return [
            {
                "id": version.id,
                "slug": version.manifest_json["metadata"]["name"],
                "description": version.manifest_json["metadata"]["description"],
                "content": version.manifest_json["content"],
                "bundle_uri": version.bundle_uri,
            }
            for version in versions
        ]
