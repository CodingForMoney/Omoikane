"""Add managed provider connections and model catalog.

Revision ID: 0005
Revises: 0004
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | Sequence[str] | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "provider_connections",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("name", sa.String(256), nullable=False),
        sa.Column("provider", sa.String(128), nullable=False),
        sa.Column("endpoint_profile", sa.String(128), nullable=False),
        sa.Column("base_url", sa.Text(), nullable=False),
        sa.Column("protocol", sa.String(32), nullable=False),
        sa.Column("api_key_ciphertext", sa.LargeBinary(), nullable=True),
        sa.Column("api_key_checksum", sa.String(64), nullable=True),
        sa.Column("api_key_env", sa.String(256), nullable=True),
        sa.Column("key_hint", sa.String(32), nullable=True),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("last_validated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("settings_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("tenant_id", sa.String(64), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "tenant_id", "name", name="uq_provider_connection_tenant_name"
        ),
    )
    op.create_index(
        "ix_provider_connections_provider",
        "provider_connections",
        ["tenant_id", "provider"],
    )
    op.create_index(
        "ix_provider_connections_tenant_id",
        "provider_connections",
        ["tenant_id"],
    )

    op.create_table(
        "provider_models",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("connection_id", sa.String(36), nullable=False),
        sa.Column("model_id", sa.String(256), nullable=False),
        sa.Column("display_name", sa.String(256), nullable=False),
        sa.Column("source", sa.String(32), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("capabilities_json", sa.JSON(), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("tenant_id", sa.String(64), nullable=False),
        sa.ForeignKeyConstraint(
            ["connection_id"], ["provider_connections.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "connection_id", "model_id", name="uq_provider_model_connection"
        ),
    )
    op.create_index(
        "ix_provider_models_connection_id", "provider_models", ["connection_id"]
    )
    op.create_index(
        "ix_provider_models_status", "provider_models", ["tenant_id", "status"]
    )
    op.create_index(
        "ix_provider_models_tenant_id", "provider_models", ["tenant_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_provider_models_tenant_id", table_name="provider_models")
    op.drop_index("ix_provider_models_status", table_name="provider_models")
    op.drop_index("ix_provider_models_connection_id", table_name="provider_models")
    op.drop_table("provider_models")
    op.drop_index(
        "ix_provider_connections_tenant_id", table_name="provider_connections"
    )
    op.drop_index(
        "ix_provider_connections_provider", table_name="provider_connections"
    )
    op.drop_table("provider_connections")
