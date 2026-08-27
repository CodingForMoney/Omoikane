from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class AgentCreate(BaseModel):
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{1,127}$")
    name: str = Field(min_length=1, max_length=256)
    description: str | None = None


class AgentVersionCreate(BaseModel):
    config: dict[str, Any]


class ProviderConnectionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    provider: str = Field(min_length=1, max_length=128)
    endpoint_profile: str | None = None
    api_key: str | None = Field(default=None, min_length=1)
    api_key_env: str | None = Field(default=None, pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    custom_base_url: str | None = None
    custom_protocol: Literal["responses", "chat_completions"] | None = None
    settings: dict[str, Any] = Field(default_factory=dict)


class ProviderConnectionPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=256)
    endpoint_profile: str | None = None
    api_key: str | None = Field(default=None, min_length=1)
    api_key_env: str | None = Field(default=None, pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    custom_base_url: str | None = None
    custom_protocol: Literal["responses", "chat_completions"] | None = None
    status: Literal["configured", "active", "disabled"] | None = None
    default_model: str | None = Field(default=None, min_length=1, max_length=256)
    settings: dict[str, Any] | None = None


class ProviderModelCreate(BaseModel):
    model_id: str = Field(min_length=1, max_length=256)
    display_name: str | None = Field(default=None, max_length=256)
    capabilities: dict[str, Any] = Field(default_factory=dict)


class RunCreate(BaseModel):
    agent_version_id: str
    input: str | list[dict[str, Any]]
    session_id: str | None = None
    context: dict[str, Any] = Field(default_factory=dict)
    limits: dict[str, Any] = Field(default_factory=dict)
    parent_run_id: str | None = None


class SessionCreate(BaseModel):
    scope: dict[str, Any] = Field(default_factory=dict)


class CompactionRequest(BaseModel):
    agent_version_id: str | None = None
    strategy: Literal["auto", "native", "portable"] = "auto"
    focus: str | None = Field(default=None, max_length=4000)
    dry_run: bool = False
    force: bool = True


class ToolCreate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    slug: str
    name: str
    description: str
    implementation_key: str
    parameters: dict[str, Any] = Field(alias="schema")
    policy: dict[str, Any] = Field(default_factory=dict)
    kind: Literal["function", "agent"] = "function"


class MCPServerCreate(BaseModel):
    slug: str
    name: str
    transport: Literal["streamable_http", "sse", "stdio"]
    endpoint_config: dict[str, Any]
    secret_refs: dict[str, str] = Field(default_factory=dict)
    policy: dict[str, Any] = Field(default_factory=dict)


class SkillImportRequest(BaseModel):
    path: str


class MemoryCreate(BaseModel):
    scope_type: Literal["user", "agent", "project", "global"]
    scope_id: str
    kind: Literal["semantic", "episodic", "procedural"] = "semantic"
    content: str = Field(min_length=1, max_length=50_000)
    confidence: float = Field(default=0.8, ge=0, le=1)


class MemoryPatch(BaseModel):
    content: str | None = Field(default=None, min_length=1, max_length=50_000)
    confidence: float | None = Field(default=None, ge=0, le=1)
    enabled: bool | None = None


class ApprovalDecision(BaseModel):
    reason: str | None = Field(default=None, max_length=4000)


class ToolExecutionResolution(BaseModel):
    status: Literal["completed", "failed"]
    reason: str = Field(min_length=1, max_length=4000)
    output: Any = None
    error: dict[str, Any] | None = None


class PriceCreate(BaseModel):
    provider: str
    model: str
    version: str
    input_per_million: float = Field(ge=0)
    output_per_million: float = Field(ge=0)
    currency: str = "USD"
    effective_from: datetime
    effective_to: datetime | None = None


class ErrorDetail(BaseModel):
    code: str
    message: str
    request_id: str
    details: dict[str, Any] = Field(default_factory=dict)


class ErrorResponse(BaseModel):
    error: ErrorDetail
