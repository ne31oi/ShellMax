"""Golden graph parity and streaming/output contracts for DLSS5."""
import json

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app import settings
from app.workflow import dlss5
from app.workflow.builder_dlss5 import build_dlss5_prompt


def test_matches_every_golden_link_and_value():
    golden = json.loads((settings.ROOT / "workflows/ShellMax_DLSS5.json").read_text(encoding="utf-8"))
    d = settings.defaults()["dlss5"]
    full = dlss5.DLSS5Full(source_path="SOURCE.mp4", controls=d["controls"], **d["encoding"])
    assert build_dlss5_prompt(full) == golden
    assert d["ui"] == {"mode": golden["1"]["inputs"]["upscaling_mode"],
                       "style": golden["1"]["inputs"]["nr_style"], "intensity": golden["1"]["inputs"]["nr_intensity"]}


def test_queue_prefix_and_changed_controls():
    full = dlss5.DLSS5Full(source_path="F:/clip.mp4", filename_prefix="ShellMax/dlss500123",
                          controls={"upscaling_mode": "2x (Performance)", "nr_intensity": 0.65})
    g = build_dlss5_prompt(full)
    assert g["2"]["inputs"]["filename_prefix"] == "dlss500123"
    assert g["2"]["inputs"]["output_directory"] == "ShellMax"
    assert g["2"]["inputs"]["video_path"] == full.source_path
    assert g["1"]["inputs"]["nr_intensity"] == 0.65
    assert g["2"]["inputs"]["copy_audio"] is True
    assert g["2"]["inputs"]["verify_neural_rendering"] is True
    assert g["4"]["inputs"]["filenames"] == ["3", 0]


def test_unavailable_runtime_cannot_be_queued(monkeypatch):
    monkeypatch.setattr(dlss5, "source_asset", lambda *args: object())
    monkeypatch.setattr(dlss5, "readiness", lambda: (False, "Runtime не установлен"))
    with pytest.raises(HTTPException, match="Runtime"):
        dlss5.expand(dlss5.DLSS5UI(source_asset_id=1), 1)


@pytest.mark.parametrize("values", [{"mode": "4x"}, {"intensity": 2}, {"intensity": -1}, {"style": "bad"}])
def test_invalid_controls(values):
    with pytest.raises(ValidationError):
        dlss5.DLSS5UI(source_asset_id=1, **values)
