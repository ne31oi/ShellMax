"""The face refine graph must reproduce MiniMax_H3_FaceRefine_Best: same links, same values."""

import json
from pathlib import Path

from app.workflow.builder_face import build_face_prompt
from app.workflow.params import FaceFullParams, FaceRecipe

WORKFLOW = Path(__file__).resolve().parents[2] / "workflows" / "MiniMax_H3_FaceRefine_Best.json"


def default_params(**over) -> FaceFullParams:
    base = dict(
        source_path="F:/clip.mp4", identity_image="shellmax/id.jpg", closeup_image="shellmax/id.jpg",
        closeup_crop='{"x": 0.3, "y": 0.08, "w": 0.42, "h": 0.36}', prompt="p", denoise=0.35, seed=42,
        text_encoder="F:/m/te.safetensors", vae_video="F:/m/vv.safetensors", vae_audio="F:/m/va.safetensors",
        recipe=FaceRecipe(unet="F:/m/unet.safetensors", lora="F:/m/lora8.safetensors"),
    )
    base.update(over)
    return FaceFullParams(**base)


def _original():
    w = json.loads(WORKFLOW.read_text(encoding="utf-8"))
    return {n["id"]: n for n in w["nodes"]}, {l[0]: l for l in w["links"]}


def _resolve(nodes, links, src, slot):
    """Follow bypassed (mode 4) nodes back to the producer."""
    n = nodes[src]
    if n.get("mode") == 4:
        out_type = n["outputs"][slot]["type"]
        inp = next(i for i in n["inputs"] if i["type"] == out_type and i.get("link") is not None)
        link = links[inp["link"]]
        return _resolve(nodes, links, link[1], link[2])
    return src, slot


DROPPED = {24, 25, 27, 29, 30}  # preview-only outputs, see builder_face docstring
SUBST = {108: "ShellMaxUNETLoaderByPath", 109: "ShellMaxCLIPLoaderByPath", 4: "ShellMaxVAELoaderByPath",
         5: "ShellMaxVAELoaderByPath", 12: "ShellMaxLoraModelOnlyByPath"}


def test_every_original_link_is_reproduced():
    nodes, links = _original()
    g = build_face_prompt(default_params())
    checked = 0
    for link_id, src, slot, dst, _dslot, _t in links.values():
        dn = nodes[dst]
        if dst in DROPPED or dn.get("mode") in (2, 4):
            continue
        rsrc, rslot = _resolve(nodes, links, src, slot)
        name = next(i for i in dn["inputs"] if i.get("link") == link_id)["name"]
        assert g[str(dst)]["inputs"].get(name) == [str(rsrc), rslot], \
            f"{dn['type']}({dst}).{name}: expected [{rsrc}, {rslot}], got {g[str(dst)]['inputs'].get(name)}"
        checked += 1
    assert checked >= 35


def test_widget_values_are_reproduced():
    nodes, _ = _original()
    g = build_face_prompt(default_params())
    for nid, node in nodes.items():
        our = g.get(str(nid))
        if our is None:
            assert nid in DROPPED or node["type"] == "Note" or node.get("mode") in (2, 4), f"node {nid} missing"
            continue
        assert our["class_type"] == SUBST.get(nid, node["type"]), nid
        values = node.get("widgets_values") or []
        if isinstance(values, dict):
            values = [v for k, v in values.items() if k not in ("videopreview", "filename_prefix", "video")]
        ours = [v for v in our["inputs"].values() if not isinstance(v, list)]
        for v in values:
            if v in (None, "None", "fixed", "randomize", "image") or isinstance(v, (dict, list)):
                continue
            if isinstance(v, str) and (v.endswith((".safetensors", ".jpg", ".png")) or v.startswith("{")):
                continue  # model files become absolute paths; image + crop are user input
            if nid == 9 and v != "max":
                continue  # prompt is user input; width/height/length are linked to the tracker (stale widgets)
            assert any(v == o or (isinstance(v, float) and isinstance(o, (int, float)) and abs(v - o) < 1e-9)
                       for o in ours), f"{node['type']}({nid}): {v!r} not in {ours}"


def test_references_and_audio_wiring():
    g = build_face_prompt(default_params())
    i = g["9"]["inputs"]
    assert i["ref_images.ref_image_0"] == ["6", 0]  # <Picture 1>: identity
    assert i["ref_images.ref_image_1"] == ["7", 0]  # <Picture 2>: face close-up crop
    assert i["ref_audios.ref_audio_0"] == ["1", 2]  # <Audio 1>: the clip's own sound
    assert i["ref_image_size"] == "max"
    assert g["23"]["inputs"]["audio"] == ["1", 2]  # output keeps the original sound
    assert g["121"]["inputs"]["model"] == ["108", 0]  # sage patch (120) bypassed


def test_strength_and_seed_reach_the_sampler():
    g = build_face_prompt(default_params(denoise=0.42, seed=7))
    assert g["16"]["inputs"]["denoise"] == 0.42
    assert g["16"]["inputs"]["steps"] == 8
    assert g["17"]["inputs"]["noise_seed"] == 7
