"""HTTP tag contracts against a disposable, file-backed SQLite database."""

import base64
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from spoolman.api.v1 import filament, spool, tag
from spoolman.database import models
from spoolman.database.database import get_db_session
from spoolman.tags import decode as tag_decode

UID = "E0040108662F6FBC"


@asynccontextmanager
async def tag_client(path: Path) -> AsyncIterator[httpx.AsyncClient]:
    """Reopen the database and build the real routes, without global startup services."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(models.Base.metadata.create_all)
        sessions = async_sessionmaker(engine, expire_on_commit=False)

        async def session() -> AsyncIterator:
            async with sessions() as db:
                yield db

        app = FastAPI()
        for router in (filament.router, spool.router, tag.router):
            app.include_router(router, prefix="/api/v1")
        app.dependency_overrides[get_db_session] = session
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            yield client
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_uid_contract_survives_database_reopen(tmp_path: Path):
    """Lookup never writes; explicit links persist and conflicts never move a tag."""
    path = tmp_path / "tags.db"
    async with tag_client(path) as client:
        created = await client.post("/api/v1/filament", json={"density": 1.24, "diameter": 1.75})
        assert created.status_code == 200
        filament_id = created.json()["id"]
        created = await client.post("/api/v1/spool", json={"filament_id": filament_id})
        assert created.status_code == 200
        spool_id = created.json()["id"]
        target = f"/api/v1/spool/{spool_id}/tag"
        other = f"/api/v1/filament/{filament_id}/tag"

        unknown = await client.post("/api/v1/tag/scan", json={"uid": UID})
        assert unknown.status_code == 200
        assert unknown.json()["matched_spool_id"] is None
        assert unknown.json()["matched_filament_id"] is None
        assert unknown.json()["created"] is False
        assert (await client.get(f"/api/v1/spool/{spool_id}")).json()["tags"] == []

        spelling = "e0:04:01:08:66:2f:6f:bc"
        for _ in range(2):
            linked = await client.post(target, json={"uid": spelling})
            assert linked.status_code == 201
            assert linked.json()["uid"] == UID
        conflict = await client.post(other, json={"uid": UID})
        assert conflict.status_code == 409
        assert conflict.json()["spool_id"] == spool_id
        assert len((await client.get(f"/api/v1/spool/{spool_id}")).json()["tags"]) == 1

    # A new engine and app must resolve the link without any process-local identity state.
    async with tag_client(path) as client:
        match = (await client.post("/api/v1/tag/scan", json={"uid": spelling})).json()
        assert match["matched_spool_id"] == spool_id
        assert match["spool"]["filament"]["id"] == filament_id
        assert match["matched_filament_id"] is None
        reversed_uid = bytes.fromhex(UID)[::-1].hex()
        reversed_scan = (await client.post("/api/v1/tag/scan", json={"uid": reversed_uid})).json()
        assert reversed_scan["matched_spool_id"] is None

        assert (await client.delete(f"{target}/{spelling}")).status_code == 204
        assert (await client.post(other, json={"uid": UID})).status_code == 201
        conflict = await client.post(target, json={"uid": spelling})
        assert conflict.status_code == 409
        assert conflict.json()["filament_id"] == filament_id

    async with tag_client(path) as client:
        match = (await client.post("/api/v1/tag/scan", json={"uid": UID})).json()
        assert match["matched_filament_id"] == filament_id
        assert match["filament"]["id"] == filament_id
        assert match["matched_spool_id"] is None
        assert (await client.delete(f"{other}/{UID}")).status_code == 204

    async with tag_client(path) as client:
        match = (await client.post("/api/v1/tag/scan", json={"uid": UID})).json()
        assert match["matched_spool_id"] is None
        assert match["matched_filament_id"] is None
        assert (await client.get("/api/v1/spool")).headers["x-total-count"] == "1"
        assert (await client.get("/api/v1/filament")).headers["x-total-count"] == "1"


@pytest.mark.asyncio
@pytest.mark.parametrize(("uid", "status"), [("", 422), ("ABC", 400), ("GG", 400), (":- ", 400), ("AB" * 33, 400)])
async def test_invalid_uid_rejected_without_database_mutation(tmp_path: Path, uid: str, status: int):
    async with tag_client(tmp_path / "tags.db") as client:
        response = await client.post("/api/v1/tag/scan", json={"uid": uid, "create": True})
        assert response.status_code == status
        assert (await client.get("/api/v1/spool")).json() == []
        assert (await client.get("/api/v1/filament")).json() == []


def official_payload() -> bytes:
    """Extract the independently specified MIME payload from Prusa's 01_data.bin."""
    raw = (Path(__file__).parent / "fixtures/openprinttag/prusa_test01_data.bin").read_bytes()
    assert raw[35:38] == bytes.fromhex("521cf5")
    assert raw[38:66] == b"application/vnd.openprinttag"
    return raw[66:311]


