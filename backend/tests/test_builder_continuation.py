"""Freeze continuation wiring and verify motion context, AV trim and queue parameter retention."""

import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.workflow.builder_continuation import build_continuation_prompt
from app.workflow.continuation import ContinuationFull, ContinuationUI, frame_plan
from test_builder_pdmd import params as pdmd_params

WORKFLOW = Path(__file__).resolve().parents[2] / "workflows" / "ShellMax_H3_Continuation.api.json"


def params(**over):
    return ContinuationFull(**pdmd_params(duration=73 / 24).model_dump(), source_path="F:/source.mp4",
                            source_skip=34, context_frames=22, added_frames=51, source_audio=True,
                            base_pipeline="generate_pdmd", **over)


@pytest.mark.parametrize("single", [False, True])
def test_every_node_matches_frozen_workflow(single):
    p = params()
    if single:
        p.expert.split_step = 0
    replacements = {"__UNET__": p.unet, "__CLIP__": p.text_encoder, "__VAE_VIDEO__": p.vae_video,
                    "__VAE_AUDIO__": p.vae_audio, "__UPSCALER__": p.upscaler, "__PDMD__": p.pdmd_lora,
                    "__PROMPT__": p.prompt, "__REF_IMAGE__": p.refs[0].comfy_name, "__SOURCE__": p.source_path,
                    "__PREFIX__": p.filename_prefix, "__DRAFT_PREFIX__": p.filename_prefix + "_draft"}
    workflow = WORKFLOW.with_name("ShellMax_H3_Continuation_SinglePass.api.json") if single else WORKFLOW
    expected = json.loads(workflow.read_text(encoding="utf-8"))
    for node in expected.values():
        for key, value in node["inputs"].items():
            if isinstance(value, str):
                node["inputs"][key] = replacements.get(value, value)
    assert build_continuation_prompt(p) == expected


@pytest.mark.parametrize("pipeline", ["generate", "generate_memory", "generate_nvfp4", "generate_pdmd"])
def test_zero_split_samples_only_once_at_final_resolution(pipeline):
    p = params()
    p.base_pipeline = pipeline
    p.nvfp4_unet = "F:/final_nvfp4.safetensors"
    p.expert.split_step = 0
    g = build_continuation_prompt(p)
    assert g["56"]["inputs"]["width"] == 1440
    assert g["56"]["inputs"]["height"] == 832
    assert g["106"]["inputs"]["noise"] == ["63", 0]
    assert g["106"]["inputs"]["sigmas"] == ["94", 0]
    assert g["106"]["inputs"]["latent_image"] == ["continue_prefix", 1]
    assert g["126"]["inputs"]["conditioning"] == ["continue_prefix", 0]
    assert {"108", "128", "124", "135", "continue_prefix_final"}.isdisjoint(g)
    assert g["continue_final"]["inputs"]["audio"] == ["110", 0]


@pytest.mark.parametrize("duration,source,context,want", [
    (2, 56 / 24, 22, (22, 51, 34)), (2, 56 / 24, 39, (39, 51, 17)),
    (2, 2.333333, 22, (22, 51, 34)), (0.2, 0.208333, 22, (5, 17, 0)),
    (2, 10 / 24, 39, (5, 51, 5)), (0.2, 5 / 24, 22, (5, 17, 0)),
    (4, 10, 5, (5, 102, 235)),
])
def test_frame_plan_keeps_last_source_frames_and_returns_only_new_duration(duration, source, context, want):
    assert frame_plan(duration, source, context) == want
    assert (want[0] + want[1]) % 17 == 5


@pytest.mark.parametrize("duration,source", [(2, 4 / 24), (150, 10)])
def test_invalid_temporal_extent_is_rejected(duration, source):
    with pytest.raises(HTTPException):
        frame_plan(duration, source)


@pytest.mark.parametrize("derived", [False, True])
@pytest.mark.parametrize("profile_present", [False, True])
def test_defaults_select_the_source_profile_even_after_post_processing(monkeypatch, derived, profile_present):
    from contextlib import contextmanager
    from types import SimpleNamespace
    from app.db.models import EngineProfileRow, Generation
    from app.workflow.continuation import defaults

    original = SimpleNamespace(id=40, generation_id=30, duration=56 / 24, width=1440, height=832)
    processed = SimpleNamespace(id=41, generation_id=31, duration=56 / 24, width=1440, height=832)
    records = {
        (Generation, 30): SimpleNamespace(id=30, ui_params={"refs": [], "profile_id": 3}, source_asset_id=None),
        (Generation, 31): SimpleNamespace(id=31, ui_params={}, source_asset_id=40),
        (EngineProfileRow, 3): SimpleNamespace(id=3) if profile_present else None,
    }

    @contextmanager
    def stored_records():
        yield SimpleNamespace(get=lambda cls, identifier: records.get((cls, identifier)))

    monkeypatch.setattr("app.db.models.session", stored_records)
    monkeypatch.setattr("app.asset_sources.source_asset", lambda asset_id, _: processed if asset_id == 41 else original)
    result = defaults(41 if derived else 40, 1)
    assert result["params"]["profile_id"] == (3 if profile_present else None)
    assert result["params"]["refs"] == []


