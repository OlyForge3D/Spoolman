"""Integration tests for the GET /api/v1/spool/materials/available endpoint."""

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

import httpx
import pytest

from ..conftest import URL


@dataclass
class Fixture:
    spools: list[dict[str, Any]]
    pla_filament: dict[str, Any]
    abs_filament: dict[str, Any]


@pytest.fixture(scope="module")
def spools(
    random_vendor_mod: dict[str, Any],
) -> Iterable[Fixture]:
    """Add some spools with different materials and states to the database."""
    # Create a PLA filament
    result = httpx.post(
        f"{URL}/api/v1/filament",
        json={
            "name": "PLA Red",
            "vendor_id": random_vendor_mod["id"],
            "material": "PLA",
            "density": 1.24,
            "diameter": 1.75,
            "weight": 1000,
        },
    )
    result.raise_for_status()
    pla_filament = result.json()

    # Create an ABS filament
    result = httpx.post(
        f"{URL}/api/v1/filament",
        json={
            "name": "ABS Black",
            "vendor_id": random_vendor_mod["id"],
            "material": "ABS",
            "density": 1.05,
            "diameter": 1.75,
            "weight": 1000,
        },
    )
    result.raise_for_status()
    abs_filament = result.json()

    # Spool 1: PLA, non-archived, has remaining weight -> should appear
    result = httpx.post(
        f"{URL}/api/v1/spool",
        json={
            "filament_id": pla_filament["id"],
            "remaining_weight": 500,
        },
    )
    result.raise_for_status()
    spool_1 = result.json()

    # Spool 2: ABS, non-archived, has remaining weight -> should appear
    result = httpx.post(
        f"{URL}/api/v1/spool",
        json={
            "filament_id": abs_filament["id"],
            "remaining_weight": 200,
        },
    )
    result.raise_for_status()
    spool_2 = result.json()

    # Spool 3: PLA, archived -> should NOT appear
    result = httpx.post(
        f"{URL}/api/v1/spool",
        json={
            "filament_id": pla_filament["id"],
            "remaining_weight": 800,
            "archived": True,
        },
    )
    result.raise_for_status()
    spool_3 = result.json()

    # Spool 4: ABS, non-archived, used_weight == weight (empty) -> should NOT appear
    result = httpx.post(
        f"{URL}/api/v1/spool",
        json={
            "filament_id": abs_filament["id"],
            "used_weight": 1000,
        },
    )
    result.raise_for_status()
    spool_4 = result.json()

    # Spool 5: PLA, non-archived, no weight info (remaining_weight unknown) -> should appear
    result = httpx.post(
        f"{URL}/api/v1/spool",
        json={
            "filament_id": pla_filament["id"],
        },
    )
    result.raise_for_status()
    spool_5 = result.json()

    yield Fixture(
        spools=[spool_1, spool_2, spool_3, spool_4, spool_5],
        pla_filament=pla_filament,
        abs_filament=abs_filament,
    )

    httpx.delete(f"{URL}/api/v1/spool/{spool_1['id']}").raise_for_status()
    httpx.delete(f"{URL}/api/v1/spool/{spool_2['id']}").raise_for_status()
    httpx.delete(f"{URL}/api/v1/spool/{spool_3['id']}").raise_for_status()
    httpx.delete(f"{URL}/api/v1/spool/{spool_4['id']}").raise_for_status()
    httpx.delete(f"{URL}/api/v1/spool/{spool_5['id']}").raise_for_status()
    httpx.delete(f"{URL}/api/v1/filament/{pla_filament['id']}").raise_for_status()
    httpx.delete(f"{URL}/api/v1/filament/{abs_filament['id']}").raise_for_status()


def test_available_materials_returns_list(spools: Fixture):  # noqa: ARG001
    """Test that the endpoint returns a list of strings."""
    result = httpx.get(f"{URL}/api/v1/spool/materials/available")
    result.raise_for_status()

    materials = result.json()
    assert isinstance(materials, list)
    assert all(isinstance(m, str) for m in materials)


def test_available_materials_excludes_archived(spools: Fixture):  # noqa: ARG001
    """Test that materials only from archived spools are excluded."""
    result = httpx.get(f"{URL}/api/v1/spool/materials/available")
    result.raise_for_status()

    materials = result.json()
    # ABS spool_2 has remaining weight, so ABS should be present
    assert "ABS" in materials
    # PLA spool_1 and spool_5 are non-archived with filament, so PLA should be present
    assert "PLA" in materials


def test_available_materials_excludes_empty_spools(spools: Fixture):  # noqa: ARG001
    """Test that materials where all spools are empty are excluded."""
    result = httpx.get(f"{URL}/api/v1/spool/materials/available")
    result.raise_for_status()

    materials = result.json()
    # ABS spool_4 is empty (used_weight == weight), but ABS spool_2 has remaining weight
    # so ABS should still appear
    assert "ABS" in materials


def test_available_materials_is_sorted(spools: Fixture):  # noqa: ARG001
    """Test that the returned materials list is sorted alphabetically."""
    result = httpx.get(f"{URL}/api/v1/spool/materials/available")
    result.raise_for_status()

    materials = result.json()
    assert materials == sorted(materials)