@pytest.mark.asyncio
async def test_payload_enrichment_and_explicit_creation_are_separate(tmp_path: Path):
    async with tag_client(tmp_path / "tags.db") as client:
        body = {"uid": UID, "format": "openprinttag", "payload_b64": base64.b64encode(official_payload()).decode()}
        response = await client.post("/api/v1/tag/scan", json=body)
        assert response.status_code == 200
        decoded = response.json()["decoded"]
        assert decoded["name"] == "PLA Prusa Galaxy Black"
        assert decoded["material"] == "PLA"
        assert decoded["vendor_name"] == "Prusament"
        assert decoded["instance_uuid"] == "bf63e92d-9ca5-53d7-9fab-ffdd0240c585"
        assert response.json()["matched_spool_id"] is None
        assert response.json()["created"] is False
        assert (await client.get("/api/v1/spool")).json() == []
        assert (await client.get("/api/v1/filament")).json() == []

        created = await client.post("/api/v1/tag/scan", json={**body, "create": True})
        assert created.status_code == 200
        assert created.json()["created"] is True
        spool_id = created.json()["matched_spool_id"]
        for payload in [body["payload_b64"], "not-base64", base64.b64encode(b"\xa0").decode()]:
            scan = await client.post("/api/v1/tag/scan", json={**body, "payload_b64": payload, "create": True})
            assert scan.status_code == 200
            assert scan.json()["matched_spool_id"] == spool_id
            assert scan.json()["created"] is False
        assert (await client.get("/api/v1/spool")).headers["x-total-count"] == "1"
        assert (await client.get("/api/v1/filament")).headers["x-total-count"] == "1"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload", [b"\xa0", b"\xa0\xa1\x08", b'{"type":"OpenPrintTag"}', b"\x00", b"\xa0\xd8\x1c\xa0"]
)
async def test_failed_enrichment_never_creates_inventory(tmp_path: Path, payload: bytes):
    async with tag_client(tmp_path / "tags.db") as client:
        response = await client.post(
            "/api/v1/tag/scan",
            json={
                "uid": UID,
                "format": "openprinttag",
                "payload_b64": base64.b64encode(payload).decode(),
                "create": True,
            },
        )
        assert response.status_code == 200
        assert response.json()["created"] is False
        assert response.json()["matched_spool_id"] is None
        assert "decoded" not in response.json()
        assert (await client.get("/api/v1/spool")).json() == []
        assert (await client.get("/api/v1/filament")).json() == []


@pytest.mark.asyncio
async def test_payload_cannot_replace_filament_link(tmp_path: Path):
    async with tag_client(tmp_path / "tags.db") as client:
        filament_id = (await client.post("/api/v1/filament", json={"density": 1.24, "diameter": 1.75})).json()["id"]
        assert (await client.post(f"/api/v1/filament/{filament_id}/tag", json={"uid": UID})).status_code == 201
        response = await client.post(
            "/api/v1/tag/scan",
            json={
                "uid": UID,
                "format": "openprinttag",
                "payload_b64": base64.b64encode(official_payload()).decode(),
                "create": True,
            },
        )
        assert response.status_code == 200
        assert response.json()["matched_filament_id"] == filament_id
        assert response.json()["matched_spool_id"] is None
        assert response.json()["created"] is False
        assert (await client.get("/api/v1/spool")).json() == []
        assert (await client.get("/api/v1/filament")).headers["x-total-count"] == "1"


