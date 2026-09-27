"""Freeze the reviewed INT8 -> mixed NVFP4 graph, including every unchanged link."""

import json
from pathlib import Path

import pytest

from app.jobs.pipelines import PIPELINES
from app.workflow.builder import build_prompt
from app.workflow.builder_nvfp4 import build_nvfp4_prompt
from app.workflow.builder_nvfp4_fast import build_nvfp4_fast_prompt
from app.workflow.params import ExpertParams, LoraSpec
from test_builder import default_params

WORKFLOW = Path(__file__).resolve().parents[2] / "workflows" / "ShellMax_NVFP4_DualSampling.json"


def params(**over):
    return default_params(seed=42424242, expert=ExpertParams(ref_image_size="max"),
                          nvfp4_unet="F:/m/mixed_nvfp4.safetensors", **over)


@pytest.mark.parametrize("build,workflow", [
    (build_nvfp4_prompt, WORKFLOW),
    (build_nvfp4_fast_prompt, WORKFLOW.with_name("ShellMax_NVFP4_DualSampling_5.json")),
])
def test_every_node_matches_reviewed_workflow(build, workflow):
    p = params()
    replacements = {
        "__UNET__": p.unet, "__NVFP4_UNET__": p.nvfp4_unet, "__CLIP__": p.text_encoder,
        "__VAE_VIDEO__": p.vae_video, "__VAE_AUDIO__": p.vae_audio, "__UPSCALER__": p.upscaler,
        "__TURBO__": p.loras_main[0].path, "__LMS__": p.loras_final[0].path,
        "__REALISM__": p.loras_final[1].path, "__PROMPT__": p.prompt,
        "__REF_IMAGE__": p.refs[0].comfy_name, "__PREFIX__": p.filename_prefix,
        "__DRAFT_PREFIX__": p.filename_prefix + "_draft",
    }
    expected = json.loads(workflow.read_text(encoding="utf8"))
    for node in expected.values():
        for key, value in node["inputs"].items():
            if isinstance(value, str):
                node["inputs"][key] = replacements.get(value, value)
    assert build(p) == expected


def test_fast_final_preserves_first_pass_and_low_vram_chain():
    p = params(low_vram=True)
    slow, fast = build_nvfp4_prompt(p), build_nvfp4_fast_prompt(p)
    assert {k: v for k, v in fast.items() if k in slow and k != "106"} == {
        k: v for k, v in slow.items() if k != "106"
    }
    assert fast["106"]["inputs"]["sigmas"] == ["nvfp4_short_final", 1]


@pytest.mark.parametrize("field,value", [("steps", 8), ("extend_steps", 3), ("split_step", 3)])
def test_fast_final_rejects_incompatible_noise_boundary(field, value):
    p = params()
    setattr(p.expert, field, value)
    with pytest.raises(ValueError, match="5 интервалов"):
        build_nvfp4_fast_prompt(p)


@pytest.mark.parametrize("main,final", [(True, True), (False, True), (True, False), (False, False)])
def test_lora_stacks_preserve_first_pass_and_conditioning(main, final):
    p = params()
    if not main:
        p.loras_main = []
    if not final:
        p.loras_final = []
    original = build_prompt(p)
    graph = build_nvfp4_prompt(p)
    target = "127_0" if final else "126"
    assert {k: v for k, v in graph.items() if k in original and k != target} == {
        k: v for k, v in original.items() if k != target
    }
    assert graph[target]["inputs"]["model"][0] == ("nvfp4_118_0" if main else "nvfp4_143")
    assert graph["56"] == original["56"]


def test_additional_style_and_disabled_lora():
    p = params()
    p.loras_main += [LoraSpec(path="disabled", enabled=False), LoraSpec(path="style", strength=0.7)]
    graph = build_nvfp4_prompt(p)
    assert graph["nvfp4_118_1"]["inputs"]["lora_path"] == "style"
    assert graph["nvfp4_118_1"]["inputs"]["model"] == ["nvfp4_118_0", 0]
    assert graph["127_0"]["inputs"]["model"] == ["nvfp4_118_1", 0]
    assert graph["56"]["inputs"]["clip"] == ["118_1", 1]


def test_missing_final_model_fails_before_submission():
    p = params()
    p.nvfp4_unet = ""
    with pytest.raises(ValueError, match="модель финального прохода"):
        build_nvfp4_prompt(p)


def test_low_vram_patch_stays_on_each_models_own_chain():
    graph = build_nvfp4_prompt(params(low_vram=True))
    assert graph["143"]["inputs"]["model"] == ["142", 0]
    assert graph["nvfp4_143"]["inputs"]["model"] == ["nvfp4_142", 0]
    assert graph["nvfp4_142"]["inputs"]["model"] == ["nvfp4_121", 0]


def test_pipeline_outputs_and_sampling_are_preserved():
    old, new = PIPELINES["generate"], PIPELINES["generate_nvfp4"]
    assert (new.final_node, new.draft_node, new.sampler_nodes) == (old.final_node, old.draft_node, old.sampler_nodes)
    assert new.stages == old.stages


def test_profile_expansion_carries_final_model():
    from test_presets import profile
    from app.workflow.params import UIParams
    from app.workflow.presets import expand

    p = profile(pipeline="generate_nvfp4", nvfp4_unet="F:/mixed.safetensors")
    full = expand(UIParams(prompt="p"), p, [], [], seed=7, filename_prefix="x")
    assert full.nvfp4_unet == p.nvfp4_unet
    assert full.unet == p.unet


@pytest.mark.parametrize("kind,size", [("generate", (1440, 832)), ("generate_nvfp4", (1440, 832)),
                                       ("generate_nvfp4_fast", (1440, 832))])
def test_estimate_uses_selected_pipeline(monkeypatch, kind, size):
    from app import api
    from test_presets import profile

    def selected(profile_id):
        assert profile_id == 8
        return None, profile(pipeline=kind)

    monkeypatch.setattr(api.services, "get_profile", selected)
    monkeypatch.setattr(api, "estimate_time", lambda units, job: (units, job))
    assert api.estimate("16:9 (Widescreen)", "standard", 2, 8) == (size[0] * size[1] * 56, kind)
