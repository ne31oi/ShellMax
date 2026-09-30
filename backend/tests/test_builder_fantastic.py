"""Frozen recipes plus mask/label invariants for Fantastic integration."""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.jobs.registry import HANDLERS
from app.jobs.pipelines import PIPELINES
from app.refmods import resolve_member, collect_output
from app.workflow.builder_refmods import BASE_BUILDERS, build_refmod_prompt
from app.workflow.builder_refmod_create import build_create_refmod_prompt
from app.workflow.builder_mask_edit import build_mask_edit_prompt
from app.workflow.fantastic import MaskEditFull, MaskEditUI, MaskLayer, MediaSource, RefModCreateFull
from app.workflow.params import ResolvedRef
from test_builder import default_params

ROOT = Path(__file__).resolve().parents[2]
PIPELINE_NAMES = {"generate": "Standard", "generate_nvfp4": "NVFP4", "generate_nvfp4_fast": "NVFP4_Fast"}


def refmod_params():
    return default_params(nvfp4_unet="__NVFP4_UNET__", refs=[
        ResolvedRef(kind="image", comfy_name="__IMAGE__"),
        ResolvedRef(kind="video", refmod_file="ShellMax/example_visual", strength=0.75),
        ResolvedRef(kind="audio", refmod_file="ShellMax/example_audio")])


def mask_params(pipeline="generate", keep_audio=True):
    return MaskEditFull(base=refmod_params(), pipeline=pipeline,
        sources=[MediaSource(path="__SOURCE_PATH__", file="__SOURCE__", kind="video", has_audio=True)],
        layers=[MaskLayer(kind="ellipse", keys=[{"t": 0, "x": 0.5, "y": 0.5, "w": 0.4, "h": 0.6}])],
        end=56 / 24, frames=56, seed=252257667695918, keep_audio=keep_audio)


def create_params():
    p = refmod_params()
    return RefModCreateFull(sources=[MediaSource(path="__PATH__", file="__SOURCE__", kind="picture")],
        name="example", label="Example", vae_video=p.vae_video, vae_audio=p.vae_audio)


@pytest.mark.parametrize("pipeline", PIPELINE_NAMES)
def test_refmod_workflow_parity(pipeline):
    expected = json.loads((ROOT / "workflows" / f"ShellMax_RefMods_{PIPELINE_NAMES[pipeline]}.api.json").read_text())
    assert build_refmod_prompt(refmod_params(), pipeline) == expected


@pytest.mark.parametrize("pipeline", PIPELINE_NAMES)
def test_mask_workflow_parity(pipeline):
    expected = json.loads((ROOT / "workflows" / f"ShellMax_MaskEdit_{PIPELINE_NAMES[pipeline]}.api.json").read_text())
    assert build_mask_edit_prompt(mask_params(pipeline)) == expected


def test_create_workflow_parity():
    expected = json.loads((ROOT / "workflows" / "ShellMax_RefMod_Create.api.json").read_text())
    assert build_create_refmod_prompt(create_params()) == expected


@pytest.mark.parametrize("pipeline", PIPELINE_NAMES)
def test_refmods_preserve_sampling_and_models(pipeline):
    p = refmod_params()
    ordinary = BASE_BUILDERS[pipeline](p.model_copy(update={"refs": [p.refs[0]]}))
    actual = build_refmod_prompt(p, pipeline)
    for nid in ordinary:
        if nid not in ("56", "108"):
            assert actual[nid] == ordinary[nid]
    assert actual["108"]["inputs"] == {**ordinary["108"]["inputs"], "latent_image": ["56", 2]}
    state = json.loads(actual["refmod_stack"]["inputs"]["stack_state"])
    assert state["picks"][0]["visual"]["w"] == 0.75


def test_mask_cannot_lose_noise_mask_to_dual_sampling():
    graph = build_mask_edit_prompt(mask_params())
    assert graph["108"]["inputs"]["latent_image"] == ["56", 2]
    assert graph["141"]["inputs"]["images"] == ["composite", 0]
    assert graph["141"]["inputs"]["audio"] == ["edit_bundle", 1]
    assert "124" not in graph and "128" not in graph and "106" not in graph
    assert graph["71"]["inputs"]["denoise"] == 0.8
    generated = build_mask_edit_prompt(mask_params(keep_audio=False))
    assert generated["141"]["inputs"]["audio"] == ["110", 0]


def test_all_new_kinds_have_recipes_and_pipelines():
    for kind in ("refmod_create", "mask_edit", *(key + "_refmods" for key in PIPELINE_NAMES)):
        handler = HANDLERS[kind]
        pipe = PIPELINES[kind]
        p = create_params() if kind == "refmod_create" else mask_params() if kind == "mask_edit" else refmod_params()
        assert pipe.final_node in handler.build(p)
        assert pipe.stage_by_node[pipe.final_node] in pipe.stage_start


def test_mask_rejects_duplicate_keys_and_unbounded_geometry():
    key = {"t": 1, "x": 0.5, "y": 0.5, "w": 0.3, "h": 0.3}
    with pytest.raises(ValidationError):
        MaskLayer(keys=[key, key])
    with pytest.raises(ValidationError):
        MaskLayer(keys=[{**key, "w": 3}])
    with pytest.raises(ValidationError):
        MaskEditUI(source_asset_id=1, prompt="Edit", layers=[])


@pytest.mark.parametrize("name", ["../other", "F:/outside", "/outside", "..\\other"])
def test_refmod_paths_are_confined(name):
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        resolve_member(name)


def test_refmod_artifact_cannot_report_another_jobs_files(monkeypatch):
    from types import SimpleNamespace
    monkeypatch.setattr("app.refmods.resolve_member", lambda name: Path(name))
    g = SimpleNamespace(full_params={"name": "example"})
    assert collect_output(g, {"refmod_saved": ["ShellMax/other.safetensors"]}) is None
    assert collect_output(g, {"refmod_saved": ["ShellMax/example_visual.safetensors", "ShellMax/example.png"]}) == {
        "refmods": ["ShellMax/example_visual"]}
