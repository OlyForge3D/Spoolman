"""Verify when CI publishes to the optional secondary container registry."""

import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "configure-remote-registry.sh"
REGISTRY = {
    "REMOTE_REGISTRY_URL": "registry.example",
    "REMOTE_REGISTRY_NAMESPACE": "example",
    "REMOTE_REGISTRY_REPOSITORY": "spoolman",
    "REMOTE_REGISTRY_USERNAME": "test-user",
    "REMOTE_REGISTRY_PASSWORD": "test-password",
}


@pytest.mark.parametrize("ref", ["refs/heads/master", "refs/heads/feature", "refs/tags/v1.2.3"])
def test_unconfigured_registry_publishes_to_ghcr_only(tmp_path: Path, ref: str) -> None:
    output = tmp_path / "output"
    output.touch()
    result = subprocess.run(
        ["/bin/bash", str(SCRIPT)],
        env={"GITHUB_REF": ref, "GITHUB_OUTPUT": str(output)},
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0
    assert "publishing only to GHCR" in result.stdout
    assert output.read_text() == ""


@pytest.mark.parametrize(
    ("ref", "expected_output"),
    [("refs/heads/master", "enabled=true\n"), ("refs/tags/v1.2.3", "enabled=true\n"), ("refs/heads/feature", "")],
)
def test_complete_configuration_publishes_only_release_refs(tmp_path: Path, ref: str, expected_output: str) -> None:
    output = tmp_path / "output"
    output.touch()
    result = subprocess.run(
        ["/bin/bash", str(SCRIPT)],
        env={"GITHUB_REF": ref, "GITHUB_OUTPUT": str(output), **REGISTRY},
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0
    assert output.read_text() == expected_output
    assert REGISTRY["REMOTE_REGISTRY_PASSWORD"] not in result.stdout


@pytest.mark.parametrize("missing", list(REGISTRY))
def test_partial_configuration_fails_explicitly(tmp_path: Path, missing: str) -> None:
    output = tmp_path / "output"
    output.touch()
    settings = {key: value for key, value in REGISTRY.items() if key != missing}
    result = subprocess.run(
        ["/bin/bash", str(SCRIPT)],
        env={"GITHUB_REF": "refs/heads/master", "GITHUB_OUTPUT": str(output), **settings},
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0
    assert "::error::Secondary registry configuration is incomplete" in result.stdout
    assert output.read_text() == ""
    assert REGISTRY["REMOTE_REGISTRY_PASSWORD"] not in result.stdout
