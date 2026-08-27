"""Make run_events a transactional notification outbox.

Revision ID: 0003
Revises: 0002
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | Sequence[str] | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "run_events", sa.Column("published_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "run_events",
        sa.Column("publish_attempts", sa.Integer(), server_default="0", nullable=False),
    )
    op.add_column("run_events", sa.Column("last_publish_error", sa.Text(), nullable=True))
    op.add_column(
        "run_events", sa.Column("next_publish_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "run_events", sa.Column("publish_lease_owner", sa.String(128), nullable=True)
    )
    op.add_column(
        "run_events",
        sa.Column("publish_lease_expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_run_events_outbox",
        "run_events",
        ["published_at", "next_publish_at", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_run_events_outbox", table_name="run_events")
    op.drop_column("run_events", "publish_lease_expires_at")
    op.drop_column("run_events", "publish_lease_owner")
    op.drop_column("run_events", "next_publish_at")
    op.drop_column("run_events", "last_publish_error")
    op.drop_column("run_events", "publish_attempts")
    op.drop_column("run_events", "published_at")