@pytest.mark.parametrize("pipeline", ["generate", "generate_memory", "generate_nvfp4", "generate_nvfp4_fast", "generate_pdmd"])
def test_selected_recipe_is_preserved_and_both_passes_get_native_context(pipeline):
    p = params()
    p.base_pipeline = pipeline
    if pipeline != "generate_pdmd":
        from app.workflow.params import ExpertParams
        p.expert = ExpertParams()
    p.nvfp4_unet = "F:/nvfp4.safetensors"
    g = build_continuation_prompt(p)
    assert g["57"]["inputs"]["conditioning"] == ["continue_prefix", 0]
    assert g["108"]["inputs"]["latent_image"] == ["continue_prefix", 1]
    assert g["126"]["inputs"]["conditioning"] == ["continue_prefix_final", 0]
    assert g["106"]["inputs"]["latent_image"] == ["continue_prefix_final", 1]
    assert g["continue_prefix_final"]["inputs"]["latent"] == ["105", 0]
    assert g["continue_prefix_final"]["inputs"]["images"] == ["continue_source", 0]
    assert g["141"]["inputs"]["images"] == ["continue_final", 0]
    assert g["141"]["inputs"]["audio"] == ["continue_final", 1]
    assert g["105"]["inputs"]["audio_latent"] == ["102", 1]


def test_silent_source_does_not_encode_missing_audio():
    p = params()
    p.source_audio = False
    g = build_continuation_prompt(p)
    assert "audio" not in g["continue_prefix"]["inputs"]
    assert "audio" not in g["continue_prefix_final"]["inputs"]


def test_refmods_use_their_latent_output_without_changing_reference_labels():
    p = params()
    p.refs[0].refmod_file = "refmods/identity.safetensors"
    g = build_continuation_prompt(p)
    assert g["56"]["class_type"] == "MiniMaxH3FantasticRefModTextEncode"
    assert g["continue_prefix"]["inputs"]["latent"] == ["56", 2]
    assert g["refmod_stack"]["inputs"]["stack_state"]


def test_queued_continuation_keeps_full_source_parameters():
    from app.jobs.registry import get_handler
    handler = get_handler("continue_video")
    assert handler.upload == "refs" and handler.ui_cls is ContinuationUI
    restored = handler.params_cls(**params().model_dump())
    assert restored.source_skip == 34 and restored.context_frames == 22
    assert restored.model_copy(update={"refs": []}).source_path == "F:/source.mp4"


def test_expansion_keeps_user_recipe_and_accounts_for_context_without_extending_saved_ui(monkeypatch):
    from types import SimpleNamespace
    from app.workflow.continuation import expand
    from app.workflow.pdmd import default_profile
    profile = default_profile()
    profile.expert.steps, profile.expert.split_step = 10, 2
    profile.pdmd_strength, profile.pdmd_sparse = 0.6, True
    monkeypatch.setattr("app.asset_sources.source_asset", lambda *_: SimpleNamespace(
        id=42, path="F:/source.mp4", duration=56 / 24, has_audio=True))
    monkeypatch.setattr("app.services.generation_inputs", lambda *_: (
        SimpleNamespace(name="custom PDMD"), profile, [], []))
    monkeypatch.setattr("app.jobs.estimator.estimate_seconds", lambda *_: 100)
    ui = ContinuationUI(source_asset_id=42, prompt="Continue the camera movement", duration=2, seed=7)
    g = expand(ui, 1)
    p = ContinuationFull(**g.full_params)
    assert g.source_asset_id == 42 and g.seed == 7
    assert g.ui_params["duration"] == 2
    assert p.duration == 73 / 24 and p.added_frames == 51 and p.source_skip == 34
    assert p.expert.steps == 10 and p.expert.split_step == 2
    assert p.pdmd_strength == 0.6 and p.pdmd_sparse
