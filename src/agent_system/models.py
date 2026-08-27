from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime

from pgvector.sqlalchemy import VECTOR
from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base
from .runtime_versions import OPENAI_AGENTS_SDK_VERSION


def new_id() -> str:
    timestamp_ms = int(datetime.now(UTC).timestamp() * 1000) & ((1 << 48) - 1)
    random_a = secrets.randbits(12)
    random_b = secrets.randbits(62)
    value = (timestamp_ms << 80) | (0x7 << 76) | (random_a << 64) | (0b10 << 62) | random_b
    return str(uuid.UUID(int=value))


def now_utc() -> datetime:
    return datetime.now(UTC)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc, onupdate=now_utc
    )


class TenantMixin:
    tenant_id: Mapped[str] = mapped_column(String(64), default="default", index=True)


class AgentRecord(Base, TimestampMixin, TenantMixin):
    __tablename__ = "agents"
    __table_args__ = (UniqueConstraint("tenant_id", "slug", name="uq_agent_tenant_slug"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    slug: Mapped[str] = mapped_column(String(128))
    name: Mapped[str] = mapped_column(String(256))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="active")


class AgentVersionRecord(Base, TimestampMixin, TenantMixin):
    __tablename__ = "agent_versions"
    __table_args__ = (
        UniqueConstraint("agent_id", "version", name="uq_agent_version"),
        Index("ix_agent_versions_status", "agent_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"))
    version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(32), default="draft")
    config_json: Mapped[dict] = mapped_column(JSON)
    config_hash: Mapped[str] = mapped_column(String(64))
    definition_format: Mapped[str] = mapped_column(String(32), default="legacy_json")
    definition_source: Mapped[str | None] = mapped_column(Text, nullable=True)
    definition_json: Mapped[dict] = mapped_column(JSON, default=dict)
    overrides_json: Mapped[dict] = mapped_column(JSON, default=dict)
    global_defaults_revision: Mapped[int] = mapped_column(Integer, default=0)
    platform_policy_revision: Mapped[int] = mapped_column(Integer, default=0)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AgentSettingsRecord(Base, TimestampMixin, TenantMixin):
    __tablename__ = "agent_settings"
    __table_args__ = (UniqueConstraint("tenant_id", name="uq_agent_settings_tenant"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    defaults_revision: Mapped[int] = mapped_column(Integer, default=1)
    policy_revision: Mapped[int] = mapped_column(Integer, default=1)
    global_instructions: Mapped[str] = mapped_column(Text, default="")
    defaults_json: Mapped[dict] = mapped_column(JSON, default=dict)
    policy_json: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_by: Mapped[str] = mapped_column(String(128), default="system")


class ProviderConnectionRecord(Base, TimestampMixin, TenantMixin):
    __tablename__ = "provider_connections"
    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uq_provider_connection_tenant_name"),
        Index("ix_provider_connections_provider", "tenant_id", "provider"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(256))
    provider: Mapped[str] = mapped_column(String(128))
    endpoint_profile: Mapped[str] = mapped_column(String(128), default="default")
    base_url: Mapped[str] = mapped_column(Text)
    protocol: Mapped[str] = mapped_column(String(32))
    api_key_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    api_key_checksum: Mapped[str | None] = mapped_column(String(64), nullable=True)
    api_key_env: Mapped[str | None] = mapped_column(String(256), nullable=True)
    key_hint: Mapped[str | None] = mapped_column(String(32), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="configured")
    last_validated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    settings_json: Mapped[dict] = mapped_column(JSON, default=dict)


class ProviderModelRecord(Base, TimestampMixin, TenantMixin):
    __tablename__ = "provider_models"
    __table_args__ = (
        UniqueConstraint("connection_id", "model_id", name="uq_provider_model_connection"),
        Index("ix_provider_models_status", "tenant_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    connection_id: Mapped[str] = mapped_column(
        ForeignKey("provider_connections.id", ondelete="CASCADE"), index=True
    )
    model_id: Mapped[str] = mapped_column(String(256))
    display_name: Mapped[str] = mapped_column(String(256))
    source: Mapped[str] = mapped_column(String(32), default="builtin")
    status: Mapped[str] = mapped_column(String(32), default="active")
    capabilities_json: Mapped[dict] = mapped_column(JSON, default=dict)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class BindingRecord(Base, TimestampMixin):
    __tablename__ = "agent_bindings"
    __table_args__ = (
        UniqueConstraint("agent_version_id", "kind", "target_id", name="uq_agent_binding_target"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    agent_version_id: Mapped[str] = mapped_column(
        ForeignKey("agent_versions.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(32))
    target_id: Mapped[str] = mapped_column(String(36))
    position: Mapped[int] = mapped_column(Integer, default=0)
    config_json: Mapped[dict] = mapped_column(JSON, default=dict)


class SessionRecord(Base, TimestampMixin, TenantMixin):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    status: Mapped[str] = mapped_column(String(32), default="active")
    scope: Mapped[dict] = mapped_column(JSON, default=dict)
    last_item_seq: Mapped[int] = mapped_column(Integer, default=0)
    revision: Mapped[int] = mapped_column(Integer, default=0)
    active_projection_revision: Mapped[int] = mapped_column(Integer, default=0)


class SessionItemRecord(Base):
    __tablename__ = "session_items"
    __table_args__ = (
        UniqueConstraint("session_id", "seq", name="uq_session_item_seq"),
        Index("ix_session_items_active", "session_id", "active", "seq"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"))
    seq: Mapped[int] = mapped_column(Integer)
    item_json: Mapped[dict] = mapped_column(JSON)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class RunRecord(Base, TimestampMixin, TenantMixin):
    __tablename__ = "runs"
    __table_args__ = (
        Index("ix_runs_queue", "status", "lease_expires_at", "created_at"),
        UniqueConstraint("tenant_id", "idempotency_key", name="uq_run_idempotency"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    agent_version_id: Mapped[str] = mapped_column(ForeignKey("agent_versions.id"))
    session_id: Mapped[str | None] = mapped_column(
        ForeignKey("sessions.id"), nullable=True, index=True
    )
    parent_run_id: Mapped[str | None] = mapped_column(
        ForeignKey("runs.id"), nullable=True, index=True
    )
    status: Mapped[str] = mapped_column(String(32), default="queued")
    input_json: Mapped[dict | list | str] = mapped_column(JSON)
    output_json: Mapped[dict | list | str | None] = mapped_column(JSON, nullable=True)
    error_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    limits_json: Mapped[dict] = mapped_column(JSON, default=dict)
    context_json: Mapped[dict] = mapped_column(JSON, default=dict)
    idempotency_key: Mapped[str | None] = mapped_column(String(128), nullable=True)
    sdk_version: Mapped[str] = mapped_column(
        String(32), default=OPENAI_AGENTS_SDK_VERSION
    )
    config_hash: Mapped[str] = mapped_column(String(64))
    trace_id: Mapped[str] = mapped_column(String(64), default=new_id)
    version: Mapped[int] = mapped_column(Integer, default=0)
    lease_owner: Mapped[str | None] = mapped_column(String(128), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)


class RunEventRecord(Base):
    __tablename__ = "run_events"
    __table_args__ = (
        UniqueConstraint("run_id", "seq", name="uq_run_event_seq"),
        Index("ix_run_events_lookup", "run_id", "seq"),
        Index("ix_run_events_outbox", "published_at", "next_publish_at", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"))
    seq: Mapped[int] = mapped_column(Integer)
    type: Mapped[str] = mapped_column(String(64))
    payload_json: Mapped[dict] = mapped_column(JSON, default=dict)
    trace_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    publish_attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_publish_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    next_publish_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    publish_lease_owner: Mapped[str | None] = mapped_column(String(128), nullable=True)
    publish_lease_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class RunStateRecord(Base, TimestampMixin):
    __tablename__ = "run_states"

    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), primary_key=True)
    format_version: Mapped[int] = mapped_column(Integer, default=1)
    sdk_version: Mapped[str] = mapped_column(String(32))
    encrypted_state: Mapped[bytes] = mapped_column(LargeBinary)
    checksum: Mapped[str] = mapped_column(String(64))


class ApprovalRecord(Base, TimestampMixin, TenantMixin):
    __tablename__ = "approvals"
    __table_args__ = (
        UniqueConstraint("run_id", "interruption_id", name="uq_approval_interruption"),
        Index("ix_approvals_status", "status", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"))
    interruption_id: Mapped[str] = mapped_column(String(256))
    tool_name: Mapped[str] = mapped_column(String(256))
    request_json: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(32), default="pending")
    decided_by: Mapped[str | None] = mapped_column(String(128), nullable=True)
    decision_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ToolRecord(Base, TimestampMixin, TenantMixin):
    __tablename__ = "tools"
    __table_args__ = (UniqueConstraint("tenant_id", "slug", name="uq_tool_tenant_slug"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    slug: Mapped[str] = mapped_column(String(128))
    name: Mapped[str] = mapped_column(String(128))
    description: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(32), default="function")
    implementation_key: Mapped[str] = mapped_column(String(256))
    schema_json: Mapped[dict] = mapped_column(JSON, default=dict)
    policy_json: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(32), default="active")


class ToolExecutionRecord(Base, TimestampMixin, TenantMixin):
    __tablename__ = "tool_executions"
    __table_args__ = (
        UniqueConstraint("tenant_id", "idempotency_key", name="uq_tool_execution_idempotency"),
        Index("ix_tool_executions_run", "run_id", "status", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"))
    tool_call_id: Mapped[str] = mapped_column(String(256))
    tool_name: Mapped[str] = mapped_column(String(256))
    implementation_key: Mapped[str] = mapped_column(String(256))
    idempotency_key: Mapped[str] = mapped_column(String(64))
    arguments_hash: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(32), default="running")
    attempt_count: Mapped[int] = mapped_column(Integer, default=1)
    output_json: Mapped[dict | list | str | int | float | bool | None] = mapped_column(
        JSON, nullable=True
    )
    error_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_by: Mapped[str | None] = mapped_column(String(128), nullable=True)
    resolution_reason: Mapped[str | None] = mapped_column(Text, nullable=True)


class MCPServerRecord(Base, TimestampMixin, TenantMixin):
    __tablename__ = "mcp_servers"
    __table_args__ = (UniqueConstraint("tenant_id", "slug", name="uq_mcp_tenant_slug"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    slug: Mapped[str] = mapped_column(String(128))
    name: Mapped[str] = mapped_column(String(256))
    transport: Mapped[str] = mapped_column(String(32))
    endpoint_config: Mapped[dict] = mapped_column(JSON)
    secret_refs: Mapped[dict] = mapped_column(JSON, default=dict)
    policy_json: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(32), default="active")


class SkillRecord(Base, TimestampMixin, TenantMixin):
    __tablename__ = "skills"
    __table_args__ = (UniqueConstraint("tenant_id", "slug", name="uq_skill_tenant_slug"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    slug: Mapped[str] = mapped_column(String(128))
    name: Mapped[str] = mapped_column(String(256))
    description: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="active")


class SkillVersionRecord(Base, TimestampMixin):
    __tablename__ = "skill_versions"
    __table_args__ = (UniqueConstraint("skill_id", "version", name="uq_skill_version"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    skill_id: Mapped[str] = mapped_column(ForeignKey("skills.id", ondelete="CASCADE"))
    version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(32), default="published")
    content_hash: Mapped[str] = mapped_column(String(64))
    manifest_json: Mapped[dict] = mapped_column(JSON)
    bundle_uri: Mapped[str] = mapped_column(Text)


class MemoryRecord(Base, TimestampMixin, TenantMixin):
    __tablename__ = "memories"
    __table_args__ = (Index("ix_memories_scope", "tenant_id", "scope_type", "scope_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    scope_type: Mapped[str] = mapped_column(String(32))
    scope_id: Mapped[str] = mapped_column(String(128))
    kind: Mapped[str] = mapped_column(String(32), default="episodic")
    content: Mapped[str] = mapped_column(Text)
    content_hash: Mapped[str] = mapped_column(String(64))
    embedding_json: Mapped[list] = mapped_column(JSON, default=list)
    embedding_vector: Mapped[list[float] | None] = mapped_column(VECTOR(128), nullable=True)
    confidence: Mapped[float] = mapped_column(Float, default=0.5)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    valid_from: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    valid_to: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    superseded_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class MemoryCandidateRecord(Base, TimestampMixin, TenantMixin):
    __tablename__ = "memory_candidates"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"))
    scope_type: Mapped[str] = mapped_column(String(32))
    scope_id: Mapped[str] = mapped_column(String(128))
    kind: Mapped[str] = mapped_column(String(32), default="episodic")
    content: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="pending")
    scores_json: Mapped[dict] = mapped_column(JSON, default=dict)


class MemorySourceRecord(Base, TimestampMixin):
    __tablename__ = "memory_sources"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    memory_id: Mapped[str] = mapped_column(ForeignKey("memories.id", ondelete="CASCADE"))
    run_id: Mapped[str | None] = mapped_column(ForeignKey("runs.id"), nullable=True)
    source_json: Mapped[dict] = mapped_column(JSON, default=dict)


class CompactionRecord(Base, TimestampMixin, TenantMixin):
    __tablename__ = "compactions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"))
    run_id: Mapped[str | None] = mapped_column(ForeignKey("runs.id"), nullable=True)
    before_seq: Mapped[int] = mapped_column(Integer)
    summary_item_id: Mapped[str] = mapped_column(String(36))
    summary_text: Mapped[str] = mapped_column(Text)
    metrics_json: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(32), default="pending", index=True)
    strategy: Mapped[str] = mapped_column(String(64), default="portable")
    trigger: Mapped[str] = mapped_column(String(64), default="manual")
    parent_compaction_id: Mapped[str | None] = mapped_column(
        ForeignKey("compactions.id"), nullable=True
    )
    source_from_seq: Mapped[int] = mapped_column(Integer, default=1)
    source_to_seq: Mapped[int] = mapped_column(Integer, default=0)
    source_revision: Mapped[int] = mapped_column(Integer, default=0)
    provider: Mapped[str] = mapped_column(String(128), default="")
    model: Mapped[str] = mapped_column(String(256), default="")
    schema_version: Mapped[int] = mapped_column(Integer, default=1)
    summary_json: Mapped[dict] = mapped_column(JSON, default=dict)
    native_items_json: Mapped[list] = mapped_column(JSON, default=list)
    validation_json: Mapped[dict] = mapped_column(JSON, default=dict)
    tokens_before: Mapped[int] = mapped_column(Integer, default=0)
    tokens_after: Mapped[int] = mapped_column(Integer, default=0)
    compression_ratio: Mapped[float] = mapped_column(Float, default=0.0)
    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempt_id: Mapped[str] = mapped_column(String(36), default=new_id, index=True)
    lease_holder: Mapped[str | None] = mapped_column(String(128), nullable=True)
    engine_name: Mapped[str] = mapped_column(String(64), default="portable")
    engine_version: Mapped[str] = mapped_column(String(32), default="1")
    summary_generation: Mapped[int] = mapped_column(Integer, default=1)
    summary_model_context_window: Mapped[int] = mapped_column(Integer, default=0)
    summary_input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    summary_output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    source_chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    all_chunks_covered: Mapped[bool] = mapped_column(Boolean, default=False)


class ContextProjectionRecord(Base, TimestampMixin, TenantMixin):
    __tablename__ = "context_projections"
    __table_args__ = (
        UniqueConstraint("session_id", "revision", name="uq_context_projection_revision"),
        Index("ix_context_projection_active", "session_id", "status", "revision"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"))
    compaction_id: Mapped[str] = mapped_column(
        ForeignKey("compactions.id", ondelete="CASCADE"), unique=True
    )
    revision: Mapped[int] = mapped_column(Integer)
    source_from_seq: Mapped[int] = mapped_column(Integer)
    source_to_seq: Mapped[int] = mapped_column(Integer)
    source_revision: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(32), default="active")
    strategy: Mapped[str] = mapped_column(String(64))
    tokens: Mapped[int] = mapped_column(Integer, default=0)
    checksum: Mapped[str] = mapped_column(String(64))


class ContextProjectionSegmentRecord(Base, TimestampMixin):
    __tablename__ = "context_projection_segments"
    __table_args__ = (
        UniqueConstraint("projection_id", "position", name="uq_projection_segment_position"),
        Index("ix_projection_segments_order", "projection_id", "position"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    projection_id: Mapped[str] = mapped_column(
        ForeignKey("context_projections.id", ondelete="CASCADE")
    )
    position: Mapped[int] = mapped_column(Integer)
    segment_type: Mapped[str] = mapped_column(String(64))
    source_from_seq: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source_to_seq: Mapped[int | None] = mapped_column(Integer, nullable=True)
    item_json: Mapped[dict] = mapped_column(JSON)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)


class CompactionLeaseRecord(Base, TimestampMixin):
    __tablename__ = "compaction_leases"

    session_id: Mapped[str] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), primary_key=True
    )
    holder: Mapped[str] = mapped_column(String(128))
    attempt_id: Mapped[str] = mapped_column(String(36))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class CompactionStateRecord(Base, TimestampMixin):
    __tablename__ = "compaction_state"

    session_id: Mapped[str] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), primary_key=True
    )
    state: Mapped[str] = mapped_column(String(32), default="normal")
    last_real_input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    high_watermark_tokens: Mapped[int] = mapped_column(Integer, default=0)
    low_watermark_tokens: Mapped[int] = mapped_column(Integer, default=0)
    ineffective_count: Mapped[int] = mapped_column(Integer, default=0)
    cooldown_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)


class CompactionSourceChunkRecord(Base, TimestampMixin):
    __tablename__ = "compaction_source_chunks"
    __table_args__ = (
        UniqueConstraint("compaction_id", "position", name="uq_compaction_chunk_position"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    compaction_id: Mapped[str] = mapped_column(
        ForeignKey("compactions.id", ondelete="CASCADE"), index=True
    )
    position: Mapped[int] = mapped_column(Integer)
    source_from_seq: Mapped[int] = mapped_column(Integer)
    source_to_seq: Mapped[int] = mapped_column(Integer)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(32), default="pending")
    summary_json: Mapped[dict] = mapped_column(JSON, default=dict)
    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)


class ProviderCapabilityRecord(Base, TimestampMixin):
    __tablename__ = "provider_capabilities"
    __table_args__ = (
        UniqueConstraint("provider", "base_url", "model", name="uq_provider_compaction_capability"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    provider: Mapped[str] = mapped_column(String(128))
    base_url: Mapped[str] = mapped_column(Text, default="")
    model: Mapped[str] = mapped_column(String(256))
    responses_compact: Mapped[bool] = mapped_column(Boolean, default=False)
    server_context_management: Mapped[bool] = mapped_column(Boolean, default=False)
    compaction_item_replay: Mapped[bool] = mapped_column(Boolean, default=False)
    checked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    details_json: Mapped[dict] = mapped_column(JSON, default=dict)


class ArtifactRecord(Base, TimestampMixin, TenantMixin):
    __tablename__ = "artifacts"
    __table_args__ = (Index("ix_artifacts_run", "run_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str | None] = mapped_column(ForeignKey("runs.id"), nullable=True)
    source: Mapped[str] = mapped_column(String(32), default="upload")
    filename: Mapped[str] = mapped_column(String(512))
    storage_key: Mapped[str] = mapped_column(Text)
    sha256: Mapped[str] = mapped_column(String(64))
    mime_type: Mapped[str] = mapped_column(String(256))
    size: Mapped[int] = mapped_column(Integer)
    lineage_json: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(32), default="active")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class UsageRecord(Base, TimestampMixin, TenantMixin):
    __tablename__ = "usage_records"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"))
    model: Mapped[str] = mapped_column(String(256))
    provider: Mapped[str] = mapped_column(String(128), default="openai")
    requests: Mapped[int] = mapped_column(Integer, default=0)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)
    raw_json: Mapped[dict] = mapped_column(JSON, default=dict)


class PriceRecord(Base, TimestampMixin):
    __tablename__ = "price_catalog"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    provider: Mapped[str] = mapped_column(String(128))
    model: Mapped[str] = mapped_column(String(256))
    version: Mapped[str] = mapped_column(String(64))
    input_per_million: Mapped[float] = mapped_column(Float)
    output_per_million: Mapped[float] = mapped_column(Float)
    currency: Mapped[str] = mapped_column(String(8), default="USD")
    effective_from: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    effective_to: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class CostRecord(Base, TimestampMixin, TenantMixin):
    __tablename__ = "cost_records"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"))
    usage_record_id: Mapped[str] = mapped_column(ForeignKey("usage_records.id"))
    price_id: Mapped[str | None] = mapped_column(ForeignKey("price_catalog.id"), nullable=True)
    amount: Mapped[float] = mapped_column(Float, default=0)
    currency: Mapped[str] = mapped_column(String(8), default="USD")
    calculation_json: Mapped[dict] = mapped_column(JSON, default=dict)


class AuditLogRecord(Base):
    __tablename__ = "audit_logs"
    __table_args__ = (Index("ix_audit_resource", "resource_type", "resource_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    tenant_id: Mapped[str] = mapped_column(String(64), default="default")
    actor_id: Mapped[str] = mapped_column(String(128), default="system")
    action: Mapped[str] = mapped_column(String(128))
    resource_type: Mapped[str] = mapped_column(String(64))
    resource_id: Mapped[str] = mapped_column(String(64))
    before_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    after_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
