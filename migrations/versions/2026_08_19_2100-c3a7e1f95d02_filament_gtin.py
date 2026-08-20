"""filament gtin.

Revision ID: c3a7e1f95d02
Revises: 9c1d5f2a7b31
Create Date: 2026-08-19 21:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

from spoolman.gtin import normalize_gtin

# revision identifiers, used by Alembic.
revision = "c3a7e1f95d02"
down_revision = "9c1d5f2a7b31"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add the filament GTIN column and backfill it from article_number.

    article_number has been serving double duty as both the vendor article number it is
    documented as and the scanned retail barcode, which means a filament that legitimately has
    both can only keep one. This gives the barcode its own column so article_number can go back
    to meaning just the vendor SKU.

    The backfill is purely additive: article_number is deliberately left untouched, because
    existing clients still read the barcode from it and would break the moment it were cleared.
    Rows whose article_number is a vendor SKU rather than a barcode simply keep a NULL gtin.

    There is intentionally no unique constraint. Multipacks and marketplace parent listings
    legitimately share one GTIN across several variants, so uniqueness would reject valid data.
    """
    op.add_column("filament", sa.Column("gtin", sa.String(length=14), nullable=True))
    op.create_index("ix_filament_gtin", "filament", ["gtin"], unique=False)

    # Rows are rewritten one by one through the connection rather than with SQL string
    # functions, so this behaves identically on sqlite, postgres, mysql and cockroachdb
    # (see 304a32906234 for the cockroachdb caveat).
    filament = sa.Table(
        "filament",
        sa.MetaData(),
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("article_number", sa.String(length=64), nullable=True),
        sa.Column("gtin", sa.String(length=14), nullable=True),
    )

    connection = op.get_bind()
    rows = connection.execute(sa.select(filament.c.id, filament.c.article_number)).fetchall()

    for row in rows:
        gtin = normalize_gtin(row.article_number)
        if gtin is not None:
            connection.execute(sa.update(filament).where(filament.c.id == row.id).values(gtin=gtin))


def downgrade() -> None:
    """Perform the downgrade."""
    op.drop_index("ix_filament_gtin", table_name="filament")
    op.drop_column("filament", "gtin")
