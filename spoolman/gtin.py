"""Helpers for normalizing GTIN (Global Trade Item Number) barcodes.

GTIN is the GS1 umbrella standard for retail product barcodes: UPC-A is GTIN-12, EAN-13 is
GTIN-13 and EAN-8 is GTIN-8. The lengths are zero-pad equivalent -- ``850078714923``,
``0850078714923`` and ``00850078714923`` all identify the same product, and the mod-10 check
digit stays valid across them because leading zeros contribute nothing to the weighted sum.

Storing the padded 14 digit form therefore makes an exact-match lookup reliable no matter which
length is printed on the label or handed over by a barcode scanner.
"""

# The lengths GS1 defines, shortest first. Anything else is not a GTIN, whatever else it may be.
_GTIN_LENGTHS = (8, 12, 13, 14)
_GTIN_STORED_LENGTH = 14

_DIGITS = "0123456789"


def _check_digit(digits: str) -> int:
    """Calculate the GS1 mod-10 check digit for everything but a GTIN's last digit.

    The digits are weighted 3 and 1 alternating from the right, so that the weights line up the
    same way regardless of the GTIN's length.
    """
    total = 0
    for i, char in enumerate(reversed(digits)):
        total += int(char) * (3 if i % 2 == 0 else 1)
    return (10 - total % 10) % 10


def normalize_gtin(value: str | None) -> str | None:
    """Normalize a barcode into its zero-padded 14 digit GTIN form.

    Non-digit characters are stripped first, so the separators printed under a barcode and any
    whitespace a scanner tacks on are tolerated.

    Returns ``None`` if what remains is not a GTIN of a valid length with a valid check digit.
    That is what keeps a vendor article number such as ``PF01001`` or ``ABS-CF-B``, and a
    mis-scanned value such as ``04850807Z``, from being stored as if it were a barcode.
    """
    if value is None:
        return None

    digits = "".join(char for char in value if char in _DIGITS)
    if len(digits) not in _GTIN_LENGTHS:
        return None
    if int(digits[-1]) != _check_digit(digits[:-1]):
        return None

    return digits.zfill(_GTIN_STORED_LENGTH)


def format_gtin(value: str | None) -> str | None:
    """Render a stored GTIN in the shortest GS1 length that fits it.

    This undoes the padding applied by :func:`normalize_gtin` for display: a UPC-A stored as
    ``00850078714923`` is shown as ``850078714923``, which is what is printed on the product.
    """
    if not value:
        return None

    significant = value.lstrip("0")
    for length in _GTIN_LENGTHS:
        if len(significant) <= length:
            return significant.zfill(length)
    return value
