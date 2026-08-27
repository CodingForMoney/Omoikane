from __future__ import annotations

import hashlib
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any

from jsonschema import Draft202012Validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from .agent_definitions import AgentDefinitionService, CompiledAgentDefinition
from .agent_factory import AgentFactory
from .db import Database
from .models import (
    AgentRecord,
    AgentVersionRecord,
    AuditLogRecord,
    BindingRecord,
    MCPServerRecord,
    SkillVersionRecord,
    ToolRecord,
)
from .providers import ProviderService
from .schemas import AgentCreate, MCPServerCreate, ToolCreate
from .serialization import canonical_json, to_jsonable
from .tools import BUILTIN_TOOL_DEFINITIONS

ALLOWED_BINDING_KINDS = {"tool", "mcp", "skill", "handoff", "agent_tool"}


class RegistryService:
    def __init__(
        self,
        db: Database,
        agent_factory: AgentFactory,
        providers: ProviderService,
        definitions: AgentDefinitionService,
    ):
        self.db = db
        self.agent_factory = agent_factory
        self.providers = providers
        self.definitions = definitions

    async def _audit(
        self,
        *,
        tenant_id: str,
        actor_id: str,
        action: str,
        resource_type: str,
        resource_id: str,
        before: dict | None = None,
        after: dict | None = None,
    ) -> None:
        async with self.db.sessions() as session, session.begin():
            session.add(
                AuditLogRecord(
                    tenant_id=tenant_id,
                    actor_id=actor_id,
                    action=action,
                    resource_type=resource_type,
                    resource_id=resource_id,
                    before_json=before,
                    after_json=after,
                )
            )

    async def seed_builtin_tools(self, tenant_id: str = "default") -> None:
        for implementation_key, definition in BUILTIN_TOOL_DEFINITIONS.items():
            try:
                async with self.db.sessions() as session, session.begin():
                    slug = implementation_key.replace("builtin.", "").replace("_", "-")
                    default_policy = {
                        "timeout_seconds": 30,
                        "approval_mode": "never",
                        "side_effect": "none",
                    }
                    if implementation_key == "builtin.artifact_write":
                        default_policy["side_effect"] = "reversible"
                    if implementation_key in {
                        "builtin.sandbox_exec",
                        "builtin.memory_remember",
                    }:
                        default_policy["approval_mode"] = "policy"
                        default_policy["side_effect"] = "external"
                    existing = await session.scalar(
                        select(ToolRecord).where(
                            ToolRecord.tenant_id == tenant_id, ToolRecord.slug == slug
                        )
                    )
                    if existing:
                        # Backfill new safety defaults without replacing an explicit
                        # policy already configured for this builtin.
                        existing.policy_json = {
                            **default_policy,
                            **existing.policy_json,
                        }
                        continue
                    session.add(
                        ToolRecord(
                            tenant_id=tenant_id,
                            slug=slug,
                            name=definition["name"],
                            description=definition["description"],
                            implementation_key=implementation_key,
                            schema_json=definition["schema"],
                            policy_json=default_policy,
                        )
                    )
            except IntegrityError:
                # Another API/Worker process seeded the same immutable builtin first.
                continue

    async def create_agent(self, tenant_id: str, actor_id: str, data: AgentCreate) -> AgentRecord:
        record = AgentRecord(tenant_id=tenant_id, **data.model_dump())
        async with self.db.sessions() as session, session.begin():
            session.add(record)
        await self._audit(
            tenant_id=tenant_id,
            actor_id=actor_id,
            action="agent.create",
            resource_type="agent",
            resource_id=record.id,
            after=to_jsonable(record),
        )
        return record

    def validate_agent_config(self, config: dict[str, Any]) -> None:
        managed_provider = bool(config.get("provider_connection_id"))
        if not managed_provider and not config.get("model"):
            raise ValueError("config.model is required for legacy provider configurations")
        if not config.get("instructions"):
            raise ValueError("config.instructions is required")
        provider = config.get("provider", {})
        if managed_provider and provider:
            raise ValueError("managed provider configurations use provider_options, not provider")
        forbidden = {"api_key", "token", "secret", "authorization"}
        if any(key.lower() in forbidden for key in provider):
            raise ValueError("provider credentials must use api_key_env, never inline secrets")
        provider_type = provider.get("type", "openai")
        if provider_type == "deterministic" and self.agent_factory.settings.environment != "test":
            raise ValueError("deterministic provider is allowed only in tests")
        if provider_type != "deterministic" and provider.get("protocol", "responses") not in {
            "responses",
            "chat_completions",
        }:
            raise ValueError("provider.protocol must be responses or chat_completions")
        if provider.get("structured_output_mode", "native") not in {"native", "prompt"}:
            raise ValueError("provider.structured_output_mode must be native or prompt")
        if config.get("output_schema"):
            Draft202012Validator.check_schema(config["output_schema"])
        runtime_policy = config.get("runtime_policy", {})
        for key in ("max_turns", "max_tool_calls", "max_handoff_depth"):
            if key in runtime_policy and int(runtime_policy[key]) <= 0:
                raise ValueError(f"runtime_policy.{key} must be positive")
        compaction = config.get("compaction") or {}
        if compaction:
            if compaction.get("strategy", "auto") not in {"auto", "native", "portable"}:
                raise ValueError("compaction.strategy must be auto, native, or portable")
            context_window = int(
                compaction.get("context_window") or provider.get("context_window") or 0
            )
            if context_window <= 0:
                raise ValueError("compaction requires an explicit context_window")
            summary_context = int(compaction.get("summary_context_window") or context_window)
            summary_output = int(compaction.get("summary_output_tokens", 4096))
            prompt_reserve = int(compaction.get("summary_prompt_reserve_tokens", 4096))
            safety_margin = int(compaction.get("safety_margin_tokens", 4096))
            if summary_output < 1024:
                raise ValueError("compaction.summary_output_tokens must be at least 1024")
            context_type = str(compaction.get("context_window_type", "total"))
            summary_type = str(compaction.get("summary_context_window_type", context_type))
            summary_required = prompt_reserve + safety_margin
            if summary_type != "input":
                summary_required += summary_output
            if summary_context <= summary_required:
                raise ValueError("compaction summary model has no usable input budget")
            for key in (
                "reserved_output_tokens",
                "trigger_tokens",
                "target_projection_tokens",
                "keep_recent_tokens",
                "lease_seconds",
                "timeout_seconds",
            ):
                if key in compaction and float(compaction[key]) <= 0:
                    raise ValueError(f"compaction.{key} must be positive")
        for binding in config.get("bindings", []):
            if binding.get("kind") not in ALLOWED_BINDING_KINDS:
                raise ValueError(f"unsupported binding kind: {binding.get('kind')}")
            if not binding.get("target_id"):
                raise ValueError("binding.target_id is required")

    async def create_agent_version(
        self,
        tenant_id: str,
        actor_id: str,
        agent_id: str,
        config: dict[str, Any],
        *,
        compiled_definition: CompiledAgentDefinition | None = None,
    ) -> AgentVersionRecord:
        if compiled_definition is not None:
            if canonical_json(config) != canonical_json(compiled_definition.effective_config):
                raise ValueError("compiled Agent config does not match its definition preview")
            # The definition compiler already materialized model capabilities. Reapplying
            # model defaults would reclassify inherited values as explicit user overrides
            # and make the published snapshot differ from the validated preview.
            config = deepcopy(compiled_definition.effective_config)
        else:
            config = await self.providers.apply_model_defaults(tenant_id, config)
        self.validate_agent_config(config)
        await self.providers.validate_agent_reference(tenant_id, config)
        config_hash = hashlib.sha256(canonical_json(config).encode("utf-8")).hexdigest()
        async with self.db.sessions() as session, session.begin():
            agent = await session.get(AgentRecord, agent_id)
            if agent is None or agent.tenant_id != tenant_id:
                raise KeyError("agent not found")
            version_number = (
                await session.scalar(
                    select(func.max(AgentVersionRecord.version)).where(
                        AgentVersionRecord.agent_id == agent_id
                    )
                )
                or 0
            ) + 1
            version = AgentVersionRecord(
                tenant_id=tenant_id,
                agent_id=agent_id,
                version=version_number,
                config_json=config,
                config_hash=config_hash,
                definition_format=("agent_markdown_v1" if compiled_definition else "legacy_json"),
                definition_source=(compiled_definition.source if compiled_definition else None),
                definition_json=(
                    compiled_definition.definition.model_dump(
                        mode="json", by_alias=True, exclude_none=True
                    )
                    if compiled_definition
                    else {}
                ),
                overrides_json=(compiled_definition.overrides if compiled_definition else {}),
                global_defaults_revision=(
                    compiled_definition.defaults_revision if compiled_definition else 0
                ),
                platform_policy_revision=(
                    compiled_definition.policy_revision if compiled_definition else 0
                ),
            )
            session.add(version)
            await session.flush()
            for position, binding in enumerate(config.get("bindings", [])):
                session.add(
                    BindingRecord(
                        agent_version_id=version.id,
                        kind=binding["kind"],
                        target_id=binding["target_id"],
                        position=position,
                        config_json=binding.get("config", {}),
                    )
                )
        await self._audit(
            tenant_id=tenant_id,
            actor_id=actor_id,
            action="agent_version.create",
            resource_type="agent_version",
            resource_id=version.id,
            after={"version": version.version, "config_hash": version.config_hash},
        )
        return version

    async def _validate_bindings(self, version_id: str) -> None:
        async with self.db.sessions() as session:
            bindings = (
                await session.scalars(
                    select(BindingRecord).where(BindingRecord.agent_version_id == version_id)
                )
            ).all()
            for binding in bindings:
                model = {
                    "tool": ToolRecord,
                    "mcp": MCPServerRecord,
                    "skill": SkillVersionRecord,
                    "handoff": AgentVersionRecord,
                    "agent_tool": AgentVersionRecord,
                }[binding.kind]
                if await session.get(model, binding.target_id) is None:
                    raise ValueError(
                        f"binding target not found: {binding.kind}/{binding.target_id}"
                    )

    async def publish_agent_version(
        self, tenant_id: str, actor_id: str, version_id: str
    ) -> AgentVersionRecord:
        await self._validate_bindings(version_id)
        await self.agent_factory.validate_graph(version_id)
        async with self.db.sessions() as session, session.begin():
            version = await session.scalar(
                select(AgentVersionRecord)
                .where(
                    AgentVersionRecord.id == version_id,
                    AgentVersionRecord.tenant_id == tenant_id,
                )
                .with_for_update()
            )
            if version is None:
                raise KeyError("agent version not found")
            version.status = "published"
            version.published_at = datetime.now(UTC)
        await self._audit(
            tenant_id=tenant_id,
            actor_id=actor_id,
            action="agent_version.publish",
            resource_type="agent_version",
            resource_id=version.id,
            before={"status": "draft"},
            after={"status": "published"},
        )
        return version

    async def create_tool(self, tenant_id: str, data: ToolCreate) -> ToolRecord:
        Draft202012Validator.check_schema(data.parameters)
        self.agent_factory.tools.resolve(data.implementation_key)
        side_effect = str(data.policy.get("side_effect", "none"))
        if side_effect not in {"none", "reversible", "irreversible", "external"}:
            raise ValueError(
                "tool policy.side_effect must be none, reversible, irreversible, or external"
            )
        if (
            int(data.policy.get("max_attempts", 1)) > 1
            and side_effect != "none"
            and not data.policy.get("idempotent", False)
        ):
            raise ValueError("side-effecting tool retries require policy.idempotent=true")
        record = ToolRecord(
            tenant_id=tenant_id,
            slug=data.slug,
            name=data.name,
            description=data.description,
            kind=data.kind,
            implementation_key=data.implementation_key,
            schema_json=data.parameters,
            policy_json=data.policy,
        )
        async with self.db.sessions() as session, session.begin():
            session.add(record)
        return record

    async def create_mcp(self, tenant_id: str, data: MCPServerCreate) -> MCPServerRecord:
        forbidden = {"authorization", "api_key", "token", "secret"}
        if any(key.lower() in forbidden for key in data.endpoint_config):
            raise ValueError("MCP credentials must use secret_refs")
        record = MCPServerRecord(
            tenant_id=tenant_id,
            slug=data.slug,
            name=data.name,
            transport=data.transport,
            endpoint_config=data.endpoint_config,
            secret_refs=data.secret_refs,
            policy_json=data.policy,
        )
        async with self.db.sessions() as session, session.begin():
            session.add(record)
        return record
