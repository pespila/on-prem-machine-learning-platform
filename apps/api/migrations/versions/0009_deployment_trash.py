"""Soft-delete (Trash) for deployments.

Revision ID: 0009_deployment_trash
Revises: 0008_mlflow_b
Create Date: 2026-05-05

Adds ``deployments.trashed_at`` so DELETE becomes a soft-delete (move to
Trash) instead of an irrecoverable wipe. The active list filters on
``trashed_at IS NULL``; the Trash view filters the inverse. The hard
purge endpoint deletes the row + the staged artifacts directory under
``/var/platform-data/deployments/{id}/`` (the only meaningful
disk-leak source — see jobs/tasks/deploy_model.py:33).

Forward-only and trivially reversible: drop the column to revert.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0009_deployment_trash"
down_revision = "0008_mlflow_b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "deployments",
        sa.Column("trashed_at", sa.DateTime(timezone=True), nullable=True),
    )
    # Partial index: 99% of queries want active rows (trashed_at IS NULL).
    # A partial index keeps the lookup cheap without bloating writes when a
    # row is moved to trash.
    op.create_index(
        "ix_deployments_trashed_at",
        "deployments",
        ["trashed_at"],
        postgresql_where=sa.text("trashed_at IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_deployments_trashed_at", table_name="deployments")
    op.drop_column("deployments", "trashed_at")
