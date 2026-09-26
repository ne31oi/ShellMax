"""The generated graph must reproduce the original workflow: same links, same values."""

import json
from pathlib import Path

import pytest

from app.workflow.builder import build_prompt
from app.workflow.params import (ExpertParams, FullParams, LoraSpec, ResolvedRef, base_resolution, frame_count,
                                 upscaled_resolution)
from app.workflow.presets import with_style_triggers

WORKFLOW = Path(__file__).resolve().parents[2] / "workflows" / "MiniMax_H3_Singularity_DualSampling_The_AI_Brief_EN.json"

LORA_MAIN = "F:/m/loras/minimax_h3/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors"
LORA_LMS = "F:/m/loras/minimax_h3/minimax_h3_lms_v1.0_r64.safetensors"
LORA_REAL = "F:/m/loras/minimax_h3/h3-realism-people-t2v-i2v-r2v.safetensors"


def default_params(**over) -> FullParams:
    base = dict(
        prompt="subject_definitions:\n<Subject 1> is the woman in <Picture 1>.",
        refs=[ResolvedRef(kind="image", comfy_name="shellmax/a.png")],
        aspect="16:9 (Widescreen)", megapixels=0.5, upscale=1.5, duration=2.0, seed=252257667695918,
        unet="F:/m/diffusion_models/minimax_h3/Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors",
        text_encoder="F:/m/text_encoders/minimax_h3/qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
        vae_video="F:/m/vae/minimax_h3/minimax_h3_video_vae_fp16.safetensors",
        vae_audio="F:/m/vae/minimax_h3/minimax_h3_audio_vae_fp32.safetensors",
        upscaler="F:/m/latent_upscale_models/minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors",
        loras_main=[LoraSpec(path=LORA_MAIN, strength=1.0)],
        loras_final=[LoraSpec(path=LORA_LMS, strength=0.5), LoraSpec(path=LORA_REAL, strength=1.0)],
        low_vram=False, expert=ExpertParams(),
    )
    base.update(over)
    return FullParams(**base)


# ------------------------------------------------------------------ derived values
@pytest.mark.parametrize("seconds,frames", [(2, 56), (5, 124), (0.1, 5), (10, 243), (15, 362)])
def test_frame_count_matches_workflow_expression(seconds, frames):
    assert frame_count(seconds) == frames
    assert frames % 17 == 5


def test_resolution_matches_workflow_note_table():
    # MarkdownNote (node 72) in the workflow lists these for 16:9, multiple=32
    assert base_resolution("16:9 (Widescreen)", 0.5) == (960, 544)
    assert base_resolution("16:9 (Widescreen)", 0.98) == (1344, 768)
    assert base_resolution("16:9 (Widescreen)", 2.0) == (1920, 1088)


def test_upscaled_resolution_follows_upscaler_alignment():
    # 544*1.5 = 816 -> round(816/32)=26 (banker's rounding) -> 832
    assert upscaled_resolution(960, 544, 1.5) == (1440, 832)


# ------------------------------------------------------------------ faithfulness to the original graph
def _original():
    w = json.loads(WORKFLOW.read_text(encoding="utf-8"))
    nodes = {n["id"]: n for n in w["nodes"]}
    links = {l[0]: l for l in w["links"]}
    return nodes, links


def _resolve_source(nodes, links, src_id, src_slot):
    """Follow KJ Get/Set nodes and bypassed (mode 4) nodes back to the real producer."""
    n = nodes[src_id]
    if n["type"] == "GetNode":
        name = n["widgets_values"][0]
        setter = next(x for x in nodes.values() if x["type"] == "SetNode" and x["widgets_values"][0] == name)
        link = links[setter["inputs"][0]["link"]]
        return _resolve_source(nodes, links, link[1], link[2])
    if n.get("mode") == 4:
        out_type = n["outputs"][src_slot]["type"]
        inp = next((i for i in n.get("inputs", []) if i["type"] == out_type and i.get("link") is not None), None)
        if inp is None:  # bypassed source with nothing to pass through (unused LoadImage etc.)
            return None, None
        link = links[inp["link"]]
        return _resolve_source(nodes, links, link[1], link[2])
    return src_id, src_slot


# original node -> node in our graph (value-preserving substitutions)
ID_MAP = {118: "118_0", 127: "127_0", 199: "127_1", 169: "ref_image_0"}
SKIP_DST = {198}  # easy float: folded into the upscaler's "scale" value


def test_every_original_link_is_reproduced():
    nodes, links = _original()
    graph = build_prompt(default_params())
    checked = 0
    for link_id, src, src_slot, dst, dst_slot, _type in links.values():
        dnode = nodes[dst]
        if dnode.get("mode") == 4 or dnode["type"] in ("SetNode", "GetNode") or dst in SKIP_DST:
            continue
        real_src, real_slot = _resolve_source(nodes, links, src, src_slot)
        if real_src is None:
            continue
        if real_src in SKIP_DST:  # 198 -> 124 "mode.scale"
            assert graph["124"]["inputs"]["scale"] == 1.5
            continue
        inp = next(i for i in dnode["inputs"] if i.get("link") == link_id)
        our_dst = ID_MAP.get(dst, str(dst))
        our_src = ID_MAP.get(real_src, str(real_src))
        name = inp["name"]
        if name.startswith("ref_images."):
            name = "ref_images.ref_image_0"  # the one active reference slot, renumbered contiguously
        assert our_dst in graph, f"node {dst} ({dnode['type']}) missing"
        # in our chain, LoRA slots take model/clip from the previous chain element
        if dst == 199:
            our_src = "127_0"
        assert graph[our_dst]["inputs"].get(name) == [our_src, real_slot], \
            f"{dnode['type']}({dst}).{name}: expected [{our_src}, {real_slot}], got {graph[our_dst]['inputs'].get(name)}"
        checked += 1
    assert checked > 50


