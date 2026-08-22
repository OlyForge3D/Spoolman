"""Integration tests for the filament GTIN field."""

from typing import Any

import httpx
import pytest

from ..conftest import URL, assert_httpx_code, assert_lists_compatible

# A real UPC-A (GTIN-12) and EAN-13, with the 14 digit form they are stored as.
UPC_A = "850078714923"
UPC_A_STORED = "00850078714923"
EAN_13 = "6938936709947"
EAN_13_STORED = "06938936709947"
EAN_8 = "96385074"
EAN_8_STORED = "00000096385074"


def add_filament(**kwargs: Any) -> dict[str, Any]:  # noqa: ANN401
    """Add a filament with the given extra fields and return it."""
    result = httpx.post(f"{URL}/api/v1/filament", json={"density": 1.25, "diameter": 1.75, **kwargs})
    result.raise_for_status()
    return result.json()


@pytest.mark.parametrize(
    ("sent", "stored"),
    [
        pytest.param(EAN_8, EAN_8_STORED, id="gtin-8"),
        pytest.param(UPC_A, UPC_A_STORED, id="gtin-12"),
        pytest.param(EAN_13, EAN_13_STORED, id="gtin-13"),
        pytest.param(UPC_A_STORED, UPC_A_STORED, id="gtin-14"),
        pytest.param(f"0 {UPC_A[:6]} {UPC_A[6:]}", UPC_A_STORED, id="with-separators"),
    ],
)
def test_add_filament_with_gtin(sent: str, stored: str):
    """A GTIN of any GS1 length is normalized to its zero-padded 14 digit form on create."""
    # Execute
    filament = add_filament(gtin=sent)

    # Verify
    assert filament["gtin"] == stored

    # Clean up
    httpx.delete(f"{URL}/api/v1/filament/{filament['id']}").raise_for_status()


def test_add_filament_gtin_zero_pad_equivalence():
    """The same barcode is stored identically however many leading zeros the client sends."""
    # Execute
    filaments = [add_filament(gtin=value) for value in (UPC_A, f"0{UPC_A}", UPC_A_STORED)]

    # Verify
    assert {filament["gtin"] for filament in filaments} == {UPC_A_STORED}

    # Clean up
    for filament in filaments:
        httpx.delete(f"{URL}/api/v1/filament/{filament['id']}").raise_for_status()


@pytest.mark.parametrize(
    "gtin",
    [
        pytest.param("PF01001", id="vendor-sku"),
        pytest.param("ABS-CF-B", id="vendor-sku-no-digits"),
        pytest.param("04850807Z", id="malformed-scan"),
        pytest.param("850078714924", id="bad-check-digit"),
        pytest.param("123456789", id="bad-length"),
    ],
)
def test_add_filament_invalid_gtin(gtin: str):
    """A value that is not a valid GTIN is rejected rather than stored as a barcode."""
    # Execute
    result = httpx.post(
        f"{URL}/api/v1/filament",
        json={"density": 1.25, "diameter": 1.75, "gtin": gtin},
    )

    # Verify
    assert_httpx_code(result, 400)


def test_add_filament_without_gtin():
    """A filament with no barcode has no GTIN, rather than an empty one."""
    # Execute
    filament = add_filament(article_number="PF01001")

    # Verify
    assert "gtin" not in filament

    # Clean up
    httpx.delete(f"{URL}/api/v1/filament/{filament['id']}").raise_for_status()


def test_update_filament_gtin(random_filament: dict[str, Any]):
    """A GTIN set through an update is normalized the same way as one set on create."""
    # Execute
    result = httpx.patch(f"{URL}/api/v1/filament/{random_filament['id']}", json={"gtin": EAN_13})
    result.raise_for_status()

    # Verify
    assert result.json()["gtin"] == EAN_13_STORED

    # The article number is a separate field and is untouched by a GTIN update.
    assert result.json()["article_number"] == random_filament["article_number"]


