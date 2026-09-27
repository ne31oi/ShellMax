"""The interpolate graph must reproduce workflows/ShellMax_Interpolate.json."""

import json
from pathlib import Path

from app.workflow.builder_interpolate import build_interpolate_prompt
from app.workflow.params import InterpolateFullParams, InterpolateRecipe

WORKFLOW = Path(__file__).resolve().parents[2] / "workflows" / "ShellMax_Interpolate.json"


def default_params(**over) -> InterpolateFullParams:
    base = dict(
        source_path="F:/clip.mp4",
        frame_load_cap=0,
        frame_rate=48.0,
        recipe=InterpolateRecipe(
            model="F:/m/rife_v4.26.safetensors",
            model_preset="rife",
            multiplier=2,
            crf=17,
        ),
        filename_prefix="ShellMax/interpolate",
    )
    base.update(over)
    return InterpolateFullParams(**base)


def _golden(model: str, source: str) -> dict:
    raw = WORKFLOW.read_text(encoding="utf-8")
    raw = raw.replace("__MODEL__", model).replace("__SOURCE__", source)
    return {k: v for k, v in json.loads(raw).items() if not k.startswith("_")}


def test_graph_matches_golden_workflow():
    p = default_params()
    g = build_interpolate_prompt(p)
    expected = _golden(p.recipe.model, p.source_path)
    assert set(g) == set(expected)
    for nid, node in expected.items():
        assert g[nid]["class_type"] == node["class_type"], nid
        assert g[nid]["inputs"] == node["inputs"], f"node {nid}: {g[nid]['inputs']} != {node['inputs']}"


def test_multiplier_and_film():
    p = default_params(
        frame_rate=72.0,
        recipe=InterpolateRecipe(
            model="F:/m/film_net_fp16.safetensors",
            model_preset="film",
            multiplier=3,
        ),
    )
    g = build_interpolate_prompt(p)
    assert g["3"]["inputs"]["multiplier"] == 3
    assert g["2"]["inputs"]["model_path"].endswith("film_net_fp16.safetensors")
    assert g["4"]["inputs"]["frame_rate"] == 72.0
