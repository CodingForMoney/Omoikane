from __future__ import annotations

import hashlib
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from fastapi import (
    Depends,
    FastAPI,
    File,
    Header,
    HTTPException,
    Query,
    Request,
    UploadFile,
)
from fastapi.responses import Response, StreamingResponse
from sqlalchemy import func, inspect, select
from sqlalchemy.exc import IntegrityError

from .agent_definitions import AgentDocumentRequest, AgentSettingsUpdate
from .compaction import CompactionBusy, CompactionConflict, CompactionError
from .config import Settings
from .container import Container, create_container
from .costs import BudgetExceeded
from .events import encode_sse
from .memory import hash_embedding
from .models import (
    AgentRecord,
    AgentVersionRecord,
    ApprovalRecord,
    ArtifactRecord,
    CostRecord,
    MCPServerRecord,
    MemoryRecord,
    PriceRecord,
    ProviderConnectionRecord,
    ProviderModelRecord,
    RunRecord,
    SessionItemRecord,
    SessionRecord,
    SkillRecord,
    SkillVersionRecord,
    ToolExecutionRecord,
    ToolRecord,
    UsageRecord,
)
from .providers import public_provider_catalog
from .runtime_versions import OPENAI_AGENTS_SDK_VERSION
from .schemas import (
    AgentCreate,
    AgentVersionCreate,
    ApprovalDecision,
    CompactionRequest,
    MCPServerCreate,
    MemoryCreate,
    MemoryPatch,
    PriceCreate,
    ProviderConnectionCreate,
    ProviderConnectionPatch,
    ProviderModelCreate,
    RunCreate,
    SessionCreate,
    SkillImportRequest,
    ToolCreate,
    ToolExecutionResolution,
)
from .serialization import to_jsonable
from .sessions import DatabaseSession, session_item_text
from .tool_executions import ToolExecutionConflict


def row_dict(row: Any) -> dict[str, Any]:
    mapper = inspect(row).mapper
    return {column.key: to_jsonable(getattr(row, column.key)) for column in mapper.column_attrs}