# class substitutions and the input each original widget value lands in
SUBST = {
    69: ("ShellMaxUNETLoaderByPath", {}),
    64: ("ShellMaxCLIPLoaderByPath", {}),
    65: ("ShellMaxVAELoaderByPath", {}),
    66: ("ShellMaxVAELoaderByPath", {}),
    124: ("ShellMaxLatentUpscalerByPath", {}),
}


def test_widget_values_are_reproduced():
    nodes, _ = _original()
    graph = build_prompt(default_params())
    for nid, node in nodes.items():
        our = graph.get(ID_MAP.get(nid, str(nid)))
        if our is None or node.get("mode") == 4 or node["type"] in ("SetNode", "GetNode", "MarkdownNote"):
            continue
        expected_class = SUBST.get(nid, (node["type"], None))[0]
        if nid not in (118, 127, 199, 169):
            assert our["class_type"] == expected_class, f"{nid}: {our['class_type']} != {expected_class}"
        values = node.get("widgets_values")
        if isinstance(values, dict):  # VHS nodes store a dict
            values = [v for k, v in values.items() if k not in ("videopreview", "filename_prefix")]
        ours = list(our["inputs"].values())
        for v in values or []:
            if v in (None, "None", "randomize", "fixed", "image") or isinstance(v, (dict, list)):
                continue
            if isinstance(v, str) and ("\\" in v or v.endswith((".safetensors", ".jpg", ".png"))):
                continue  # model / file names become absolute paths
            if nid == 84 or nid == 56:
                continue  # prompt text is user input
            if nid == 63:
                continue  # seed is per generation
            if nid == 74:
                continue  # duration is user input
            if nid == 124 and v == "scale by multiplier":
                continue  # mode is fixed inside ShellMaxLatentUpscalerByPath
            assert any(v == o or (isinstance(v, float) and isinstance(o, (int, float)) and abs(v - o) < 1e-9)
                       for o in ours if not isinstance(o, list)), f"{node['type']}({nid}): value {v!r} not in {ours}"


def test_lora_paths_and_strengths():
    g = build_prompt(default_params())
    assert g["118_0"]["inputs"]["lora_path"] == LORA_MAIN
    assert g["118_0"]["inputs"]["strength_model"] == g["118_0"]["inputs"]["strength_clip"] == 1.0
    assert g["127_0"]["inputs"]["strength_model"] == 0.5
    assert g["126"]["inputs"]["model"] == ["127_1", 0]
    assert g["57"]["inputs"]["model"] == ["118_0", 0]
    assert g["56"]["inputs"]["clip"] == ["118_0", 1]


# ------------------------------------------------------------------ dynamic parts
def test_references_connect_contiguously_per_kind():
    refs = [ResolvedRef(kind="image", comfy_name="shellmax/a.png"),
            ResolvedRef(kind="video", path="F:/v.mp4", with_audio=True),
            ResolvedRef(kind="image", comfy_name="shellmax/b.png"),
            ResolvedRef(kind="audio", comfy_name="shellmax/c.wav")]
    g = build_prompt(default_params(refs=refs))
    i = g["56"]["inputs"]
    assert i["ref_images.ref_image_0"] == ["ref_image_0", 0]
    assert i["ref_images.ref_image_1"] == ["ref_image_1", 0]
    assert g["ref_image_1"]["inputs"]["image"] == "shellmax/b.png"
    assert i["ref_videos.ref_video_0"] == ["ref_video_0", 0]
    assert i["ref_video_audios.ref_video_audio_0"] == ["ref_video_0", 2]
    assert i["ref_audios.ref_audio_0"] == ["ref_audio_0", 0]
    assert g["ref_video_0"]["class_type"] == "VHS_LoadVideoPath"


def test_video_audio_is_off_by_default():
    g = build_prompt(default_params(refs=[ResolvedRef(kind="video", path="F:/v.mp4")]))
    assert not any(k.startswith("ref_video_audios") for k in g["56"]["inputs"])


def test_no_refs_is_text_to_video():
    g = build_prompt(default_params(refs=[]))
    assert not any(k.startswith("ref_") for k in g["56"]["inputs"] if k != "ref_image_size")


def test_low_vram_inserts_node_142():
    assert "142" not in build_prompt(default_params())
    g = build_prompt(default_params(low_vram=True))
    assert g["142"]["inputs"] == {"model": ["121", 0], "head_chunks": 4}
    assert g["143"]["inputs"]["model"] == ["142", 0]


def test_disabled_and_zero_loras_are_skipped():
    g = build_prompt(default_params(
        loras_main=[LoraSpec(path=LORA_MAIN, enabled=False)],
        loras_final=[LoraSpec(path=LORA_LMS, strength=0)]))
    assert not any(k.startswith(("118_", "127_")) for k in g)
    assert g["57"]["inputs"]["model"] == ["143", 0]
    assert g["126"]["inputs"]["model"] == ["143", 0]
    assert g["56"]["inputs"]["clip"] == ["64", 0]


def test_style_triggers_are_appended_once():
    assert with_style_triggers("a cat", ["cinematic"]) == "a cat\n\ncinematic"
    assert with_style_triggers("a Cinematic cat", ["cinematic"]) == "a Cinematic cat"
