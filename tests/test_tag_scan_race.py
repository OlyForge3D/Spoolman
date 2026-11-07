"""A concurrent tag link must be returned even when auto-creation loses the race."""

import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest
from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from spoolman.api.v1 import tag
from spoolman.database import models
from spoolman.exceptions import TagConflictError
from spoolman.scanrelay import ScanRelay
from spoolman.tags.decode import DecodedTag


@pytest.mark.asyncio
@pytest.mark.parametrize("winner", ["spool", "filament", "missing"])
async def test_auto_create_conflict_reports_the_actual_winner(monkeypatch: pytest.MonkeyPatch, winner: str) -> None:
    filament = models.Filament(
        id=7,
        registered=datetime(2026, 1, 1, tzinfo=timezone.utc),
        name="PLA",
        density=1.24,
        diameter=1.75,
        vendor=None,
        extra=[],
        tags=[],
    )
    spool = models.Spool(
        id=8,
        registered=datetime(2026, 1, 1, tzinfo=timezone.utc),
        filament=filament,
        used_weight=0,
        extra=[],
        tags=[],
    )
    target = {"spool": spool, "filament": filament, "missing": None}[winner]
    find = AsyncMock(side_effect=[None, target])
    create = AsyncMock(side_effect=TagConflictError("already linked"))
    broadcast = AsyncMock()
    monkeypatch.setattr(tag.tag_db, "find_by_uid", find)
    monkeypatch.setattr(tag.tag_db, "create_spool_from_decoded_tag", create)
    monkeypatch.setattr(tag, "_decode_payload", lambda *_args: DecodedTag(material_class="FFF"))
    monkeypatch.setattr(tag, "_broadcast", broadcast)
    monkeypatch.setattr(tag, "scan_relay", ScanRelay())

    response = await tag.scan(
        request=Request({"type": "http", "client": ("127.0.0.1", 1234)}),
        db=AsyncMock(spec=AsyncSession),
        body=tag.TagScanParameters(uid="04A2B3C4", reader_id="race", create=True),
    )

    payload = json.loads(response.body)
    assert response.status_code == 200
    assert payload["created"] is False
    assert payload["matched_spool_id"] == (8 if winner == "spool" else None)
    assert payload["matched_filament_id"] == (7 if winner == "filament" else None)
    assert find.await_count == 2
    create.assert_awaited_once()
    broadcast.assert_awaited_once()
    event = broadcast.await_args.args[0]
    assert event.matched_spool_id == payload["matched_spool_id"]
    assert event.matched_filament_id == payload["matched_filament_id"]