def create_app(*, settings: Settings | None = None, start_worker: bool = True) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        container = await create_container(settings=settings, start_worker=start_worker)
        app.state.container = container
        yield
        await container.close()

    app = FastAPI(
        title="Agent System",
        version="0.1.0",
        description="Persistent Agent platform built on the OpenAI Agents SDK",
        lifespan=lifespan,
    )

    def get_container(request: Request) -> Container:
        return request.app.state.container

    def identity(
        x_tenant_id: str = Header(default="default"),
        x_actor_id: str = Header(default="development-user"),
    ) -> tuple[str, str]:
        return x_tenant_id, x_actor_id

    @app.exception_handler(KeyError)
    async def key_error_handler(request: Request, exc: KeyError):
        request_id = request.headers.get("x-request-id", str(uuid.uuid4()))
        return Response(
            content=__import__("json").dumps(
                {
                    "error": {
                        "code": "not_found",
                        "message": str(exc).strip("'"),
                        "request_id": request_id,
                        "details": {},
                    }
                }
            ),
            status_code=404,
            media_type="application/json",
        )

    @app.exception_handler(ValueError)
    @app.exception_handler(BudgetExceeded)
    async def validation_error_handler(request: Request, exc: Exception):
        request_id = request.headers.get("x-request-id", str(uuid.uuid4()))
        code = "budget_exceeded" if isinstance(exc, BudgetExceeded) else "invalid_request"
        return Response(
            content=__import__("json").dumps(
                {
                    "error": {
                        "code": code,
                        "message": str(exc),
                        "request_id": request_id,
                        "details": {},
                    }
                }
            ),
            status_code=429 if isinstance(exc, BudgetExceeded) else 422,
            media_type="application/json",
        )

    @app.exception_handler(IntegrityError)
    async def integrity_error_handler(request: Request, exc: IntegrityError):
        request_id = request.headers.get("x-request-id", str(uuid.uuid4()))
        return Response(
            content=__import__("json").dumps(
                {
                    "error": {
                        "code": "conflict",
                        "message": "resource conflicts with an existing record",
                        "request_id": request_id,
                        "details": {},
                    }
                }
            ),
            status_code=409,
            media_type="application/json",
        )

    @app.exception_handler(ToolExecutionConflict)
    async def tool_execution_conflict_handler(request: Request, exc: ToolExecutionConflict):
        request_id = request.headers.get("x-request-id", str(uuid.uuid4()))
        return Response(
            content=__import__("json").dumps(
                {
                    "error": {
                        "code": "tool_execution_conflict",
                        "message": str(exc),
                        "request_id": request_id,
                        "details": {},
                    }
                }
            ),
            status_code=409,
            media_type="application/json",
        )

    @app.exception_handler(CompactionBusy)
    @app.exception_handler(CompactionConflict)
    async def compaction_conflict_handler(request: Request, exc: Exception):
        request_id = request.headers.get("x-request-id", str(uuid.uuid4()))
        return Response(
            content=__import__("json").dumps(
                {
                    "error": {
                        "code": "compaction_conflict",
                        "message": str(exc),
                        "request_id": request_id,
                        "details": {},
                    }
                }
            ),
            status_code=409,
            media_type="application/json",
        )

    @app.exception_handler(CompactionError)
    async def compaction_error_handler(request: Request, exc: CompactionError):
        request_id = request.headers.get("x-request-id", str(uuid.uuid4()))
        return Response(
            content=__import__("json").dumps(
                {
                    "error": {
                        "code": "compaction_failed",
                        "message": str(exc),
                        "request_id": request_id,
                        "details": {},
                    }
                }
            ),
            status_code=422,
            media_type="application/json",
        )

    async def session_agent_config(
        container: Container,
        session_id: str,
        tenant_id: str,
        agent_version_id: str | None = None,
    ) -> dict[str, Any]:
        async with container.db.sessions() as session:
            owner = await session.scalar(
                select(SessionRecord).where(
                    SessionRecord.id == session_id,
                    SessionRecord.tenant_id == tenant_id,
                )
            )
            if owner is None:
                raise KeyError("session not found")
            resolved_version_id = agent_version_id or owner.scope.get("agent_version_id")
            if not resolved_version_id:
                resolved_version_id = await session.scalar(
                    select(RunRecord.agent_version_id)
                    .where(
                        RunRecord.session_id == session_id,
                        RunRecord.tenant_id == tenant_id,
                    )
                    .order_by(RunRecord.created_at.desc())
                    .limit(1)
                )
            if not resolved_version_id:
                raise ValueError(
                    "agent_version_id is required until the session has an associated run"
                )
            version = await session.scalar(
                select(AgentVersionRecord).where(
                    AgentVersionRecord.id == resolved_version_id,
                    AgentVersionRecord.tenant_id == tenant_id,
                )
            )
        if version is None:
            raise KeyError("agent version not found")
        return await container.providers.resolve_agent_config(dict(version.config_json), tenant_id)

    async def ensure_session_owner(container: Container, session_id: str, tenant_id: str) -> None:
        async with container.db.sessions() as session:
            owner = await session.scalar(
                select(SessionRecord.id).where(
                    SessionRecord.id == session_id,
                    SessionRecord.tenant_id == tenant_id,
                )
            )
        if owner is None:
            raise KeyError("session not found")

    @app.get("/healthz")
    async def health(container: Container = Depends(get_container)):
        async with container.db.sessions() as session:
            await session.scalar(select(1))
        return {"status": "ok", "sdk_version": OPENAI_AGENTS_SDK_VERSION}

    @app.get("/v1/provider-definitions")
    async def list_provider_definitions():
        return {"data": public_provider_catalog()}

    @app.post("/v1/provider-connections", status_code=201)
    async def create_provider_connection(
        data: ProviderConnectionCreate,
        sync_models: bool = Query(default=True),
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        record = await container.providers.create_connection(who[0], data)
        sync_result = None
        if sync_models:
            sync_result = await container.providers.validate_connection(
                who[0], record.id, sync=True
            )
            async with container.db.sessions() as session:
                refreshed = await session.scalar(
                    select(ProviderConnectionRecord).where(
                        ProviderConnectionRecord.id == record.id,
                        ProviderConnectionRecord.tenant_id == who[0],
                    )
                )
            if refreshed is not None:
                record = refreshed
        payload = container.providers.connection_dict(record)
        payload["model_sync"] = sync_result
        return payload

    @app.get("/v1/provider-connections")
    async def list_provider_connections(
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            rows = (
                await session.scalars(
                    select(ProviderConnectionRecord)
                    .where(ProviderConnectionRecord.tenant_id == who[0])
                    .order_by(ProviderConnectionRecord.created_at.desc())
                )
            ).all()
        return {"data": [container.providers.connection_dict(row) for row in rows]}

    @app.get("/v1/provider-connections/{connection_id}")
    async def get_provider_connection(
        connection_id: str,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            record = await session.scalar(
                select(ProviderConnectionRecord).where(
                    ProviderConnectionRecord.id == connection_id,
                    ProviderConnectionRecord.tenant_id == who[0],
                )
            )
        if record is None:
            raise KeyError("provider connection not found")
        return container.providers.connection_dict(record)

    @app.patch("/v1/provider-connections/{connection_id}")
    async def patch_provider_connection(
        connection_id: str,
        data: ProviderConnectionPatch,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        record = await container.providers.update_connection(who[0], connection_id, data)
        return container.providers.connection_dict(record)

    @app.post("/v1/provider-connections/{connection_id}/validate")
    async def validate_provider_connection(
        connection_id: str,
        sync_models: bool = Query(default=True),
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        return await container.providers.validate_connection(
            who[0], connection_id, sync=sync_models
        )

    @app.get("/v1/provider-connections/{connection_id}/models")
    async def list_provider_models(
        connection_id: str,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            owner = await session.scalar(
                select(ProviderConnectionRecord.id).where(
                    ProviderConnectionRecord.id == connection_id,
                    ProviderConnectionRecord.tenant_id == who[0],
                )
            )
            if owner is None:
                raise KeyError("provider connection not found")
            rows = (
                await session.scalars(
                    select(ProviderModelRecord)
                    .where(
                        ProviderModelRecord.connection_id == connection_id,
                        ProviderModelRecord.tenant_id == who[0],
                    )
                    .order_by(ProviderModelRecord.model_id)
                )
            ).all()
        return {"data": [row_dict(row) for row in rows]}

    @app.post("/v1/provider-connections/{connection_id}/models", status_code=201)
    async def add_provider_model(
        connection_id: str,
        data: ProviderModelCreate,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        return row_dict(await container.providers.add_model(who[0], connection_id, data))

    @app.post("/v1/agents", status_code=201)
    async def create_agent(
        data: AgentCreate,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        record = await container.registry.create_agent(who[0], who[1], data)
        return row_dict(record)

    @app.get("/v1/agent-settings")
    async def get_agent_settings(
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        return await container.definitions.settings_view(who[0])

    @app.put("/v1/agent-settings")
    async def update_agent_settings(
        data: AgentSettingsUpdate,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        await container.definitions.update_settings(who[0], who[1], data)
        return await container.definitions.settings_view(who[0])

    @app.post("/v1/agent-definitions/validate")
    async def validate_agent_definition(
        data: AgentDocumentRequest,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        compiled = await container.definitions.compile_document(who[0], data.document)
        return container.definitions.preview(compiled)

    @app.post("/v1/agents/from-definition", status_code=201)
    async def create_agent_from_definition(
        data: AgentDocumentRequest,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        compiled = await container.definitions.compile_document(who[0], data.document)
        definition = compiled.definition
        agent = await container.registry.create_agent(
            who[0],
            who[1],
            AgentCreate(
                slug=definition.name,
                name=definition.display_name or definition.name,
                description=definition.description,
            ),
        )
        version = await container.registry.create_agent_version(
            who[0],
            who[1],
            agent.id,
            compiled.effective_config,
            compiled_definition=compiled,
        )
        if data.publish:
            version = await container.registry.publish_agent_version(who[0], who[1], version.id)
        return {
            "agent": row_dict(agent),
            "version": row_dict(version),
            "compiled": container.definitions.preview(compiled),
        }

    @app.post("/v1/agents/{agent_id}/versions/from-definition", status_code=201)
    async def create_agent_version_from_definition(
        agent_id: str,
        data: AgentDocumentRequest,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        compiled = await container.definitions.compile_document(who[0], data.document)
        async with container.db.sessions() as session:
            agent = await session.scalar(
                select(AgentRecord).where(
                    AgentRecord.id == agent_id,
                    AgentRecord.tenant_id == who[0],
                )
            )
        if agent is None:
            raise KeyError("agent not found")
        if compiled.definition.name != agent.slug:
            raise ValueError(
                "Agent document name must match the existing logical Agent slug: "
                f"{agent.slug}"
            )
        version = await container.registry.create_agent_version(
            who[0],
            who[1],
            agent.id,
            compiled.effective_config,
            compiled_definition=compiled,
        )
        if data.publish:
            version = await container.registry.publish_agent_version(who[0], who[1], version.id)
        return {
            "agent": row_dict(agent),
            "version": row_dict(version),
            "compiled": container.definitions.preview(compiled),
        }

    @app.get("/v1/agents")
    async def list_agents(
        limit: int = Query(default=100, ge=1, le=500),
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            rows = (
                await session.scalars(
                    select(AgentRecord)
                    .where(AgentRecord.tenant_id == who[0])
                    .order_by(AgentRecord.created_at.desc())
                    .limit(limit)
                )
            ).all()
        return {"data": [row_dict(row) for row in rows]}

    @app.get("/v1/agents/{agent_id}")
    async def get_agent(
        agent_id: str,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            record = await session.scalar(
                select(AgentRecord).where(
                    AgentRecord.id == agent_id, AgentRecord.tenant_id == who[0]
                )
            )
        if record is None:
            raise KeyError("agent not found")
        return row_dict(record)

    @app.post("/v1/agents/{agent_id}/versions", status_code=201)
    async def create_agent_version(
        agent_id: str,
        data: AgentVersionCreate,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        record = await container.registry.create_agent_version(
            who[0], who[1], agent_id, data.config
        )
        return row_dict(record)

    @app.get("/v1/agents/{agent_id}/versions")
    async def list_agent_versions(
        agent_id: str,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            rows = (
                await session.scalars(
                    select(AgentVersionRecord)
                    .where(
                        AgentVersionRecord.agent_id == agent_id,
                        AgentVersionRecord.tenant_id == who[0],
                    )
                    .order_by(AgentVersionRecord.version)
                )
            ).all()
        return {"data": [row_dict(row) for row in rows]}

    @app.post("/v1/agents/{agent_id}/versions/{version}/publish")
    async def publish_agent_version(
        agent_id: str,
        version: int,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            version_id = await session.scalar(
                select(AgentVersionRecord.id).where(
                    AgentVersionRecord.agent_id == agent_id,
                    AgentVersionRecord.version == version,
                    AgentVersionRecord.tenant_id == who[0],
                )
            )
        if version_id is None:
            raise KeyError("agent version not found")
        return row_dict(await container.registry.publish_agent_version(who[0], who[1], version_id))

    @app.get("/v1/agents/{agent_id}/versions/{version}/definition")
    async def get_agent_definition(
        agent_id: str,
        version: int,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            record = await session.scalar(
                select(AgentVersionRecord).where(
                    AgentVersionRecord.agent_id == agent_id,
                    AgentVersionRecord.version == version,
                    AgentVersionRecord.tenant_id == who[0],
                )
            )
        if record is None:
            raise KeyError("agent version not found")
        return {
            "format": record.definition_format,
            "document": record.definition_source,
            "definition": record.definition_json,
            "overrides": record.overrides_json,
            "effective_config": record.config_json,
            "global_defaults_revision": record.global_defaults_revision,
            "platform_policy_revision": record.platform_policy_revision,
            "config_hash": record.config_hash,
        }

    @app.post("/v1/sessions", status_code=201)
    async def create_session(
        data: SessionCreate,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        record = SessionRecord(tenant_id=who[0], scope=data.scope)
        async with container.db.sessions() as session, session.begin():
            session.add(record)
        return row_dict(record)

    @app.get("/v1/sessions")
    async def list_sessions(
        status: str | None = None,
        limit: int = Query(default=100, ge=1, le=500),
        offset: int = Query(default=0, ge=0),
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        query = select(SessionRecord).where(SessionRecord.tenant_id == who[0])
        if status:
            query = query.where(SessionRecord.status == status)
        query = query.order_by(SessionRecord.updated_at.desc()).offset(offset).limit(limit)
        async with container.db.sessions() as session:
            records = (await session.scalars(query)).all()
            session_ids = [record.id for record in records]
            version_ids = {
                str((record.scope or {}).get("agent_version_id") or "")
                for record in records
                if (record.scope or {}).get("agent_version_id")
            }
            version_rows = (
                (
                    await session.execute(
                        select(AgentVersionRecord.id, AgentVersionRecord.agent_id).where(
                            AgentVersionRecord.id.in_(version_ids),
                            AgentVersionRecord.tenant_id == who[0],
                        )
                    )
                ).all()
                if version_ids
                else []
            )
            transcript_rows = (
                (
                    await session.execute(
                        select(
                            SessionItemRecord.session_id,
                            SessionItemRecord.item_json,
                        )
                        .where(
                            SessionItemRecord.session_id.in_(session_ids),
                            SessionItemRecord.active.is_(True),
                        )
                        .order_by(SessionItemRecord.session_id, SessionItemRecord.seq)
                    )
                ).all()
                if session_ids
                else []
            )
        first_user_text: dict[str, str] = {}
        version_agents = {version_id: agent_id for version_id, agent_id in version_rows}
        for session_id, item in transcript_rows:
            if session_id in first_user_text or str((item or {}).get("role") or "") != "user":
                continue
            content = session_item_text((item or {}).get("content")).strip()
            if content:
                first_user_text[session_id] = content
        data = []
        for record in records:
            item = row_dict(record)
            scope = dict(record.scope or {})
            item["agent_version_id"] = scope.get("agent_version_id")
            item["agent_id"] = scope.get("agent_id") or version_agents.get(
                scope.get("agent_version_id")
            )
            item["title"] = str(scope.get("title") or first_user_text.get(record.id) or "新对话")[
                :80
            ]
            data.append(item)
        return {"data": data, "limit": limit, "offset": offset}

    @app.get("/v1/sessions/{session_id}")
    async def get_session(
        session_id: str,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            record = await session.scalar(
                select(SessionRecord).where(
                    SessionRecord.id == session_id, SessionRecord.tenant_id == who[0]
                )
            )
        if record is None:
            raise KeyError("session not found")
        return row_dict(record)

    @app.get("/v1/sessions/{session_id}/messages")
    async def list_session_messages(
        session_id: str,
        include_compacted: bool = False,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            owner = await session.scalar(
                select(SessionRecord.id).where(
                    SessionRecord.id == session_id, SessionRecord.tenant_id == who[0]
                )
            )
            if owner is None:
                raise KeyError("session not found")
            if include_compacted:
                rows = (
                    await session.scalars(
                        select(SessionItemRecord)
                        .where(SessionItemRecord.session_id == session_id)
                        .order_by(SessionItemRecord.seq)
                    )
                ).all()
                return {"view": "canonical_transcript", "data": [row_dict(row) for row in rows]}
        items = await DatabaseSession(container.db, session_id).get_items()
        return {
            "view": "model_projection",
            "data": [
                {"position": position, "item_json": item} for position, item in enumerate(items)
            ],
        }

    @app.get("/v1/sessions/{session_id}/chat-messages")
    async def list_session_chat_messages(
        session_id: str,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            owner = await session.scalar(
                select(SessionRecord.id).where(
                    SessionRecord.id == session_id, SessionRecord.tenant_id == who[0]
                )
            )
        if owner is None:
            raise KeyError("session not found")
        return {
            "view": "canonical_chat",
            "data": await DatabaseSession(container.db, session_id).chat_messages(),
        }

    @app.post("/v1/sessions/{session_id}/compact")
    async def compact_session(
        session_id: str,
        data: CompactionRequest,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        config = await session_agent_config(
            container,
            session_id,
            who[0],
            data.agent_version_id,
        )
        record = await container.compaction.compact_session(
            session_id,
            config,
            force=data.force,
            strategy=data.strategy,
            focus=data.focus,
            trigger="manual",
            dry_run=data.dry_run,
        )
        return {"compacted": record is not None, "compaction": row_dict(record) if record else None}

    @app.get("/v1/sessions/{session_id}/compactions")
    async def list_compactions(
        session_id: str,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        await ensure_session_owner(container, session_id, who[0])
        rows = await container.compaction.list_compactions(session_id)
        return {"data": [row_dict(row) for row in rows]}

    @app.get("/v1/sessions/{session_id}/compactions/{compaction_id}")
    async def get_compaction(
        session_id: str,
        compaction_id: str,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        await ensure_session_owner(container, session_id, who[0])
        return row_dict(await container.compaction.get_compaction(session_id, compaction_id))

    @app.post("/v1/sessions/{session_id}/compactions/{compaction_id}/restore")
    async def restore_compaction(
        session_id: str,
        compaction_id: str,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        await ensure_session_owner(container, session_id, who[0])
        return await container.compaction.restore(session_id, compaction_id)

    @app.get("/v1/sessions/{session_id}/context-preview")
    async def context_preview(
        session_id: str,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        await ensure_session_owner(container, session_id, who[0])
        return await container.compaction.context_preview(session_id)

    @app.post("/v1/runs", status_code=202)
    async def create_run(
        data: RunCreate,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        record = await container.runner.create_run(
            tenant_id=who[0],
            agent_version_id=data.agent_version_id,
            input_value=data.input,
            session_id=data.session_id,
            context=data.context,
            limits=data.limits,
            idempotency_key=idempotency_key,
            parent_run_id=data.parent_run_id,
        )
        return row_dict(record)

    @app.get("/v1/runs/{run_id}")
    async def get_run(
        run_id: str,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            record = await session.scalar(
                select(RunRecord).where(RunRecord.id == run_id, RunRecord.tenant_id == who[0])
            )
        if record is None:
            raise KeyError("run not found")
        return row_dict(record)

    @app.post("/v1/runs/{run_id}/cancel")
    async def cancel_run(
        run_id: str,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        return row_dict(await container.runner.cancel(who[0], run_id))

    @app.get("/v1/runs/{run_id}/events")
    async def list_run_events(
        run_id: str,
        after: int = Query(default=0, ge=0),
        limit: int = Query(default=500, ge=1, le=1000),
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            owner = await session.scalar(
                select(RunRecord.id).where(RunRecord.id == run_id, RunRecord.tenant_id == who[0])
            )
        if owner is None:
            raise KeyError("run not found")
        return {"data": await container.events.list(run_id, after, limit)}

    @app.get("/v1/runs/{run_id}/tool-executions")
    async def list_tool_executions(
        run_id: str,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            owner = await session.scalar(
                select(RunRecord.id).where(RunRecord.id == run_id, RunRecord.tenant_id == who[0])
            )
        if owner is None:
            raise KeyError("run not found")
        await container.tool_executions.reap_expired(run_id)
        async with container.db.sessions() as session:
            rows = (
                await session.scalars(
                    select(ToolExecutionRecord)
                    .where(
                        ToolExecutionRecord.run_id == run_id,
                        ToolExecutionRecord.tenant_id == who[0],
                    )
                    .order_by(ToolExecutionRecord.created_at)
                )
            ).all()
        return {"data": [row_dict(row) for row in rows]}

    @app.post("/v1/tool-executions/{execution_id}/resolve")
    async def resolve_tool_execution(
        execution_id: str,
        data: ToolExecutionResolution,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            run_id = await session.scalar(
                select(ToolExecutionRecord.run_id).where(
                    ToolExecutionRecord.id == execution_id,
                    ToolExecutionRecord.tenant_id == who[0],
                )
            )
        if run_id is None:
            raise KeyError("tool execution not found")
        closed_run = False
        async with container.db.sessions() as session, session.begin():
            run = await session.scalar(
                select(RunRecord).where(RunRecord.id == run_id).with_for_update()
            )
            record = await container.tool_executions.resolve_in_transaction(
                session,
                tenant_id=who[0],
                execution_id=execution_id,
                status=data.status,
                actor_id=who[1],
                reason=data.reason,
                output=data.output,
                error=data.error,
            )
            if run is not None and run.status == "waiting_reconciliation":
                run.status = "failed"
                run.error_json = {
                    "code": "tool_execution_reconciled",
                    "message": (
                        "the interrupted tool outcome was reconciled, but the Agent loop "
                        "cannot be resumed safely from the middle of that call"
                    ),
                    "tool_execution_id": record.id,
                    "tool_execution_status": record.status,
                }
                run.completed_at = datetime.now(UTC)
                await container.events.append_in_transaction(
                    session,
                    run,
                    "run.failed",
                    {
                        "code": "tool_execution_reconciled",
                        "tool_execution_id": record.id,
                        "tool_execution_status": record.status,
                    },
                )
                closed_run = True
        if closed_run:
            await container.events.dispatch_pending(run_id=run_id)
        return row_dict(record)

    @app.get("/v1/runs/{run_id}/stream")
    async def stream_run(
        run_id: str,
        request: Request,
        last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            owner = await session.scalar(
                select(RunRecord.id).where(RunRecord.id == run_id, RunRecord.tenant_id == who[0])
            )
        if owner is None:
            raise KeyError("run not found")
        try:
            after = int(last_event_id or 0)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid Last-Event-ID") from exc

        async def generate():
            async for event in container.events.stream(
                run_id, after=after, heartbeat=container.settings.sse_heartbeat_seconds
            ):
                if await request.is_disconnected():
                    return
                yield encode_sse(event)

        return StreamingResponse(
            generate(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"}
        )

    @app.get("/v1/approvals")
    async def list_approvals(
        status: str | None = None,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            query = select(ApprovalRecord).where(ApprovalRecord.tenant_id == who[0])
            if status:
                query = query.where(ApprovalRecord.status == status)
            rows = (await session.scalars(query.order_by(ApprovalRecord.created_at.desc()))).all()
        return {"data": [row_dict(row) for row in rows]}

    @app.get("/v1/approvals/{approval_id}")
    async def get_approval(
        approval_id: str,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            row = await session.scalar(
                select(ApprovalRecord).where(
                    ApprovalRecord.id == approval_id, ApprovalRecord.tenant_id == who[0]
                )
            )
        if row is None:
            raise KeyError("approval not found")
        return row_dict(row)

    async def decide(
        approval_id: str,
        decision: str,
        data: ApprovalDecision,
        who: tuple[str, str],
        container: Container,
    ):
        return row_dict(
            await container.runner.decide_approval(
                tenant_id=who[0],
                approval_id=approval_id,
                decision=decision,
                actor_id=who[1],
                reason=data.reason,
            )
        )

    @app.post("/v1/approvals/{approval_id}/approve")
    async def approve(
        approval_id: str,
        data: ApprovalDecision,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        return await decide(approval_id, "approved", data, who, container)

    @app.post("/v1/approvals/{approval_id}/reject")
    async def reject(
        approval_id: str,
        data: ApprovalDecision,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        return await decide(approval_id, "rejected", data, who, container)

    @app.post("/v1/tools", status_code=201)
    async def create_tool(
        data: ToolCreate,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        return row_dict(await container.registry.create_tool(who[0], data))

    @app.get("/v1/tools")
    async def list_tools(
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            rows = (
                await session.scalars(
                    select(ToolRecord)
                    .where(ToolRecord.tenant_id == who[0])
                    .order_by(ToolRecord.slug)
                )
            ).all()
        return {"data": [row_dict(row) for row in rows]}

    @app.post("/v1/mcp-servers", status_code=201)
    async def create_mcp(
        data: MCPServerCreate,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        return row_dict(await container.registry.create_mcp(who[0], data))

    @app.get("/v1/mcp-servers")
    async def list_mcp(
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            rows = (
                await session.scalars(
                    select(MCPServerRecord).where(MCPServerRecord.tenant_id == who[0])
                )
            ).all()
        return {"data": [row_dict(row) for row in rows]}

    @app.post("/v1/mcp-servers/{server_id}/health")
    async def check_mcp_health(
        server_id: str,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            row = await session.scalar(
                select(MCPServerRecord).where(
                    MCPServerRecord.id == server_id,
                    MCPServerRecord.tenant_id == who[0],
                )
            )
        if row is None:
            raise KeyError("MCP server not found")
        return await container.factory.check_mcp(row)

    @app.post("/v1/skills/import", status_code=201)
    async def import_skill(
        data: SkillImportRequest,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        return row_dict(await container.skills.import_directory(who[0], data.path))

    @app.get("/v1/skills")
    async def list_skills(
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            rows = (
                await session.scalars(select(SkillRecord).where(SkillRecord.tenant_id == who[0]))
            ).all()
        return {"data": [row_dict(row) for row in rows]}

    @app.get("/v1/skills/{skill_id}/versions")
    async def list_skill_versions(
        skill_id: str,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            owner = await session.scalar(
                select(SkillRecord.id).where(
                    SkillRecord.id == skill_id, SkillRecord.tenant_id == who[0]
                )
            )
            if owner is None:
                raise KeyError("skill not found")
            rows = (
                await session.scalars(
                    select(SkillVersionRecord)
                    .where(SkillVersionRecord.skill_id == skill_id)
                    .order_by(SkillVersionRecord.version)
                )
            ).all()
        return {"data": [row_dict(row) for row in rows]}

    @app.post("/v1/memories", status_code=201)
    async def create_memory(
        data: MemoryCreate,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        record = await container.memory.create(
            tenant_id=who[0], **data.model_dump(), source={"actor_id": who[1]}
        )
        return row_dict(record)

    @app.get("/v1/memories")
    async def list_memories(
        scope_type: str | None = None,
        scope_id: str | None = None,
        enabled: bool | None = None,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            query = select(MemoryRecord).where(MemoryRecord.tenant_id == who[0])
            if scope_type:
                query = query.where(MemoryRecord.scope_type == scope_type)
            if scope_id:
                query = query.where(MemoryRecord.scope_id == scope_id)
            if enabled is not None:
                query = query.where(MemoryRecord.enabled == enabled)
            rows = (await session.scalars(query.order_by(MemoryRecord.updated_at.desc()))).all()
        return {"data": [row_dict(row) for row in rows]}

    @app.patch("/v1/memories/{memory_id}")
    async def patch_memory(
        memory_id: str,
        data: MemoryPatch,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session, session.begin():
            row = await session.scalar(
                select(MemoryRecord)
                .where(MemoryRecord.id == memory_id, MemoryRecord.tenant_id == who[0])
                .with_for_update()
            )
            if row is None:
                raise KeyError("memory not found")
            patch = data.model_dump(exclude_none=True)
            if "content" in patch:
                container.memory._validate_content(patch["content"])
                row.content = patch["content"]
                row.content_hash = hashlib.sha256(row.content.encode()).hexdigest()
                embedding = hash_embedding(row.content)
                row.embedding_json = embedding
                row.embedding_vector = embedding
            if "confidence" in patch:
                row.confidence = patch["confidence"]
            if "enabled" in patch:
                row.enabled = patch["enabled"]
        return row_dict(row)

    @app.delete("/v1/memories/{memory_id}", status_code=204)
    async def delete_memory(
        memory_id: str,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session, session.begin():
            row = await session.scalar(
                select(MemoryRecord).where(
                    MemoryRecord.id == memory_id, MemoryRecord.tenant_id == who[0]
                )
            )
            if row is None:
                raise KeyError("memory not found")
            row.enabled = False
            row.valid_to = datetime.now(UTC)
        return Response(status_code=204)

    @app.post("/v1/artifacts", status_code=201)
    async def upload_artifact(
        file: UploadFile = File(...),
        run_id: str | None = None,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        data = await file.read()
        if len(data) > 100_000_000:
            raise ValueError("artifact exceeds 100 MB upload limit")
        record = await container.artifacts.create(
            tenant_id=who[0],
            filename=file.filename or "artifact.bin",
            data=data,
            mime_type=file.content_type,
            run_id=run_id,
        )
        return row_dict(record)

    @app.get("/v1/artifacts/{artifact_id}")
    async def get_artifact(
        artifact_id: str,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            row = await session.scalar(
                select(ArtifactRecord).where(
                    ArtifactRecord.id == artifact_id, ArtifactRecord.tenant_id == who[0]
                )
            )
        if row is None:
            raise KeyError("artifact not found")
        return row_dict(row)

    @app.get("/v1/artifacts/{artifact_id}/download")
    async def download_artifact(
        artifact_id: str,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        record, data = await container.artifacts.read(artifact_id)
        if record.tenant_id != who[0]:
            raise KeyError("artifact not found")
        filename = record.filename.replace('"', "")
        return Response(
            content=data,
            media_type=record.mime_type,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @app.delete("/v1/artifacts/{artifact_id}", status_code=204)
    async def delete_artifact(
        artifact_id: str,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        await container.artifacts.delete(who[0], artifact_id)
        return Response(status_code=204)

    @app.post("/v1/prices", status_code=201)
    async def create_price(
        data: PriceCreate,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        record = PriceRecord(**data.model_dump())
        async with container.db.sessions() as session, session.begin():
            session.add(record)
        return row_dict(record)

    @app.get("/v1/usage")
    async def list_usage(
        run_id: str | None = None,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            query = select(UsageRecord).where(UsageRecord.tenant_id == who[0])
            if run_id:
                query = query.where(UsageRecord.run_id == run_id)
            rows = (await session.scalars(query.order_by(UsageRecord.created_at.desc()))).all()
        return {"data": [row_dict(row) for row in rows]}

    @app.get("/v1/costs")
    async def list_costs(
        run_id: str | None = None,
        who: tuple[str, str] = Depends(identity),
        container: Container = Depends(get_container),
    ):
        async with container.db.sessions() as session:
            query = select(CostRecord).where(CostRecord.tenant_id == who[0])
            if run_id:
                query = query.where(CostRecord.run_id == run_id)
            rows = (await session.scalars(query.order_by(CostRecord.created_at.desc()))).all()
            total = await session.scalar(
                select(func.coalesce(func.sum(CostRecord.amount), 0.0)).where(
                    CostRecord.tenant_id == who[0]
                )
            )
        return {"data": [row_dict(row) for row in rows], "tenant_total": float(total or 0)}

    return app