def test_update_filament_gtin_invalid(random_filament: dict[str, Any]):
    """An update that would store an invalid GTIN is rejected and changes nothing."""
    # Execute
    result = httpx.patch(f"{URL}/api/v1/filament/{random_filament['id']}", json={"gtin": "04850807Z"})

    # Verify
    assert_httpx_code(result, 400)

    result = httpx.get(f"{URL}/api/v1/filament/{random_filament['id']}")
    result.raise_for_status()
    assert "gtin" not in result.json()


def test_update_filament_gtin_clear(random_filament: dict[str, Any]):
    """An empty GTIN clears the field."""
    # Execute
    result = httpx.patch(f"{URL}/api/v1/filament/{random_filament['id']}", json={"gtin": UPC_A})
    result.raise_for_status()
    assert result.json()["gtin"] == UPC_A_STORED

    result = httpx.patch(f"{URL}/api/v1/filament/{random_filament['id']}", json={"gtin": ""})
    result.raise_for_status()

    # Verify
    assert "gtin" not in result.json()


@pytest.mark.parametrize(
    "query",
    [
        pytest.param(UPC_A, id="as-printed"),
        pytest.param(UPC_A_STORED, id="as-stored"),
        pytest.param(f'"{UPC_A_STORED}"', id="exact"),
        # The barcode as printed, asked for exactly: the padding is Spoolman's, not the label's,
        # so a caller quoting what it scanned still has to find it.
        pytest.param(f'"{UPC_A}"', id="exact-as-printed"),
        # What a label reads with the separators printed under the bars.
        pytest.param(f"{UPC_A[:1]}-{UPC_A[1:6]}-{UPC_A[6:]}", id="with-separators"),
    ],
)
def test_find_filament_by_gtin(query: str):
    """A filament is found by its barcode whether or not the query carries the padding."""
    # Setup
    wanted = add_filament(gtin=UPC_A)
    other = add_filament(gtin=EAN_13)

    # Execute
    result = httpx.get(f"{URL}/api/v1/filament", params={"gtin": query})
    result.raise_for_status()

    # Verify
    assert_lists_compatible(result.json(), [wanted])

    # Clean up
    for filament in (wanted, other):
        httpx.delete(f"{URL}/api/v1/filament/{filament['id']}").raise_for_status()


def test_find_filament_by_gtin_partial():
    """A partial-digit term is still a substring search, so widening a barcode has not narrowed it."""
    # Setup
    wanted = add_filament(gtin=UPC_A)
    other = add_filament(gtin=EAN_13)

    # Execute
    result = httpx.get(f"{URL}/api/v1/filament", params={"gtin": UPC_A[2:8]})
    result.raise_for_status()

    # Verify
    assert_lists_compatible(result.json(), [wanted])

    # Clean up
    for filament in (wanted, other):
        httpx.delete(f"{URL}/api/v1/filament/{filament['id']}").raise_for_status()


def test_find_filament_with_no_gtin():
    """An empty term still means "no barcode recorded" rather than "any barcode"."""
    # Setup
    wanted = add_filament()
    other = add_filament(gtin=UPC_A)

    # Execute
    result = httpx.get(f"{URL}/api/v1/filament", params={"gtin": ""})
    result.raise_for_status()

    # Verify
    assert_lists_compatible(result.json(), [wanted])

    # Clean up
    for filament in (wanted, other):
        httpx.delete(f"{URL}/api/v1/filament/{filament['id']}").raise_for_status()


@pytest.mark.parametrize(
    "query",
    [
        pytest.param(EAN_13, id="as-printed"),
        pytest.param(EAN_13_STORED, id="as-stored"),
        pytest.param(f'"{EAN_13}"', id="exact-as-printed"),
    ],
)
def test_search_filament_by_gtin(query: str):
    """The general search term matches a filament's GTIN.

    The search filter matches on a prefix, so the padding the column carries would otherwise put
    a barcode scanned as printed out of its reach entirely.
    """
    # Setup
    wanted = add_filament(gtin=EAN_13)
    other = add_filament(gtin=UPC_A)

    # Execute
    result = httpx.get(f"{URL}/api/v1/filament", params={"search": query})
    result.raise_for_status()

    # Verify
    assert_lists_compatible(result.json(), [wanted])

    # Clean up
    for filament in (wanted, other):
        httpx.delete(f"{URL}/api/v1/filament/{filament['id']}").raise_for_status()
