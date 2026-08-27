from __future__ import annotations

import contextlib
import os
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Literal, get_args

from agents import (
    Agent,
    GuardrailFunctionOutput,
    InputGuardrail,
    ModelSettings,
    OpenAIChatCompletionsModel,
    OpenAIResponsesModel,
    OutputGuardrail,
)
from agents.mcp import (
    MCPServer,
    MCPServerManager,
    MCPServerSse,
    MCPServerStdio,
    MCPServerStreamableHttp,
)
from openai import AsyncOpenAI
from pydantic import BaseModel, ConfigDict, create_model
from sqlalchemy import select

from .agent_definitions import AgentDefinitionService
from .config import Settings
from .db import Database
from .deterministic_model import DeterministicModel
from .models import (
    AgentVersionRecord,
    BindingRecord,
    MCPServerRecord,
    ToolRecord,
)
from .providers import ProviderService, litellm_model_name
from .serialization import canonical_json
from .skills import SkillService
from .tools import BUILTIN_TOOL_DEFINITIONS, ToolRegistry


class AgentConfigurationError(ValueError):
    pass


@dataclass
class BuiltAgent:
    agent: Agent
    clients: list[AsyncOpenAI] = field(default_factory=list)
    mcp_manager: MCPServerManager | None = None


def _schema_type(schema: dict[str, Any], name: str) -> Any:
    if "enum" in schema:
        return Literal.__getitem__(tuple(schema["enum"]))
    schema_type = schema.get("type")
    if isinstance(schema_type, list):
        non_null = [item for item in schema_type if item != "null"]
        inner = _schema_type({**schema, "type": non_null[0] if non_null else "string"}, name)
        return inner | None
    if schema_type == "string":
        return str
    if schema_type == "integer":
        return int
    if schema_type == "number":
        return float
    if schema_type == "boolean":
        return bool
    if schema_type == "array":
        return list[_schema_type(schema.get("items", {}), f"{name}Item")]
    if schema_type == "object" or "properties" in schema:
        return schema_to_model(name, schema)
    return Any


def schema_to_model(name: str, schema: dict[str, Any]) -> type[BaseModel]:
    required = set(schema.get("required", []))
    fields: dict[str, tuple[Any, Any]] = {}
    for field_name, field_schema in schema.get("properties", {}).items():
        annotation = _schema_type(field_schema, f"{name}{field_name.title()}")
        if field_name in required:
            fields[field_name] = (annotation, ...)
        else:
            if type(None) not in get_args(annotation):
                annotation = annotation | None
            fields[field_name] = (annotation, None)
    model_config = ConfigDict(
        extra="forbid" if schema.get("additionalProperties") is False else "allow"
    )
    return create_model(name, __config__=model_config, **fields)


