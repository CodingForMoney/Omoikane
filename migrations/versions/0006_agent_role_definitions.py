"""Add Claude-style Agent role definitions and global settings.

Revision ID: 0006
Revises: 0005
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | Sequence[str] | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "agent_settings",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("revision", sa.Integer(), server_default="1", nullable=False),
        sa.Column("defaults_revision", sa.Integer(), server_default="1", nullable=False),
        sa.Column("policy_revision", sa.Integer(), server_default="1", nullable=False),
        sa.Column("global_instructions", sa.Text(), server_default="", nullable=False),
        sa.Column("defaults_json", sa.JSON(), server_default="{}", nullable=False),
        sa.Column("policy_json", sa.JSON(), server_default="{}", nullable=False),
        sa.Column("updated_by", sa.String(128), server_default="system", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("tenant_id", sa.String(64), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tenant_id", name="uq_agent_settings_tenant"),
    )
    op.create_index("ix_agent_settings_tenant_id", "agent_settings", ["tenant_id"])

    with op.batch_alter_table("agent_versions") as batch:
        batch.add_column(
            sa.Column(
                "definition_format",
                sa.String(32),
                server_default="legacy_json",
                nullable=False,
            )
        )
        batch.add_column(sa.Column("definition_source", sa.Text(), nullable=True))
        batch.add_column(
            sa.Column("definition_json", sa.JSON(), server_default="{}", nullable=False)
        )
        batch.add_column(
            sa.Column("overrides_json", sa.JSON(), server_default="{}", nullable=False)
        )
        batch.add_column(
            sa.Column("global_defaults_revision", sa.Integer(), server_default="0", nullable=False)
        )
        batch.add_column(
            sa.Column("platform_policy_revision", sa.Integer(), server_default="0", nullable=False)
        )


def downgrade() -> None:
    with op.batch_alter_table("agent_versions") as batch:
        batch.drop_column("platform_policy_revision")
        batch.drop_column("global_defaults_revision")
        batch.drop_column("overrides_json")
        batch.drop_column("definition_json")
        batch.drop_column("definition_source")
        batch.drop_column("definition_format")
    op.drop_index("ix_agent_settings_tenant_id", table_name="agent_settings")
    op.drop_table("agent_settings")
