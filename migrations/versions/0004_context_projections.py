"""Add durable context projections and transactional compaction state.

Revision ID: 0004
Revises: 0003
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | Sequence[str] | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("sessions") as batch:
        batch.add_column(sa.Column("revision", sa.Integer(), server_default="0", nullable=False))
        batch.add_column(
            sa.Column(
                "active_projection_revision", sa.Integer(), server_default="0", nullable=False
            )
        )

    with op.batch_alter_table("compactions") as batch:
        batch.add_column(
            sa.Column("status", sa.String(32), server_default="pending", nullable=False)
        )
        batch.add_column(
            sa.Column("strategy", sa.String(64), server_default="portable", nullable=False)
        )
        batch.add_column(
            sa.Column("trigger", sa.String(64), server_default="manual", nullable=False)
        )
        batch.add_column(sa.Column("parent_compaction_id", sa.String(36), nullable=True))
        batch.add_column(
            sa.Column("source_from_seq", sa.Integer(), server_default="1", nullable=False)
        )
        batch.add_column(
            sa.Column("source_to_seq", sa.Integer(), server_default="0", nullable=False)
        )
        batch.add_column(
            sa.Column("source_revision", sa.Integer(), server_default="0", nullable=False)
        )
        batch.add_column(
            sa.Column("provider", sa.String(128), server_default="", nullable=False)
        )
        batch.add_column(sa.Column("model", sa.String(256), server_default="", nullable=False))
        batch.add_column(
            sa.Column("schema_version", sa.Integer(), server_default="1", nullable=False)
        )
        batch.add_column(sa.Column("summary_json", sa.JSON(), server_default="{}", nullable=False))
        batch.add_column(
            sa.Column("native_items_json", sa.JSON(), server_default="[]", nullable=False)
        )
        batch.add_column(
            sa.Column("validation_json", sa.JSON(), server_default="{}", nullable=False)
        )
        batch.add_column(
            sa.Column("tokens_before", sa.Integer(), server_default="0", nullable=False)
        )
        batch.add_column(
            sa.Column("tokens_after", sa.Integer(), server_default="0", nullable=False)
        )
        batch.add_column(
            sa.Column("compression_ratio", sa.Float(), server_default="0", nullable=False)
        )
        batch.add_column(sa.Column("failure_reason", sa.Text(), nullable=True))
        batch.add_column(sa.Column("attempt_id", sa.String(36), nullable=True))
        batch.add_column(sa.Column("lease_holder", sa.String(128), nullable=True))
        batch.add_column(
            sa.Column("engine_name", sa.String(64), server_default="portable", nullable=False)
        )
        batch.add_column(
            sa.Column("engine_version", sa.String(32), server_default="1", nullable=False)
        )
        batch.add_column(
            sa.Column("summary_generation", sa.Integer(), server_default="1", nullable=False)
        )
        batch.add_column(
            sa.Column(
                "summary_model_context_window", sa.Integer(), server_default="0", nullable=False
            )
        )
        batch.add_column(
            sa.Column("summary_input_tokens", sa.Integer(), server_default="0", nullable=False)
        )
        batch.add_column(
            sa.Column("summary_output_tokens", sa.Integer(), server_default="0", nullable=False)
        )
        batch.add_column(
            sa.Column("source_chunk_count", sa.Integer(), server_default="0", nullable=False)
        )
        batch.add_column(
            sa.Column("all_chunks_covered", sa.Boolean(), server_default=sa.false(), nullable=False)
        )
        batch.create_foreign_key(
            "fk_compactions_parent", "compactions", ["parent_compaction_id"], ["id"]
        )
        batch.create_index("ix_compactions_status", ["status"])
        batch.create_index("ix_compactions_attempt_id", ["attempt_id"])

    op.create_table(
        "context_projections",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("session_id", sa.String(36), nullable=False),
        sa.Column("compaction_id", sa.String(36), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("source_from_seq", sa.Integer(), nullable=False),
        sa.Column("source_to_seq", sa.Integer(), nullable=False),
        sa.Column("source_revision", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("strategy", sa.String(64), nullable=False),
        sa.Column("tokens", sa.Integer(), nullable=False),
        sa.Column("checksum", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("tenant_id", sa.String(64), nullable=False),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["compaction_id"], ["compactions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("compaction_id"),
        sa.UniqueConstraint("session_id", "revision", name="uq_context_projection_revision"),
    )
    op.create_index(
        "ix_context_projection_active",
        "context_projections",
        ["session_id", "status", "revision"],
    )
    op.create_index("ix_context_projections_tenant_id", "context_projections", ["tenant_id"])

    op.create_table(
        "context_projection_segments",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("projection_id", sa.String(36), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("segment_type", sa.String(64), nullable=False),
        sa.Column("source_from_seq", sa.Integer(), nullable=True),
        sa.Column("source_to_seq", sa.Integer(), nullable=True),
        sa.Column("item_json", sa.JSON(), nullable=False),
        sa.Column("metadata_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["projection_id"], ["context_projections.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "projection_id", "position", name="uq_projection_segment_position"
        ),
    )
    op.create_index(
        "ix_projection_segments_order",
        "context_projection_segments",
        ["projection_id", "position"],
    )

    op.create_table(
        "compaction_leases",
        sa.Column("session_id", sa.String(36), nullable=False),
        sa.Column("holder", sa.String(128), nullable=False),
        sa.Column("attempt_id", sa.String(36), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("session_id"),
    )
    op.create_index("ix_compaction_leases_expires_at", "compaction_leases", ["expires_at"])

    op.create_table(
        "compaction_state",
        sa.Column("session_id", sa.String(36), nullable=False),
        sa.Column("state", sa.String(32), nullable=False),
        sa.Column("last_real_input_tokens", sa.Integer(), nullable=False),
        sa.Column("high_watermark_tokens", sa.Integer(), nullable=False),
        sa.Column("low_watermark_tokens", sa.Integer(), nullable=False),
        sa.Column("ineffective_count", sa.Integer(), nullable=False),
        sa.Column("cooldown_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_failure_reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("session_id"),
    )

    op.create_table(
        "compaction_source_chunks",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("compaction_id", sa.String(36), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("source_from_seq", sa.Integer(), nullable=False),
        sa.Column("source_to_seq", sa.Integer(), nullable=False),
        sa.Column("input_tokens", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("summary_json", sa.JSON(), nullable=False),
        sa.Column("failure_reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["compaction_id"], ["compactions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("compaction_id", "position", name="uq_compaction_chunk_position"),
    )
    op.create_index(
        "ix_compaction_source_chunks_compaction_id",
        "compaction_source_chunks",
        ["compaction_id"],
    )

    op.create_table(
        "provider_capabilities",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("provider", sa.String(128), nullable=False),
        sa.Column("base_url", sa.Text(), nullable=False),
        sa.Column("model", sa.String(256), nullable=False),
        sa.Column("responses_compact", sa.Boolean(), nullable=False),
        sa.Column("server_context_management", sa.Boolean(), nullable=False),
        sa.Column("compaction_item_replay", sa.Boolean(), nullable=False),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("details_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "provider", "base_url", "model", name="uq_provider_compaction_capability"
        ),
    )


def downgrade() -> None:
    op.drop_table("provider_capabilities")
    op.drop_index(
        "ix_compaction_source_chunks_compaction_id",
        table_name="compaction_source_chunks",
    )
    op.drop_table("compaction_source_chunks")
    op.drop_table("compaction_state")
    op.drop_index("ix_compaction_leases_expires_at", table_name="compaction_leases")
    op.drop_table("compaction_leases")
    op.drop_index("ix_projection_segments_order", table_name="context_projection_segments")
    op.drop_table("context_projection_segments")
    op.drop_index("ix_context_projections_tenant_id", table_name="context_projections")
    op.drop_index("ix_context_projection_active", table_name="context_projections")
    op.drop_table("context_projections")

    with op.batch_alter_table("compactions") as batch:
        batch.drop_index("ix_compactions_attempt_id")
        batch.drop_index("ix_compactions_status")
        batch.drop_constraint("fk_compactions_parent", type_="foreignkey")
        for column in (
            "all_chunks_covered",
            "source_chunk_count",
            "summary_output_tokens",
            "summary_input_tokens",
            "summary_model_context_window",
            "summary_generation",
            "engine_version",
            "engine_name",
            "lease_holder",
            "attempt_id",
            "failure_reason",
            "compression_ratio",
            "tokens_after",
            "tokens_before",
            "validation_json",
            "native_items_json",
            "summary_json",
            "schema_version",
            "model",
            "provider",
            "source_revision",
            "source_to_seq",
            "source_from_seq",
            "parent_compaction_id",
            "trigger",
            "strategy",
            "status",
        ):
            batch.drop_column(column)

    with op.batch_alter_table("sessions") as batch:
        batch.drop_column("active_projection_revision")
        batch.drop_column("revision")
