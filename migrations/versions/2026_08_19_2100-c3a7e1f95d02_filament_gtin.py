"""filament gtin.

Revision ID: c3a7e1f95d02
Revises: 9c1d5f2a7b31
Create Date: 2026-08-19 21:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "c3a7e1f95d02"
down_revision = "9c1d5f2a7b31"
branch_labels = None
depends_on = None

# The GS1 lengths, and the padded width the column stores.
#
# This duplicates spoolman.gtin deliberately. A migration is a historical record: replaying it on
# a fresh database has to produce what it produced the day it was written, so it must not change
# underneath us when the application helper is refactored, and must not break if that module is
# ever moved or renamed. Keep the two in step only if the *definition* of a valid GTIN changes,
# which it will not -- it is a published GS1 standard.
_GTIN_LENGTHS = (8, 12, 13, 14)
_GTIN_STORED_LENGTH = 14
_DIGITS = "0123456789"


def _normalize_gtin(value: str | None) -> str | None:
    """Return a barcode as its zero-padded 14 digit GTIN, or None if it is not a valid one."""
    if value is None:
        return None

    digits = "".join(char for char in value if char in _DIGITS)
    if len(digits) not in _GTIN_LENGTHS:
        return None

    # GS1 mod-10: weight the digits 3 and 1 alternating from the right, ignoring the check digit.
    total = 0
    for i, char in enumerate(reversed(digits[:-1])):
        total += int(char) * (3 if i % 2 == 0 else 1)
    if int(digits[-1]) != (10 - total % 10) % 10:
        return None

    return digits.zfill(_GTIN_STORED_LENGTH)


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
        gtin = _normalize_gtin(row.article_number)
        if gtin is not None:
            connection.execute(sa.update(filament).where(filament.c.id == row.id).values(gtin=gtin))


def downgrade() -> None:
    """Perform the downgrade."""
    op.drop_index("ix_filament_gtin", table_name="filament")
    op.drop_column("filament", "gtin")
