"""Freeze the memory recipe, including unchanged sampling and RefMod links."""

import json
from pathlib import Path

import pytest

from app.jobs.registry import get_handler, pipeline_for
from app.workflow.builder import build_prompt
from app.workflow.builder_memory import build_memory_prompt
from app.workflow.builder_refmods import build_memory_refmod_prompt
from app.workflow.params import ExpertParams
from test_builder import default_params


@pytest.mark.parametrize("kind,file", [
    ("generate_memory", "ShellMax_Singularity_Memory.json"),
    ("generate_memory_refmods", "ShellMax_Singularity_Memory_RefMods.api.json"),
])
def test_every_node_matches_workflow(kind, file):
    p = default_params(seed=42424242, expert=ExpertParams(ref_image_size="max"))
    replacements = {
        "__UNET__": p.unet, "__CLIP__": p.text_encoder,
        "__VAE_VIDEO__": p.vae_video, "__VAE_AUDIO__": p.vae_audio,
        "__UPSCALER__": p.upscaler, "__TURBO__": p.loras_main[0].path,
        "__LMS__": p.loras_final[0].path, "__REALISM__": p.loras_final[1].path,
        "__PROMPT__": p.prompt, "__REF_IMAGE__": p.refs[0].comfy_name,
        "__PREFIX__": p.filename_prefix, "__DRAFT_PREFIX__": p.filename_prefix + "_draft",
    }
    path = Path(__file__).resolve().parents[2] / "workflows" / file
    expected = json.loads(path.read_text(encoding="utf-8"))
    for node in expected.values():
        for key, value in node["inputs"].items():
            if isinstance(value, str):
                node["inputs"][key] = replacements.get(value, value)
    assert get_handler(kind).build(p) == expected
    assert pipeline_for(kind).sampler_nodes == pipeline_for("generate").sampler_nodes
    assert pipeline_for(kind).stages == pipeline_for("generate").stages


@pytest.mark.parametrize("low_vram", [False, True])
@pytest.mark.parametrize("main,final", [(True, True), (False, True), (True, False), (False, False)])
def test_only_memory_and_attention_provider_changes(low_vram, main, final):
    p = default_params(low_vram=low_vram)
    if not main:
        p.loras_main = []
    if not final:
        p.loras_final = []
    old, new = build_prompt(p), build_memory_prompt(p)
    assert not {"70", "142", "143"} & new.keys()
    assert new["memory_opt"]["inputs"]["precision_mode"] == "Preserve native"
    assert new["memory_opt"]["inputs"]["qkv_streaming_mode"] == "Forced"
    for name, node in old.items():
        if name in {"70", "142", "143"}:
            continue
        expected = json.loads(json.dumps(node))
        for key, value in expected["inputs"].items():
            if value == ["70", 0]:
                expected["inputs"][key] = ["69", 0]
            elif value == ["143", 0]:
                expected["inputs"][key] = ["121", 0]
        if name == "121":
            assert new[name]["class_type"] == "H3SparseAttentionAdvanced"
            assert new[name]["inputs"]["model"] == ["memory_residency", 0]
            continue
        if name == "126":
            expected["inputs"]["model"] = ["memory_final_attention", 0]
        if name == "127_0":
            expected["inputs"]["model"] = ["memory_final_main_0", 0] if main else ["memory_residency", 0]
        assert new[name] == expected
    root = ["memory_final_main_0", 0] if main else ["memory_residency", 0]
    if main:
        source = old["118_0"]["inputs"]
        assert new["memory_final_main_0"] == {
            "class_type": "ShellMaxLoraModelOnlyByPath",
            "inputs": {"model": ["memory_residency", 0], "lora_path": source["lora_path"],
                       "strength_model": source["strength_model"]},
        }
    tail = [f"127_{len(p.loras_final) - 1}", 0] if final else root
    assert new["memory_final_attention"]["inputs"]["model"] == tail
    assert build_memory_refmod_prompt(p)["memory_opt"] == new["memory_opt"]


def test_profile_uses_memory_pipeline():
    from app.workflow.params import UIParams
    from app.workflow.presets import expand
    from test_presets import profile

    p = profile(pipeline="generate_memory")
    full = expand(UIParams(prompt="p"), p, [], [], seed=7, filename_prefix="x")
    assert full.unet == p.unet
    old = build_prompt(full)["106"]["inputs"]
    new = get_handler(p.pipeline).build(full)["106"]["inputs"]
    assert {k: v for k, v in new.items() if k != "model"} == {k: v for k, v in old.items() if k != "model"}


def test_final_branch_keeps_main_styles_without_duplicating_clip():
    p = default_params()
    p.loras_main.append(p.loras_main[0].model_copy(update={"strength": 0.25}))
    old, new = build_prompt(p), build_memory_prompt(p)
    for i in range(2):
        source = old[f"118_{i}"]["inputs"]
        assert new[f"memory_final_main_{i}"]["inputs"] == {
            "model": ["memory_residency", 0] if i == 0 else ["memory_final_main_0", 0],
            "lora_path": source["lora_path"], "strength_model": source["strength_model"],
        }
    assert new["127_0"]["inputs"]["model"] == ["memory_final_main_1", 0]
    assert new["56"] == old["56"]


def test_disabled_loras_are_skipped_on_both_branches():
    p = default_params()
    p.loras_main = [p.loras_main[0].model_copy(update={"strength": 0})]
    p.loras_final = [lora.model_copy(update={"strength": 0}) for lora in p.loras_final]
    new = build_memory_prompt(p)
    assert not any(name.startswith(("118_", "127_", "memory_final_main_")) for name in new)
    assert new["memory_final_attention"]["inputs"]["model"] == ["memory_residency", 0]


def test_defaults_match_memory_workflow():
    from app import settings

    recipe = settings.defaults()["memory_optimization"]
    inputs = build_memory_prompt(default_params())["memory_opt"]["inputs"]
    assert {k: v for k, v in inputs.items() if k != "model"} == {
        k: v for k, v in recipe.items() if k not in {
            "_comment", "text_encoder", "aimdo_residency", "sparse_attention", "sparse_attention_final"}
    }
    assert build_memory_prompt(default_params())["memory_residency"]["inputs"]["residency"] == recipe["aimdo_residency"]
    sparse = build_memory_prompt(default_params())["121"]["inputs"]
    assert {k: v for k, v in sparse.items() if k != "model"} == recipe["sparse_attention"]
    final = build_memory_prompt(default_params())["memory_final_attention"]["inputs"]
    assert {k: v for k, v in final.items() if k != "model"} == recipe["sparse_attention_final"]
