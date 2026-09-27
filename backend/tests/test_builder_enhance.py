"""The enhance graph must reproduce workflows/ShellMax_SeedVR2_Enhance.json."""

import json
from pathlib import Path

from app.workflow.builder_enhance import build_enhance_prompt
from app.workflow.params import EnhanceFullParams, EnhanceRecipe

WORKFLOW = Path(__file__).resolve().parents[2] / "workflows" / "ShellMax_SeedVR2_Enhance.json"


def default_params(**over) -> EnhanceFullParams:
    base = dict(
        source_path="F:/clip.mp4",
        force_rate=0,
        frame_load_cap=0,
        frame_rate=24.0,
        seed=42,
        recipe=EnhanceRecipe(
            unet="F:/m/seedvr2.safetensors",
            vae="F:/m/seedvr2_vae.safetensors",
            color_correction="lab",
            crf=17,
        ),
        filename_prefix="ShellMax/enhance",
    )
    base.update(over)
    return EnhanceFullParams(**base)


def _golden(unet: str, vae: str, source: str) -> dict:
    raw = WORKFLOW.read_text(encoding="utf-8")
    raw = raw.replace("__UNET__", unet).replace("__VAE__", vae).replace("__SOURCE__", source)
    return {k: v for k, v in json.loads(raw).items() if not k.startswith("_")}


def test_graph_matches_golden_workflow():
    p = default_params()
    g = build_enhance_prompt(p)
    expected = _golden(p.recipe.unet, p.recipe.vae, p.source_path)
    assert set(g) == set(expected)
    for nid, node in expected.items():
        assert g[nid]["class_type"] == node["class_type"], nid
        assert g[nid]["inputs"] == node["inputs"], f"node {nid}: {g[nid]['inputs']} != {node['inputs']}"


def test_scale_and_color_override():
    p = default_params(recipe=EnhanceRecipe(
        unet="F:/u.safetensors", vae="F:/v.safetensors", scale=1.5, color_correction="lab"))
    g = build_enhance_prompt(p)
    assert g["2"]["inputs"]["scale_by"] == 1.5
    assert g["12"]["inputs"]["color_correction_method"] == "lab"
