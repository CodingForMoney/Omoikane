from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from agents import FunctionTool
from agents.tool_context import ToolContext
from jsonschema import Draft202012Validator

from .artifacts import ArtifactService
from .memory import MemoryService
from .sandbox import SandboxHandle, SandboxProvider
from .tool_executions import ToolExecutionService


@dataclass(slots=True)
class ToolInvocation:
    tenant_id: str
    run_id: str
    tool_call_id: str
    context: dict[str, Any]
    idempotency_key: str | None = None


ToolHandler = Callable[[dict[str, Any], ToolInvocation], Awaitable[Any]]


class ToolRegistry:
    def __init__(
        self,
        artifacts: ArtifactService,
        memory: MemoryService,
        sandbox: SandboxProvider,
        executions: ToolExecutionService,
    ):
        self.artifacts = artifacts
        self.memory = memory
        self.sandbox = sandbox
        self.executions = executions
        self._handlers: dict[str, ToolHandler] = {}
        self._semaphores: dict[str, asyncio.Semaphore] = {}
        self.register("builtin.echo", self._echo)
        self.register("builtin.add", self._add)
        self.register("builtin.artifact_write", self._artifact_write)
        self.register("builtin.sandbox_exec", self._sandbox_exec)
        self.register("builtin.skill_read", self._skill_read)
        self.register("builtin.memory_remember", self._memory_remember)

    def register(self, implementation_key: str, handler: ToolHandler) -> None:
        if implementation_key in self._handlers:
            raise ValueError(f"tool implementation already registered: {implementation_key}")
        self._handlers[implementation_key] = handler

    def resolve(self, implementation_key: str) -> ToolHandler:
        try:
            return self._handlers[implementation_key]
        except KeyError as exc:
            raise KeyError(f"tool implementation is not deployed: {implementation_key}") from exc

    def build(
        self,
        *,
        name: str,
        description: str,
        implementation_key: str,
        schema: dict[str, Any],
        policy: dict[str, Any],
    ) -> FunctionTool:
        validator = Draft202012Validator(schema)
        handler = self.resolve(implementation_key)
        max_concurrency = max(int(policy.get("max_concurrency", 32)), 1)
        semaphore_key = str(policy.get("concurrency_key", implementation_key))
        semaphore = self._semaphores.setdefault(semaphore_key, asyncio.Semaphore(max_concurrency))

        async def invoke(tool_context: ToolContext[Any], arguments_json: str) -> Any:
            if len(arguments_json.encode("utf-8")) > int(policy.get("max_input_bytes", 256_000)):
                raise ValueError(f"tool input exceeds configured limit: {name}")
            try:
                arguments = json.loads(arguments_json or "{}")
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid JSON arguments for {name}: {exc}") from exc
            validator.validate(arguments)
            context = tool_context.context if isinstance(tool_context.context, dict) else {}
            invocation = ToolInvocation(
                tenant_id=str(context.get("tenant_id", "default")),
                run_id=str(context.get("run_id", "")),
                tool_call_id=str(tool_context.tool_call_id),
                context=context,
            )
            attempts = max(int(policy.get("max_attempts", 1)), 1)
            side_effect = str(policy.get("side_effect", "none"))
            if attempts > 1 and side_effect != "none" and not policy.get("idempotent", False):
                raise ValueError(f"tool retries require an idempotent implementation: {name}")
            durable_idempotency = side_effect != "none" or bool(
                policy.get("durable_idempotency", False)
            )
            execution_id: str | None = None
            if durable_idempotency:
                timeout_seconds = float(policy.get("timeout_seconds", 30))
                backoff_seconds = float(policy.get("retry_backoff_seconds", 0.25))
                lease_seconds = float(
                    policy.get(
                        "idempotency_lease_seconds",
                        max(
                            60.0,
                            timeout_seconds * attempts
                            + backoff_seconds * max((2 ** (attempts - 1)) - 1, 0)
                            + 15.0,
                        ),
                    )
                )
                claim = await self.executions.claim(
                    tenant_id=invocation.tenant_id,
                    run_id=invocation.run_id,
                    tool_call_id=invocation.tool_call_id,
                    tool_name=name,
                    implementation_key=implementation_key,
                    arguments=arguments,
                    lease_seconds=lease_seconds,
                    retry_failed=bool(policy.get("retry_failed_execution", False)),
                )
                invocation.idempotency_key = claim.record.idempotency_key
                if claim.cached:
                    return claim.record.output_json
                execution_id = claim.record.id
            delay = float(policy.get("retry_backoff_seconds", 0.25))
            try:
                async with semaphore:
                    for attempt in range(1, attempts + 1):
                        try:
                            output = await handler(arguments, invocation)
                            break
                        except Exception:
                            if attempt >= attempts:
                                raise
                            await asyncio.sleep(delay * (2 ** (attempt - 1)))
                    else:
                        raise RuntimeError("unreachable tool retry state")
                    encoded = json.dumps(
                        output, ensure_ascii=False, default=str, separators=(",", ":")
                    ).encode("utf-8")
                    if len(encoded) > int(policy.get("max_output_bytes", 1_000_000)):
                        raise ValueError(f"tool output exceeds configured limit: {name}")
                if execution_id is not None:
                    await self.executions.complete(execution_id, output)
                return output
            except Exception as exc:
                if execution_id is not None:
                    await self.executions.fail(execution_id, exc)
                raise

        approval_mode = policy.get("approval_mode", "never")
        needs_approval = approval_mode == "always" or (
            approval_mode == "policy" and policy.get("side_effect") in {"irreversible", "external"}
        )
        return FunctionTool(
            name=name,
            description=description,
            params_json_schema=schema,
            on_invoke_tool=invoke,
            strict_json_schema=bool(policy.get("strict_json_schema", True)),
            needs_approval=needs_approval,
            timeout_seconds=float(policy.get("timeout_seconds", 30)),
            timeout_behavior=policy.get("timeout_behavior", "raise_exception"),
        )

    async def _echo(self, arguments: dict, invocation: ToolInvocation) -> dict:
        return {"echo": arguments.get("text")}

    async def _add(self, arguments: dict, invocation: ToolInvocation) -> dict:
        return {"result": float(arguments["a"]) + float(arguments["b"])}

    async def _artifact_write(self, arguments: dict, invocation: ToolInvocation) -> dict:
        data = str(arguments["content"]).encode("utf-8")
        record = await self.artifacts.create(
            tenant_id=invocation.tenant_id,
            run_id=invocation.run_id,
            filename=str(arguments.get("filename", "artifact.txt")),
            data=data,
            mime_type=arguments.get("mime_type", "text/plain; charset=utf-8"),
            source="tool",
            lineage={
                "tool_call_id": invocation.tool_call_id,
                "idempotency_key": invocation.idempotency_key,
            },
        )
        return {"artifact_id": record.id, "sha256": record.sha256, "size": record.size}

    async def _sandbox_exec(self, arguments: dict, invocation: ToolInvocation) -> dict:
        raw = invocation.context.get("sandbox")
        if not isinstance(raw, dict):
            raise RuntimeError("this run has no sandbox")
        handle = SandboxHandle(id=raw["id"], root=Path(raw["root"]), provider=raw["provider"])
        result = await self.sandbox.exec(
            handle,
            [str(item) for item in arguments["command"]],
            cwd=str(arguments.get("cwd", ".")),
            timeout=int(arguments.get("timeout_seconds", 60)),
        )
        return {
            "return_code": result.return_code,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "timed_out": result.timed_out,
        }

    async def _skill_read(self, arguments: dict, invocation: ToolInvocation) -> dict:
        slug = str(arguments["slug"])
        skills = invocation.context.get("skills", [])
        for skill in skills:
            if skill.get("slug") == slug:
                return {"slug": slug, "content": skill.get("content", "")}
        raise KeyError(f"skill is not attached to this agent: {slug}")

    async def _memory_remember(self, arguments: dict, invocation: ToolInvocation) -> dict:
        memory = await self.memory.create(
            tenant_id=invocation.tenant_id,
            scope_type=str(arguments["scope_type"]),
            scope_id=str(arguments["scope_id"]),
            kind=str(arguments.get("kind", "semantic")),
            content=str(arguments["content"]),
            confidence=float(arguments.get("confidence", 0.8)),
            source={"tool_call_id": invocation.tool_call_id},
            run_id=invocation.run_id,
        )
        return {"memory_id": memory.id, "content_hash": memory.content_hash}