@pytest.mark.asyncio
async def test_malformed_record_after_opt_cannot_create_inventory(tmp_path: Path):
    memory = bytearray((Path(__file__).parent / "fixtures/openprinttag/prusa_test01_data.bin").read_bytes())
    memory[35] &= ~0x40  # OPT record no longer ends the message.
    memory[6:8] = (303 + 4).to_bytes(2, "big")
    memory[311:311] = b"\x56\x00\x01\x00"  # stray continuation after a valid OPT record
    async with tag_client(tmp_path / "tags.db") as client:
        body = {"uid": UID, "format": "openprinttag", "payload_b64": base64.b64encode(memory).decode(), "create": True}
        response = await client.post("/api/v1/tag/scan", json=body)
        assert response.status_code == 200
        assert "decoded" not in response.json()
        assert response.json()["created"] is False
        assert (await client.get("/api/v1/spool")).json() == []
        assert (await client.get("/api/v1/filament")).json() == []

        filament_id = (await client.post("/api/v1/filament", json={"density": 1.24, "diameter": 1.75})).json()["id"]
        assert (await client.post(f"/api/v1/filament/{filament_id}/tag", json={"uid": UID})).status_code == 201
        response = await client.post("/api/v1/tag/scan", json=body)
        assert response.json()["matched_filament_id"] == filament_id
        assert response.json()["created"] is False
        assert "decoded" not in response.json()


@pytest.mark.asyncio
async def test_actual_swift_writer_payload_through_codec_and_scan(tmp_path: Path):
    fixture = json.loads((Path(__file__).parent / "fixtures/openprinttag/printfarmer_swift_pla.json").read_text())
    raw = bytes.fromhex(fixture["payload_hex"])
    assert base64.b64decode(fixture["payload_b64"], validate=True) == raw
    decoded = tag_decode.decode("openprinttag", raw, bytes.fromhex(fixture["uid"]))
    assert decoded is not None
    for field, value in fixture["decoded"].items():
        assert getattr(decoded, field) == value
    assert decoded.weight is None  # The writer provides actual, not nominal, weight.

    path = tmp_path / "swift-tags.db"
    body = {"uid": fixture["uid"], "format": "openprinttag", "payload_b64": fixture["payload_b64"]}
    async with tag_client(path) as client:
        plain = await client.post("/api/v1/tag/scan", json=body)
        assert plain.status_code == 200
        assert plain.json()["decoded"] == fixture["decoded"]
        assert plain.json()["matched_spool_id"] is None
        assert plain.json()["created"] is False
        assert (await client.get("/api/v1/spool")).json() == []
        assert (await client.get("/api/v1/filament")).json() == []

        created = await client.post("/api/v1/tag/scan", json={**body, "create": True})
        assert created.status_code == 200
        assert created.json()["created"] is True
        spool_id = created.json()["matched_spool_id"]
        spool_data = created.json()["spool"]
        assert spool_data["initial_weight"] == 1000
        assert spool_data["spool_weight"] == 200
        assert spool_data["filament"]["material"] == "PLA"
        assert spool_data["filament"]["color_hex"] == "FF0000"
        assert spool_data["filament"]["density"] == 1.24
        assert spool_data["filament"]["diameter"] == 1.75
        assert spool_data["filament"].get("weight") is None

    async with tag_client(path) as client:
        # A conflicting payload enriches the response, not the authoritative linked row.
        original = (await client.get(f"/api/v1/spool/{spool_id}")).json()
        enriched = await client.post(
            "/api/v1/tag/scan",
            json={**body, "create": True, "payload_b64": base64.b64encode(official_payload()).decode()},
        )
        assert enriched.status_code == 200
        assert enriched.json()["matched_spool_id"] == spool_id
        assert enriched.json()["created"] is False
        assert enriched.json()["decoded"]["name"] == "PLA Prusa Galaxy Black"
        assert (await client.get(f"/api/v1/spool/{spool_id}")).json() == original
        again = await client.post("/api/v1/tag/scan", json={**body, "create": True})
        assert again.json()["matched_spool_id"] == spool_id
        assert again.json()["created"] is False
        assert (await client.get("/api/v1/spool")).headers["x-total-count"] == "1"
        assert (await client.get("/api/v1/filament")).headers["x-total-count"] == "1"
