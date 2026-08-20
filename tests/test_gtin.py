"""Tests for the GTIN normalization helpers."""

import pytest

from spoolman.gtin import format_gtin, normalize_gtin


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        pytest.param("96385074", "00000096385074", id="gtin-8"),
        pytest.param("850078714923", "00850078714923", id="gtin-12"),
        pytest.param("6938936709947", "06938936709947", id="gtin-13"),
        pytest.param("00850078714923", "00850078714923", id="gtin-14"),
    ],
)
def test_normalize_gtin_valid_lengths(value: str, expected: str):
    """Every GS1 length is accepted and stored zero-padded to 14 digits."""
    assert normalize_gtin(value) == expected


def test_normalize_gtin_zero_pad_equivalence():
    """The same product identifier normalizes identically however many leading zeros it carries."""
    padded = normalize_gtin("00850078714923")
    assert normalize_gtin("850078714923") == padded
    assert normalize_gtin("0850078714923") == padded


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        pytest.param("0 850078 714923", "00850078714923", id="spaces"),
        pytest.param("850078-714923", "00850078714923", id="hyphen"),
        pytest.param("  850078714923\n", "00850078714923", id="scanner-whitespace"),
    ],
)
def test_normalize_gtin_strips_non_digits(value: str, expected: str | None):
    """Separators printed under a barcode and whitespace from a scanner are tolerated."""
    assert normalize_gtin(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        pytest.param("850078714924", id="gtin-12"),
        pytest.param("6938936709948", id="gtin-13"),
        pytest.param("96385075", id="gtin-8"),
        # A malformed scan; the digits left over fail the GTIN-8 check digit.
        pytest.param("04850807Z", id="malformed-scan"),
    ],
)
def test_normalize_gtin_rejects_bad_check_digit(value: str):
    assert normalize_gtin(value) is None


@pytest.mark.parametrize(
    "value",
    [
        pytest.param("PF01001", id="vendor-sku"),
        pytest.param("ABS-CF-B", id="vendor-sku-no-digits"),
        pytest.param("PM70820", id="vendor-sku-documented-example"),
        pytest.param("1234567", id="7-digits"),
        pytest.param("123456789", id="9-digits"),
        pytest.param("123456789012345", id="15-digits"),
        pytest.param("", id="empty"),
        pytest.param("   ", id="blank"),
    ],
)
def test_normalize_gtin_rejects_non_gtin(value: str):
    assert normalize_gtin(value) is None


def test_normalize_gtin_none():
    assert normalize_gtin(None) is None


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("00850078714923", "850078714923"),
        ("06938936709947", "6938936709947"),
        ("00000096385074", "96385074"),
        ("10850078714920", "10850078714920"),
        (None, None),
        ("", None),
    ],
)
def test_format_gtin(value: str | None, expected: str | None):
    """A stored GTIN displays in the shortest GS1 length that fits it."""
    assert format_gtin(value) == expected


@pytest.mark.parametrize(
    "value",
    ["96385074", "850078714923", "6938936709947", "10850078714920"],
)
def test_format_gtin_round_trip(value: str):
    """Formatting a normalized GTIN gives back exactly what was scanned."""
    normalized = normalize_gtin(value)
    assert normalized is not None
    assert format_gtin(normalized) == value