BUILTIN_TOOL_DEFINITIONS: dict[str, dict[str, Any]] = {
    "builtin.echo": {
        "name": "echo",
        "description": "Echo a string for connectivity and tool-call testing.",
        "schema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
            "additionalProperties": False,
        },
    },
    "builtin.add": {
        "name": "add",
        "description": "Add two numbers.",
        "schema": {
            "type": "object",
            "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
            "required": ["a", "b"],
            "additionalProperties": False,
        },
    },
    "builtin.artifact_write": {
        "name": "write_artifact",
        "description": "Write text as a managed artifact and return its identifier.",
        "schema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string"},
                "content": {"type": "string"},
                "mime_type": {"type": "string"},
            },
            "required": ["filename", "content"],
            "additionalProperties": False,
        },
    },
    "builtin.sandbox_exec": {
        "name": "sandbox_exec",
        "description": "Execute an argv command inside the run sandbox.",
        "schema": {
            "type": "object",
            "properties": {
                "command": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                "cwd": {"type": "string"},
                "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 600},
            },
            "required": ["command"],
            "additionalProperties": False,
        },
    },
    "builtin.skill_read": {
        "name": "read_skill",
        "description": "Read the full SKILL.md instructions for an attached skill when needed.",
        "schema": {
            "type": "object",
            "properties": {"slug": {"type": "string"}},
            "required": ["slug"],
            "additionalProperties": False,
        },
    },
    "builtin.memory_remember": {
        "name": "remember_experience",
        "description": "Store a durable, non-secret workflow fact or reusable experience.",
        "schema": {
            "type": "object",
            "properties": {
                "scope_type": {"type": "string", "enum": ["user", "agent", "project", "global"]},
                "scope_id": {"type": "string"},
                "kind": {"type": "string", "enum": ["semantic", "episodic", "procedural"]},
                "content": {"type": "string"},
                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            },
            "required": ["scope_type", "scope_id", "content"],
            "additionalProperties": False,
        },
    },
}
