"""Merge tag and filament GTIN migration heads.

Revision ID: d8e6f4a91b23
Revises: c3a7e1f95d02, fe4970567bb3
Create Date: 2026-11-07 15:00:00.000000
"""

revision = "d8e6f4a91b23"
down_revision = ("c3a7e1f95d02", "fe4970567bb3")
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Merge the independent migration branches."""


def downgrade() -> None:
    """Restore the independent migration branches."""
