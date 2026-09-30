"""SAM recipe parity, source alignment and artifact confinement."""

import json
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app import mask_tracking
from app.jobs.registry import HANDLERS
from app.jobs.pipelines import PIPELINES
from app.jobs.errors import humanize_error
from app.workflow.builder_mask_track import build_mask_track_prompt
from app.workflow.fantastic import AutoMaskLayer, MaskTrackFull, MaskTrackUI, MediaSource


def test_sam_workflow_parity_and_registry():
    full = MaskTrackFull(sources=[MediaSource(path="__PATH__", file="__SOURCE__", kind="video")],
                         model_path="__SAM_MODEL__", start=0, end=2, text="person",
                         points=[{"time": 0, "positive": [{"x": 0.5, "y": 0.5}]}])
    expected = json.loads((Path(__file__).resolve().parents[2] / "workflows/ShellMax_MaskTrack.api.json").read_text())
    actual = build_mask_track_prompt(full)
    assert actual == expected
    assert HANDLERS["mask_track"].build(full) == expected
    pipe = PIPELINES["mask_track"]
    assert pipe.final_node in actual and pipe.stage_by_node[pipe.final_node] in pipe.stage_start
    assert HANDLERS["mask_track"].free_before


@pytest.mark.parametrize("changes", [
    {}, {"text": "   "}, {"start": 2, "end": 1, "text": "car"},
    {"points": [{"time": 2, "positive": [{"x": 0.5, "y": 0.5}]}]},
    {"points": [{"time": 0, "positive": [{"x": 2, "y": 0.5}]}]},
    {"text": "car", "points": [{"time": 1}, {"time": 0}]},
    {"text": "car", "points": [{"time": 0, "negative": [{"x": 0, "y": 0}]}]},
])
def test_selection_rejects_empty_outside_or_unordered_points(changes):
    with pytest.raises(ValidationError):
        MaskTrackUI(source_asset_id=1, **{"end": 2, **changes})


def test_source_time_is_kept_when_tracking_trim():
    ui = MaskTrackUI(source_asset_id=1, start=4, end=6, points=[{
        "time": 5, "positive": [{"x": 0.4, "y": 0.3}], "negative": [{"x": 0.1, "y": 0.1}]}])
    assert ui.points[0].time == 5


def test_sam_missed_object_has_actionable_russian_error():
    code, message = humanize_error("ValueError", "SAM found nothing at the dots on frame 4", "ShellMaxH3ObjectMask")
    assert code == "generic" and "зелёную точку" in message and "повторите трекинг" in message


@pytest.mark.parametrize("name", ["../mask.safetensors [input]", "F:/outside.safetensors [input]",
                                  "minimax_h3/masks/../other.safetensors [input]", "minimax_h3/masks/ok.png [input]"])
def test_masks_cannot_escape_engine_input(name):
    with pytest.raises(HTTPException):
        mask_tracking.resolve_mask(name)


def test_auto_mask_requires_completed_tracking_of_same_clip(monkeypatch):
    row = SimpleNamespace(kind="mask_track", status="done", source_asset_id=7,
                          info={"mask": {"file": "minimax_h3/masks/mask.safetensors [input]"}})
    @contextmanager
    def session():
        yield SimpleNamespace(get=lambda cls, gid: row if gid == 10 else None)
    monkeypatch.setattr(mask_tracking, "session", session)
    monkeypatch.setattr(mask_tracking, "resolve_mask", lambda name: Path(name))
    layer = AutoMaskLayer(result=row.info["mask"]["file"], track_generation_id=10)
    mask_tracking.validate_auto_layers(7, [layer])
    for asset_id, changed in [(8, layer), (7, layer.model_copy(update={"result": "other"})),
                              (7, layer.model_copy(update={"track_generation_id": 11}))]:
        with pytest.raises(HTTPException):
            mask_tracking.validate_auto_layers(asset_id, [changed])
    row.status = "running"
    with pytest.raises(HTTPException):
        mask_tracking.validate_auto_layers(7, [layer])