class AgentFactory:
    def __init__(
        self,
        db: Database,
        tools: ToolRegistry,
        skills: SkillService,
        providers: ProviderService,
        definitions: AgentDefinitionService,
        settings: Settings,
    ):
        self.db = db
        self.tools = tools
        self.skills = skills
        self.providers = providers
        self.definitions = definitions
        self.settings = settings

    async def validate_graph(self, root_version_id: str, max_depth: int = 12) -> None:
        visited: set[str] = set()
        active: set[str] = set()

        async def visit(version_id: str, depth: int) -> None:
            if depth > max_depth:
                raise AgentConfigurationError("agent graph exceeds maximum depth")
            if version_id in active:
                raise AgentConfigurationError("agent graph contains a cycle")
            if version_id in visited:
                return
            active.add(version_id)
            async with self.db.sessions() as session:
                targets = (
                    await session.scalars(
                        select(BindingRecord.target_id).where(
                            BindingRecord.agent_version_id == version_id,
                            BindingRecord.kind.in_(["handoff", "agent_tool"]),
                        )
                    )
                ).all()
            for target in targets:
                await visit(target, depth + 1)
            active.remove(version_id)
            visited.add(version_id)

        await visit(root_version_id, 0)

    def _build_model(self, config: dict[str, Any], clients: list[AsyncOpenAI]):
        model_name = str(config.get("model", ""))
        if not model_name:
            raise AgentConfigurationError("agent model is required")
        provider = config.get("provider") or {"type": "openai", "protocol": "responses"}
        provider_type = provider.get("type", "openai")
        if provider_type == "deterministic":
            if self.settings.environment != "test":
                raise AgentConfigurationError(
                    "the deterministic provider is restricted to the test environment"
                )
            return DeterministicModel(
                final_text=str(provider.get("response_text", "OK")),
                reasoning_text=provider.get("reasoning_text"),
                tool_name=provider.get("tool_name"),
                tool_arguments=provider.get("tool_arguments") or {},
            )
        api_key_env = provider.get("api_key_env", "OPENAI_API_KEY")
        api_key = provider.get("_api_key") or os.environ.get(api_key_env)
        if not api_key:
            raise AgentConfigurationError(
                f"provider credential environment variable is missing: {api_key_env}"
            )
        if provider_type == "litellm":
            try:
                from agents.extensions.models.litellm_model import LitellmModel
            except ImportError as exc:  # pragma: no cover - packaging failure
                raise AgentConfigurationError(
                    "LiteLLM provider support is unavailable; install the litellm dependency"
                ) from exc
            return LitellmModel(
                model=litellm_model_name(provider, model_name),
                api_key=str(api_key),
            )
        if provider_type not in {"openai", "openai_compatible"}:
            raise AgentConfigurationError(f"unsupported provider type: {provider_type}")
        kwargs: dict[str, Any] = {
            "api_key": api_key,
            "max_retries": int(provider.get("max_retries", 2)),
        }
        if provider.get("base_url"):
            kwargs["base_url"] = provider["base_url"]
        if provider.get("timeout_seconds"):
            kwargs["timeout"] = float(provider["timeout_seconds"])
        client = AsyncOpenAI(**kwargs)
        clients.append(client)
        protocol = provider.get("protocol", "responses")
        if protocol == "chat_completions":
            return OpenAIChatCompletionsModel(model=model_name, openai_client=client)
        if protocol == "responses":
            return OpenAIResponsesModel(model=model_name, openai_client=client)
        raise AgentConfigurationError(f"unsupported provider protocol: {protocol}")

    def _build_guardrails(self, config: dict[str, Any]) -> tuple[list, list]:
        guardrails = config.get("guardrails") or {}
        input_patterns = [
            re.compile(item, re.IGNORECASE) for item in guardrails.get("input_block_patterns", [])
        ]
        output_patterns = [
            re.compile(item, re.IGNORECASE) for item in guardrails.get("output_block_patterns", [])
        ]

        async def input_check(ctx, agent, input_value):
            text = input_value if isinstance(input_value, str) else canonical_json(input_value)
            matched = next(
                (pattern.pattern for pattern in input_patterns if pattern.search(text)), None
            )
            return GuardrailFunctionOutput(
                output_info={"matched_pattern": matched}, tripwire_triggered=matched is not None
            )

        async def output_check(ctx, agent, output_value):
            text = canonical_json(output_value)
            matched = next(
                (pattern.pattern for pattern in output_patterns if pattern.search(text)), None
            )
            return GuardrailFunctionOutput(
                output_info={"matched_pattern": matched}, tripwire_triggered=matched is not None
            )

        inputs = (
            [InputGuardrail(input_check, name="configured-input-policy", run_in_parallel=False)]
            if input_patterns
            else []
        )
        outputs = (
            [OutputGuardrail(output_check, name="configured-output-policy")]
            if output_patterns
            else []
        )
        return inputs, outputs

    def _build_mcp_server(
        self, record: MCPServerRecord, approvals: dict[str, Any] | None = None
    ) -> MCPServer:
        config = dict(record.endpoint_config)
        secret_values = {
            name: os.environ.get(env_name) for name, env_name in record.secret_refs.items()
        }
        missing = [name for name, value in secret_values.items() if value is None]
        if missing:
            raise AgentConfigurationError(f"missing MCP secret references: {', '.join(missing)}")
        headers = dict(config.pop("headers", {}))
        headers.update(secret_values)
        approvals = approvals or {}
        require_approval = (
            record.policy_json.get("approval_mode") == "always"
            or approvals.get("all_tool_calls") == "required"
            or approvals.get("mcp_tools") == "required"
        )
        allowed_tools = record.policy_json.get("allowed_tools")
        blocked_tools = record.policy_json.get("blocked_tools")
        tool_filter = None
        if allowed_tools or blocked_tools:
            tool_filter = {}
            if allowed_tools:
                tool_filter["allowed_tool_names"] = list(allowed_tools)
            if blocked_tools:
                tool_filter["blocked_tool_names"] = list(blocked_tools)
        common = {
            "name": record.name,
            "cache_tools_list": bool(record.policy_json.get("cache_tools", True)),
            "require_approval": "always" if require_approval else None,
            "tool_filter": tool_filter,
            "client_session_timeout_seconds": float(record.policy_json.get("timeout_seconds", 15)),
            "max_retry_attempts": max(int(record.policy_json.get("max_attempts", 1)), 1) - 1,
            "retry_backoff_seconds_base": float(record.policy_json.get("retry_backoff_seconds", 1)),
        }
        if record.transport == "streamable_http":
            config["headers"] = headers
            return MCPServerStreamableHttp(params=config, **common)
        if record.transport == "sse":
            config["headers"] = headers
            return MCPServerSse(params=config, **common)
        if record.transport == "stdio":
            environment = dict(config.get("env", {}))
            environment.update(secret_values)
            config["env"] = environment
            return MCPServerStdio(params=config, **common)
        raise AgentConfigurationError(f"unsupported MCP transport: {record.transport}")

    async def check_mcp(self, record: MCPServerRecord) -> dict[str, Any]:
        server = self._build_mcp_server(record)
        try:
            async with __import__("asyncio").timeout(
                float(record.policy_json.get("health_timeout_seconds", 15))
            ):
                await server.connect()
                tools = await server.list_tools()
            return {
                "status": "healthy",
                "tools": [tool.name for tool in tools],
                "tool_count": len(tools),
            }
        finally:
            with contextlib.suppress(Exception):
                await server.cleanup()

    @contextlib.asynccontextmanager
    async def build(self, version_id: str, runtime_context: dict[str, Any]) -> AsyncIterator[Agent]:
        await self.validate_graph(version_id)
        clients: list[AsyncOpenAI] = []
        mcp_servers: list[MCPServer] = []
        cache: dict[str, Agent] = {}

        async def build_one(current_id: str, depth: int = 0) -> Agent:
            if current_id in cache:
                return cache[current_id]
            async with self.db.sessions() as session:
                version = await session.get(AgentVersionRecord, current_id)
                if version is None or version.status not in {"published", "draft"}:
                    raise AgentConfigurationError(f"agent version is not runnable: {current_id}")
                bindings = (
                    await session.scalars(
                        select(BindingRecord)
                        .where(BindingRecord.agent_version_id == current_id)
                        .order_by(BindingRecord.position)
                    )
                ).all()
            config = await self.definitions.enforce_runtime_config(
                version.tenant_id, dict(version.config_json)
            )
            config = await self.providers.resolve_agent_config(config, version.tenant_id)
            tools = []
            handoffs = []
            local_mcp_servers: list[MCPServer] = []
            runtime_policy = config.get("_runtime_platform_policy") or {}
            denied_tools = set(runtime_policy.get("denied_tools") or [])
            approvals = dict(config.get("approvals") or {})
            skill_ids = [binding.target_id for binding in bindings if binding.kind == "skill"]
            skill_catalog = await self.skills.get_runtime_catalog(skill_ids)
            if current_id == version_id:
                runtime_context["skills"] = [
                    {"id": item["id"], "slug": item["slug"], "content": item["content"]}
                    for item in skill_catalog
                ]
            instructions = str(config.get("instructions", "You are a helpful assistant."))
            structured_output_mode = str(
                (config.get("provider") or {}).get("structured_output_mode", "native")
            )
            if config.get("output_schema") and structured_output_mode == "prompt":
                instructions += (
                    "\n\nReturn only one valid JSON value matching this JSON Schema. "
                    "Do not use Markdown fences or add commentary:\n"
                    + canonical_json(config["output_schema"])
                )
            if skill_catalog:
                catalog_text = "\n".join(
                    f"- {item['slug']}: {item['description']}" for item in skill_catalog
                )
                instructions += (
                    "\n\nAttached skills are available. Read a skill with the read_skill tool only "
                    f"when relevant:\n{catalog_text}"
                )
                definition = BUILTIN_TOOL_DEFINITIONS["builtin.skill_read"]
                tools.append(
                    self.tools.build(
                        **definition,
                        implementation_key="builtin.skill_read",
                        policy={"timeout_seconds": 5},
                    )
                )
            for binding in bindings:
                if binding.kind == "tool":
                    async with self.db.sessions() as session:
                        tool_record = await session.get(ToolRecord, binding.target_id)
                    if tool_record is None or tool_record.status != "active":
                        raise AgentConfigurationError(f"tool unavailable: {binding.target_id}")
                    if tool_record.id in denied_tools or tool_record.slug in denied_tools:
                        continue
                    policy = {**tool_record.policy_json, **binding.config_json}
                    side_effect = str(policy.get("side_effect", "none"))
                    if approvals.get("all_tool_calls") == "required":
                        policy["approval_mode"] = "always"
                    elif (
                        side_effect == "external"
                        and approvals.get("external_side_effects") == "required"
                    ) or (
                        side_effect == "irreversible"
                        and approvals.get("destructive_operations") == "required"
                    ):
                        policy["approval_mode"] = "always"
                    tools.append(
                        self.tools.build(
                            name=tool_record.name,
                            description=tool_record.description,
                            implementation_key=tool_record.implementation_key,
                            schema=tool_record.schema_json,
                            policy=policy,
                        )
                    )
                elif binding.kind in {"handoff", "agent_tool"}:
                    child = await build_one(binding.target_id, depth + 1)
                    if binding.kind == "handoff":
                        handoffs.append(child)
                    else:
                        tools.append(
                            child.as_tool(
                                tool_name=binding.config_json.get("tool_name", child.name),
                                tool_description=binding.config_json.get(
                                    "description", f"Delegate work to {child.name}."
                                ),
                            )
                        )
                elif binding.kind == "mcp":
                    async with self.db.sessions() as session:
                        mcp_record = await session.get(MCPServerRecord, binding.target_id)
                    if mcp_record is None or mcp_record.status != "active":
                        raise AgentConfigurationError(
                            f"MCP server unavailable: {binding.target_id}"
                        )
                    server = self._build_mcp_server(mcp_record, approvals)
                    mcp_servers.append(server)
                    local_mcp_servers.append(server)

            input_guardrails, output_guardrails = self._build_guardrails(config)
            output_type = None
            if config.get("output_schema") and structured_output_mode == "native":
                output_type = schema_to_model(
                    f"AgentOutput{version.id.replace('-', '')}", config["output_schema"]
                )
            elif structured_output_mode not in {"native", "prompt"}:
                raise AgentConfigurationError(
                    "provider.structured_output_mode must be native or prompt"
                )
            model = self._build_model(config, clients)
            settings_values = dict(config.get("model_settings") or {})
            settings_values.setdefault(
                "timeout", float((config.get("provider") or {}).get("timeout_seconds", 180))
            )
            settings_values.setdefault("preserve_raw_usage", True)
            agent = Agent(
                name=str(config.get("name", f"agent-{version.version}")),
                handoff_description=config.get("handoff_description"),
                instructions=instructions,
                model=model,
                model_settings=ModelSettings(**settings_values),
                tools=tools,
                mcp_servers=local_mcp_servers,
                handoffs=handoffs,
                input_guardrails=input_guardrails,
                output_guardrails=output_guardrails,
                output_type=output_type,
            )
            cache[current_id] = agent
            return agent

        manager: MCPServerManager | None = None
        try:
            agent = await build_one(version_id)
            if mcp_servers:
                manager = MCPServerManager(
                    mcp_servers,
                    strict=True,
                    connect_in_parallel=True,
                    connect_timeout_seconds=15,
                )
                await manager.__aenter__()
            yield agent
        finally:
            if manager is not None:
                await manager.__aexit__(None, None, None)
            for client in clients:
                await client.close()
