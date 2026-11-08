"""Tests for scan auto-creation losing a tag-link race."""

import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock, call

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
    send = AsyncMock()
    relay = ScanRelay()
    monkeypatch.setattr(tag.tag_db, "find_by_uid", find)
    monkeypatch.setattr(tag.tag_db, "create_spool_from_decoded_tag", create)
    monkeypatch.setattr(tag, "_decode_payload", lambda *_args: DecodedTag(material_class="FFF"))
    monkeypatch.setattr(tag.scan_websocket_manager, "send", send)
    monkeypatch.setattr(tag, "scan_relay", relay)

    db = AsyncMock(spec=AsyncSession)
    response = await tag.scan(
        request=Request({"type": "http", "client": ("127.0.0.1", 1234)}),
        db=db,
        body=tag.TagScanParameters(uid="04:a2:b3:c4", reader_id="race", create=True),
    )

    payload = json.loads(response.body)
    assert response.status_code == 200
    assert payload["created"] is False
    assert payload["matched_spool_id"] == (8 if winner == "spool" else None)
    assert payload["matched_filament_id"] == (7 if winner == "filament" else None)
    assert payload.get("spool", {}).get("id") == (8 if winner == "spool" else None)
    assert payload.get("filament", {}).get("id") == (7 if winner == "filament" else None)
    assert find.await_args_list == [call(db, "04A2B3C4"), call(db, "04A2B3C4")]
    create.assert_awaited_once()
    send.assert_awaited_once()
    assert send.await_args.args[0] == ("race",)
    event = send.await_args.args[1]
    assert event.payload.created is False
    assert event.payload.matched_spool_id == payload["matched_spool_id"]
    assert event.payload.matched_filament_id == payload["matched_filament_id"]
    assert (event.payload.spool.id if event.payload.spool else None) == payload["matched_spool_id"]
    assert (event.payload.filament.id if event.payload.filament else None) == payload["matched_filament_id"]
