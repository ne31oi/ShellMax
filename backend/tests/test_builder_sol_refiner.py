"""The SoL graph must match its workflow; source frames must survive temporal padding."""
import importlib.util
import json
from pathlib import Path
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app import sol_refiner_jobs
from app import asset_sources
from app.db.models import Generation, MediaAsset
from app.jobs.errors import humanize_error
from app.jobs.registry import get_handler, pipeline_for
from app.workflow.builder_sol_refiner import build_sol_refiner_prompt
from app.workflow.sol_refiner import SoLRefinerFull, output_size, padded_frames, config
from app.workflow import sol_refiner

ROOT = Path(__file__).resolve().parents[2]


def test_graph_matches_workflow():
    p = SoLRefinerFull(source_path="F:/clip.mp4", prompt="A woman dancing.", runtime_dir="F:/runtime",
                       width=1920, height=1080)
    golden = json.loads((ROOT / "workflows/ShellMax_SoL_Refiner.json").read_text(encoding="utf-8"))
    expected = {k: v for k, v in golden.items() if not k.startswith("_")}
    expected["1"]["inputs"].update(source_path=p.source_path, prompt=p.prompt, runtime_dir=p.runtime_dir)
    assert build_sol_refiner_prompt(p) == expected
    handler = get_handler("sol_refine")
    assert handler.params_cls is SoLRefinerFull
    assert handler.free_before
    assert pipeline_for(handler.kind).final_node == "1"


def test_output_geometry_preserves_aspect_and_fixed_checkpoint_sigma():
    assert output_size(1280, 720) == (1920, 1080)
    assert output_size(720, 1280) == (1080, 1920)
    assert output_size(1024, 1024) == (1920, 1920)
    assert config()["sigma"] == 0.9093750119


def test_padding_preserves_every_source_frame():
    spec = importlib.util.spec_from_file_location("sol_media", ROOT / "comfy_nodes/shellmax_sol_refiner/media.py")
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    for count in (1, 5, 39, 56, 121, 124):
        frames = list(range(count))
        assert worker.pad_video(frames) == count
        assert len(frames) == padded_frames(count)
        assert (len(frames) - 1) % 8 == 0
        assert frames[:count] == list(range(count))
        assert all(v == count - 1 for v in frames[count:])


def test_partial_checkpoint_never_counts_as_installed(tmp_path, monkeypatch):
    cfg = {"files": {"transformer": {"path": "model.safetensors", "size": 4}}}
    monkeypatch.setattr(sol_refiner, "config", lambda: cfg)
    monkeypatch.setattr(sol_refiner, "runtime_dir", lambda: tmp_path)
    (tmp_path / "installed.json").write_text(json.dumps(cfg))
    model = tmp_path / "model-int8/model.safetensors"
    model.parent.mkdir()
    model.write_bytes(b"123")
    assert not sol_refiner.ready()
    model.write_bytes(b"1234")
    assert sol_refiner.ready()
    (tmp_path / "installed.json").write_text("{}")
    assert not sol_refiner.ready()


def test_prompt_follows_postprocess_ancestry_and_stops_on_cycles(monkeypatch):
    original = SimpleNamespace(generation_id=1)
    processed = SimpleNamespace(generation_id=2)
    rows = {(Generation, 1): SimpleNamespace(kind="sol_refine", ui_params={"prompt": "Original scene"}, source_asset_id=None),
            (Generation, 2): SimpleNamespace(kind="enhance", ui_params={}, source_asset_id=10), (MediaAsset, 10): original}
    @contextmanager
    def session():
        yield SimpleNamespace(get=lambda cls, row_id: rows.get((cls, row_id)))
    monkeypatch.setattr(sol_refiner_jobs, "session", session)
    assert sol_refiner_jobs.inherited_prompt(processed) == "Original scene"
    rows[(Generation, 1)] = SimpleNamespace(kind="sol_refine", ui_params={}, source_asset_id=11)
    rows[(MediaAsset, 11)] = processed
    assert sol_refiner_jobs.inherited_prompt(processed) == ""


def test_h3_instructions_are_not_used_as_refiner_caption(monkeypatch):
    row = SimpleNamespace(kind="generate", ui_params={"prompt": "The woman in <Picture 1>"}, source_asset_id=None)
    @contextmanager
    def session():
        yield SimpleNamespace(get=lambda cls, row_id: row)
    monkeypatch.setattr(sol_refiner_jobs, "session", session)
    assert sol_refiner_jobs.inherited_prompt(SimpleNamespace(generation_id=1)) == ""


def test_source_must_belong_to_project_and_still_exist(tmp_path, monkeypatch):
    video = tmp_path / "source.mp4"
    video.touch()
    asset = SimpleNamespace(kind="video", project_id=4, path=str(video))
    @contextmanager
    def session():
        yield SimpleNamespace(get=lambda cls, row_id: asset)
    monkeypatch.setattr(asset_sources, "session", session)
    assert asset_sources.source_asset(1, 4) is asset
    with pytest.raises(HTTPException) as error:
        sol_refiner_jobs.source_asset(1, 5)
    assert error.value.status_code == 404
    video.unlink()
    with pytest.raises(HTTPException) as error:
        sol_refiner_jobs.source_asset(1, 4)
    assert error.value.status_code == 422


def test_refiner_memory_error_does_not_offer_h3_sampling_changes():
    code, message = humanize_error("OutOfMemoryError", "CUDA out of memory", "ShellMaxSoLRefinerByPath")
    assert code == "generic" and "короткий клип" in message and "SeedVR2" in message


def test_nested_decoder_progress_restores_hook_after_cancellation():
    spec = importlib.util.spec_from_file_location("sol_progress", ROOT / "comfy_nodes/shellmax_sol_refiner/progress.py")
    progress = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(progress)
    original = object()
    utils = SimpleNamespace(PROGRESS_BAR_HOOK=original)
    utils.set_progress_bar_global_hook = lambda hook: setattr(utils, "PROGRESS_BAR_HOOK", hook)
    values = []
    bar = SimpleNamespace(update_absolute=lambda value, total: values.append((value, total)))
    with pytest.raises(RuntimeError):
        with progress.stage_progress(utils, bar, 75, 95):
            utils.PROGRESS_BAR_HOOK(1, 2)
            utils.PROGRESS_BAR_HOOK(2, 2)
            raise RuntimeError("Cancelled")
    assert values == [(85, 100), (95, 100)]
    assert utils.PROGRESS_BAR_HOOK is original
