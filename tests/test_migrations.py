"""Exercise upgrades across the fork's GTIN and upstream tag migration branches."""

import sqlite3
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory

ROOT = Path(__file__).resolve().parents[1]
COMMON_REVISION = "9c1d5f2a7b31"
GTIN_REVISION = "c3a7e1f95d02"
TAG_REVISION = "fe4970567bb3"


@pytest.mark.parametrize("existing_revision", ["fresh", COMMON_REVISION, GTIN_REVISION, TAG_REVISION])
def test_upgrade_merges_gtin_and_tag_migrations(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    existing_revision: str,
) -> None:
    for key in (
        "SPOOLMAN_DB_HOST",
        "SPOOLMAN_DB_PORT",
        "SPOOLMAN_DB_NAME",
        "SPOOLMAN_DB_QUERY",
        "SPOOLMAN_DB_USERNAME",
        "SPOOLMAN_DB_PASSWORD",
        "SPOOLMAN_DB_PASSWORD_FILE",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("SPOOLMAN_DB_TYPE", "sqlite")
    monkeypatch.setenv("SPOOLMAN_DIR_DATA", str(tmp_path))

    config = Config()
    config.set_main_option("script_location", str(ROOT / "migrations"))
    head = ScriptDirectory.from_config(config).get_current_head()
    assert head is not None

    database = tmp_path / "spoolman.db"
    if existing_revision != "fresh":
        command.upgrade(config, COMMON_REVISION)
        with sqlite3.connect(database) as connection:
            connection.execute(
                "INSERT INTO filament (id, name, density, diameter, article_number) VALUES (?, ?, ?, ?, ?)",
                (1, "Existing filament", 1.24, 1.75, "4006381333931"),
            )
        if existing_revision != COMMON_REVISION:
            command.upgrade(config, existing_revision)

    command.upgrade(config, "head")

    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT version_num FROM alembic_version").fetchall() == [(head,)]
        assert connection.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tag'").fetchone()
        assert "gtin" in {row[1] for row in connection.execute("PRAGMA table_info(filament)")}
        assert "ix_filament_gtin" in {row[1] for row in connection.execute("PRAGMA index_list(filament)")}
        if existing_revision != "fresh":
            assert connection.execute("SELECT article_number, gtin FROM filament WHERE id = 1").fetchone() == (
                "4006381333931",
                "04006381333931",
            )
