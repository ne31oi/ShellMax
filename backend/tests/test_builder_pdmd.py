"""Freeze PDMD DualSampling and protect the AV handoff across the upscale boundary."""

import json
from pathlib import Path

import pytest

from app.workflow.builder_pdmd import build_pdmd_prompt
from app.workflow.builder_refmods import build_pdmd_refmod_prompt
from app.workflow.params import ExpertParams, LoraSpec, UIParams
from app.workflow.pdmd import default_profile
from app.workflow.presets import expand
from test_builder import default_params

WORKFLOWS = Path(__file__).resolve().parents[2] / "workflows"


def params(**over):
    return default_params(seed=42424242, pdmd_lora="F:/pdmd_v6.safetensors",
                          loras_main=[], loras_final=[], expert=default_profile().expert, **over)


@pytest.mark.parametrize("build,name,split", [
    (build_pdmd_prompt, "ShellMax_PDMD4_DualSampling.api.json", 2),
    (build_pdmd_refmod_prompt, "ShellMax_PDMD4_DualSampling_RefMods.api.json", 2),
    (build_pdmd_prompt, "ShellMax_PDMD4_SinglePass.api.json", 0),
    (build_pdmd_refmod_prompt, "ShellMax_PDMD4_SinglePass_RefMods.api.json", 0),
])
def test_every_node_matches_frozen_workflow(build, name, split):
    p = params()
    p.expert.split_step = split
    substitutions = {
        "__UNET__": p.unet, "__CLIP__": p.text_encoder,
        "__VAE_VIDEO__": p.vae_video, "__VAE_AUDIO__": p.vae_audio,
        "__UPSCALER__": p.upscaler, "__PDMD__": p.pdmd_lora,
        "__PROMPT__": p.prompt, "__REF_IMAGE__": p.refs[0].comfy_name,
        "__PREFIX__": p.filename_prefix, "__DRAFT_PREFIX__": p.filename_prefix + "_draft",
    }
    expected = json.loads((WORKFLOWS / name).read_text(encoding="utf-8"))
    for node in expected.values():
        for key, value in node["inputs"].items():
            if isinstance(value, str):
                node["inputs"][key] = substitutions.get(value, value)
    assert build(p) == expected


def test_dual_sampling_preserves_noisy_audio_and_x0_video_handoff():
    g = build_pdmd_prompt(params())
    assert g["104"]["inputs"]["av_latent"] == ["108", 1]
    assert g["124"]["inputs"]["latent"] == ["104", 0]
    assert g["128"]["inputs"]["sigmas"] == ["100", 0]
    assert g["100"]["inputs"]["step"] == 0
    assert g["128"]["inputs"]["noise"] == ["63", 0]
    assert g["102"]["inputs"]["av_latent"] == ["108", 0]
    assert g["105"]["inputs"]["audio_latent"] == ["102", 1]
    assert g["106"]["inputs"]["noise"] == ["114", 0]
    assert g["106"]["inputs"]["sigmas"] == ["99", 1]
    assert "121" not in g


@pytest.mark.parametrize("field,value,node,input_name", [
    ("steps", 3, "71", "steps"), ("extend_steps", 0, "94", "steps"),
    ("split_step", 4, "99", "step"),
    ("sampler", "seeds_2", "58", "sampler_name"), ("scheduler", "beta", "71", "scheduler"),
])
def test_expert_sampling_choices_reach_the_graph(field, value, node, input_name):
    p = params()
    setattr(p.expert, field, value)
    assert build_pdmd_prompt(p)[node]["inputs"][input_name] == value


@pytest.mark.parametrize("build,slot", [(build_pdmd_prompt, 1), (build_pdmd_refmod_prompt, 2)])
def test_zero_split_has_no_noise_only_draft_or_upscale(build, slot):
    p = params()
    p.expert.split_step = 0
    g = build(p)
    assert {"108", "128", "124", "135"}.isdisjoint(g)
    assert g["106"]["inputs"]["latent_image"] == ["56", slot]
    assert g["106"]["inputs"]["noise"] == ["63", 0]
    assert g["56"]["inputs"]["width"] == 1440
    assert g["56"]["inputs"]["height"] == 832


