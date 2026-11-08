"""Tests for the Prometheus metrics refresh dropping spools and filaments that are gone."""

from datetime import datetime, timezone

import pytest
from prometheus_client import CollectorRegistry, Gauge
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.pool import StaticPool

from spoolman.database import models
from spoolman.prometheus.metrics import _publish, filament_metrics, registry, spool_metrics


async def refresh(engine: AsyncEngine) -> None:
    """Run one metrics refresh in a fresh session, the way the scheduler does."""
    async with AsyncSession(engine) as db:
        await filament_metrics(db)
        await spool_metrics(db)


def used(spool_id: int, filament_id: int) -> float | None:
    """Return a spool's exported used weight, or None if it is not exported."""
    labels = {"spool_id": str(spool_id), "filament_id": str(filament_id)}
    return registry.get_sample_value("spoolman_spool_weight_used", labels)


def density(filament_id: int) -> float | None:
    """Return a filament's exported density, or None if it is not exported."""
    return registry.get_sample_value("spoolman_filament_density", {"filament_id": str(filament_id)})


def info(filament_id: int, name: str) -> float | None:
    """Return a vendorless filament's exported info sample, or None if it is not exported."""
    labels = {"filament_id": str(filament_id), "vendor": "-", "name": name, "material": "None", "color": "None"}
    return registry.get_sample_value("spoolman_filament_info", labels)


def test_publish_normalized_collisions_preserve_last_value() -> None:
    local_registry = CollectorRegistry()
    gauge = Gauge("test_label_normalization", "Test label normalization", ["name"], registry=local_registry)

    _publish(gauge, {(None,): 1, ("None",): 2})
    assert local_registry.get_sample_value("test_label_normalization", {"name": "None"}) == 2
    _publish(gauge, {("None",): 3, (None,): 4})
    assert local_registry.get_sample_value("test_label_normalization", {"name": "None"}) == 4

    _publish(gauge, {})
    assert local_registry.get_sample_value("test_label_normalization", {"name": "None"}) is None


@pytest.mark.asyncio
@pytest.mark.parametrize(("first", "second"), [(None, "None"), ("None", None)])
async def test_filament_refresh_compares_labels_as_prometheus_strings(first: str | None, second: str | None) -> None:
    engine = create_async_engine("sqlite+aiosqlite://", poolclass=StaticPool)
    async with engine.begin() as conn:
        await conn.run_sync(models.Base.metadata.create_all)

    now = datetime(2026, 1, 1, tzinfo=timezone.utc).replace(tzinfo=None)
    async with AsyncSession(engine, expire_on_commit=False) as db:
        filament = models.Filament(registered=now, name="Original", material=first, density=1.24, diameter=1.75)
        db.add(filament)
        await db.commit()
        filament_id = filament.id

    await refresh(engine)
    assert info(filament_id, "Original") == 1

    async with AsyncSession(engine) as db:
        filament = await db.get(models.Filament, filament_id)
        filament.material = second
        await db.commit()

    await refresh(engine)
    assert info(filament_id, "Original") == 1

    async with AsyncSession(engine) as db:
        filament = await db.get(models.Filament, filament_id)
        filament.name = "Renamed"
        await db.commit()

    await refresh(engine)
    assert info(filament_id, "Original") is None
    assert info(filament_id, "Renamed") == 1

    async with AsyncSession(engine) as db:
        await db.delete(await db.get(models.Filament, filament_id))
        await db.commit()

    await refresh(engine)
    assert info(filament_id, "Renamed") is None
    await engine.dispose()


@pytest.mark.asyncio
async def test_refresh_drops_archived_and_deleted() -> None:
    """Archived and deleted spools, and deleted filaments, stop being exported on the next refresh."""
    engine = create_async_engine("sqlite+aiosqlite://", poolclass=StaticPool)
    async with engine.begin() as conn:
        await conn.run_sync(models.Base.metadata.create_all)

    now = datetime(2026, 1, 1, tzinfo=timezone.utc).replace(tzinfo=None)  # stored naive, as UTC
    async with AsyncSession(engine, expire_on_commit=False) as db:
        kept = models.Filament(registered=now, name="Kept", density=1.24, diameter=1.75)
        gone = models.Filament(registered=now, name="Gone", density=1.27, diameter=1.75)
        spools = [models.Spool(filament=kept, registered=now, used_weight=w) for w in (10, 20, 30)]
        db.add_all([kept, gone, *spools])
        await db.commit()

    await refresh(engine)
    assert [used(s.id, kept.id) for s in spools] == [10, 20, 30]
    assert density(gone.id) == 1.27
    assert info(gone.id, "Gone") == 1

    async with AsyncSession(engine) as db:
        (await db.get(models.Spool, spools[1].id)).archived = True
        await db.delete(await db.get(models.Spool, spools[2].id))
        await db.delete(await db.get(models.Filament, gone.id))
        await db.commit()

    await refresh(engine)
    assert [used(s.id, kept.id) for s in spools] == [10, None, None]
    assert density(kept.id) == 1.24
    assert density(gone.id) is None
    assert info(kept.id, "Kept") == 1
    assert info(gone.id, "Gone") is None

    await engine.dispose()
