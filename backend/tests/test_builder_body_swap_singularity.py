"""A/B graph parity: replacing UNET must leave every other link and value intact."""
import json
from pathlib import Path

import pytest

from app import settings
from app.jobs.registry import get_handler, pipeline_for
from app.workflow.body_swap import BodySwapFull, model_paths
from app.workflow.builder_body_swap import build_body_swap_prompt
from app.workflow.builder_body_swap_singularity import build_body_swap_singularity_prompt
from app.workflow.fantastic import MediaSource


@pytest.mark.parametrize("version,base_file,variant_file", [
    (1, "ShellMax_BodySwap.api.json", "ShellMax_BodySwap_Singularity.api.json"),
    (2, "ShellMax_BodySwap_Full.api.json", "ShellMax_BodySwap_Full_Singularity.api.json"),
    (3, "ShellMax_BodySwap_Full_Reference.api.json", "ShellMax_BodySwap_Full_Reference_Singularity.api.json"),
    (4, "ShellMax_BodySwap_Complete.api.json", "ShellMax_BodySwap_Complete_Singularity.api.json"),
    (5, "ShellMax_BodySwap_Background.api.json", "ShellMax_BodySwap_Background_Singularity.api.json"),
    (6, "ShellMax_BodySwap_Fitted.api.json", "ShellMax_BodySwap_Fitted_Singularity.api.json"),
])
def test_singularity_template_and_full_graph_match_ref2va_except_unet(version, base_file, variant_file):
    base = json.loads((settings.ROOT / "workflows" / base_file).read_text())
    variant = json.loads((settings.ROOT / "workflows" / variant_file).read_text())
    variant["1199"]["inputs"]["unet_path"] = "__UNET__"
    assert variant == base
    p = BodySwapFull(recipe_version=version, source_path="source.mp4", sources=[MediaSource(path="front.png", file="front.png", kind="picture"),
        MediaSource(path="side.png", file="side.png", kind="picture")], models={"unet": "author.safetensors"},
        start=.25, end=.25+22/24, frames=22, subject="person", prompt="replace", seed=42, has_audio=True)
    author = build_body_swap_prompt(p)
    singularity = build_body_swap_singularity_prompt(p.model_copy(update={"variant":"singularity", "models":{"unet":"singularity.safetensors"}}))
    assert singularity["1199"]["inputs"]["unet_path"] == "singularity.safetensors"
    singularity["1199"]["inputs"]["unet_path"] = "author.safetensors"
    assert singularity == author
    assert get_handler("body_swap_singularity").build == build_body_swap_singularity_prompt
    assert pipeline_for("body_swap_singularity") is pipeline_for("body_swap")


def test_singularity_reuses_every_weight_except_unet():
    author, variant = model_paths(), model_paths("singularity")
    assert Path(variant["unet"]).name == Path(settings.defaults()["body_swap"]["singularity_unet"]).name
    assert {key:value for key,value in author.items() if key != "unet"} == {key:value for key,value in variant.items() if key != "unet"}