@pytest.mark.parametrize("steps,extend,split", [(10, 1, 2), (8, 1, 4), (6, 1, 3), (4, 2, 4)])
def test_expert_can_add_steps_without_changing_av_handoff(steps, extend, split):
    p = params()
    p.expert.steps, p.expert.extend_steps, p.expert.split_step = steps, extend, split
    g = build_pdmd_prompt(p)
    baseline = build_pdmd_prompt(params())
    baseline["71"]["inputs"]["steps"] = steps
    baseline["94"]["inputs"]["steps"] = extend
    baseline["99"]["inputs"]["step"] = split
    assert g == baseline


def test_missing_adapter_is_rejected():
    p = params()
    p.pdmd_lora = ""
    with pytest.raises(ValueError, match="Укажите PDMD"):
        build_pdmd_prompt(p)


@pytest.mark.parametrize("strength", [0, 0.35, -0.5, 1.7])
def test_custom_adapter_strength_and_distillation_stacks_are_respected(strength):
    p = params()
    p.pdmd_strength = strength
    p.loras_main = [LoraSpec(path="h3_turbo_4step.safetensors", strength=0.4)]
    p.loras_final = [LoraSpec(path="another_pdmd.safetensors", strength=0.2)]
    g = build_pdmd_prompt(p)
    assert g["pdmd_lora"]["inputs"]["strength_model"] == strength
    assert g["118_0"]["inputs"]["model"] == ["pdmd_lora", 0]
    assert g["127_0"]["inputs"]["model"] == ["118_0", 0]


@pytest.mark.parametrize("low_vram", [False, True])
def test_sparse_override_keeps_selected_attention_in_the_model_chain(low_vram):
    p = params(low_vram=low_vram, pdmd_sparse=True)
    p.expert.sparse_tau, p.expert.sparse_start, p.expert.sparse_end = 0.8, 0.1, 0.7
    g = build_pdmd_prompt(p)
    assert g["142" if low_vram else "143"]["inputs"]["model"] == ["121", 0]
    assert g["121"]["inputs"]["selection.tau"] == 0.8
    assert g["121"]["inputs"]["start_percent"] == 0.1
    assert g["121"]["inputs"]["end_percent"] == 0.7


def test_optional_styles_and_low_vram_keep_pdmd_in_both_passes():
    p = params(low_vram=True)
    p.loras_main = [LoraSpec(path="style", strength=0.7)]
    p.loras_final = [LoraSpec(path="realism", strength=0.5)]
    g = build_pdmd_prompt(p)
    assert g["142"]["inputs"]["model"] == ["119", 0]
    assert g["143"]["inputs"]["model"] == ["142", 0]
    assert g["118_0"]["inputs"]["model"] == ["pdmd_lora", 0]
    assert g["118_0"]["inputs"]["clip"] == ["64", 0]
    assert g["127_0"]["inputs"]["model"] == ["118_0", 0]
    assert g["126"]["inputs"]["model"] == ["127_0", 0]


def test_profile_expansion_and_reset_preserve_pdmd_recipe():
    profile = default_profile()
    p = expand(UIParams(prompt="p"), profile, [], [], seed=7, filename_prefix="x")
    assert p.pdmd_lora == profile.pdmd_lora
    assert p.pdmd_strength == 1 and not p.pdmd_sparse
    assert not p.loras_main and not p.loras_final
    assert p.expert == ExpertParams(steps=4, extend_steps=1, split_step=2, sampler="euler", chunk_ff_chunks=8)
    from app.engine_api import workflow_defaults
    assert workflow_defaults("generate_pdmd")["expert"] == profile.expert.model_dump()


def test_profile_expansion_preserves_adapter_and_attention_overrides():
    profile = default_profile().model_copy(update={"pdmd_strength": 0.6, "pdmd_sparse": True})
    p = expand(UIParams(prompt="p"), profile, [], [], seed=7, filename_prefix="x")
    assert p.pdmd_strength == 0.6 and p.pdmd_sparse


def test_pdmd_missing_file_is_reported_on_the_profile(monkeypatch):
    from app.services import profile_problems
    monkeypatch.setattr("app.fs.browse.check", lambda path: {"exists": path != "missing"})
    profile = default_profile().model_copy(update={"pdmd_lora": "missing"})
    assert profile_problems(profile) == [{"field": "pdmd_lora", "path": "missing"}]
