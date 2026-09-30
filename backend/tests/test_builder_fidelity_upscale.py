"""Fidelity restoration must not resample video or run generative samplers."""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.workflow import fidelity_upscale as fidelity
from app.workflow.builder_fidelity_upscale import build_fidelity_prompt
from app.jobs.registry import get_handler, pipeline_for
from app import services
from app.db.models import Generation


def test_graph_matches_workflow_and_retains_media_contract():
    p = fidelity.FidelityFull(source_path="F:/source.mp4", model_path="F:/model.pth", frame_rate=29.97,
                             width=896, height=512)
    golden = json.loads((Path(__file__).parents[2] / "workflows/ShellMax_Fidelity_Upscale.json").read_text())
    golden["1"]["inputs"]["video"] = p.source_path
    golden["2"]["inputs"]["model_path"] = p.model_path
    golden["4"]["inputs"]["frame_rate"] = p.frame_rate
    assert build_fidelity_prompt(p) == golden
    assert golden["1"]["inputs"]["force_rate"] == 0
    assert golden["1"]["inputs"]["frame_load_cap"] == 0
    assert golden["4"]["inputs"]["audio"] == ["1", 2]
    assert pipeline_for("fidelity_upscale").final_node == "4"
    assert get_handler("fidelity_upscale").ui_cls is fidelity.FidelityUI


@pytest.mark.parametrize("scale", [1, 2])
def test_expand_preserves_source_and_rejects_missing_model(monkeypatch, scale):
    asset = SimpleNamespace(id=10, project_id=2, path="F:/source.mp4", fps=29.97, duration=1.001,
                            width=896, height=512)
    checked = []
    def source(asset_id, project_id=None):
        checked.append((asset_id, project_id))
        return asset
    monkeypatch.setattr(fidelity, "source_asset", source)
    monkeypatch.setattr(fidelity, "ready", lambda: True)
    g = fidelity.expand(fidelity.FidelityUI(source_asset_id=10, scale=scale), 2)
    assert checked == [(10, 2)]
    assert g.kind == "fidelity_upscale" and g.source_asset_id == 10
    assert g.full_params["frame_rate"] == asset.fps
    assert g.full_params["source_path"] == asset.path
    assert (g.full_params["width"], g.full_params["height"]) == (asset.width * scale, asset.height * scale)
    assert "prompt" not in g.full_params and "strength" not in g.full_params
    monkeypatch.setattr(fidelity, "ready", lambda: False)
    with pytest.raises(HTTPException) as error:
        fidelity.expand(fidelity.FidelityUI(source_asset_id=10), 2)
    assert error.value.status_code == 422


def test_x1_is_default_and_old_jobs_keep_x2_geometry():
    assert fidelity.FidelityUI(source_asset_id=10).scale == fidelity.config()["scale"] == 1
    legacy = fidelity.FidelityFull(source_path="F:/source.mp4", model_path="F:/model.pth", frame_rate=24)
    g = build_fidelity_prompt(legacy)
    assert g["5"]["inputs"]["width"] == g["5"]["inputs"]["height"] == 0
    assert g["5"]["inputs"]["crop"] == "disabled"


@pytest.mark.parametrize("params, expected", [({"source_asset_id": 10}, 2), ({"source_asset_id": 10, "scale": 1}, 1)])
def test_retry_preserves_legacy_and_new_scale(monkeypatch, params, expected):
    received = []
    monkeypatch.setattr(services, "create_asset_job", lambda kind, ui, project_id: received.append(ui) or ui)
    g = Generation(id=99, project_id=2, kind="fidelity_upscale", ui_params=params, full_params={}, seed=0)
    services.recreate_generations(g, same_seed=True)
    assert received[0].scale == expected


def test_partial_download_is_not_ready(tmp_path, monkeypatch):
    model = tmp_path / "model.pth"
    monkeypatch.setattr(fidelity, "model_path", lambda: model)
    monkeypatch.setattr(fidelity, "config", lambda: {"size": 4})
    assert not fidelity.ready()
    model.write_bytes(b"123")
    assert not fidelity.ready()
    model.write_bytes(b"1234")
    assert fidelity.ready()
