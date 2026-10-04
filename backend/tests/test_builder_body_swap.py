"""Compare every operative author link/widget; check fragment and reference provenance."""
import json
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app import body_swap_jobs, settings
from app.jobs.registry import get_handler, pipeline_for
from app.workflow import body_swap
from app.workflow.builder_body_swap import build_body_swap_prompt
from app.workflow.fantastic import MediaSource

ROOT = Path(__file__).resolve().parents[2]


def params(**updates):
    values = dict(source_path="source.mp4", sources=[MediaSource(path="front.png", file="front.png", kind="picture"),
        MediaSource(path="side.png", file="side.png", kind="picture")],
        models={key: str(path) for key, path in body_swap.model_paths().items()}, start=1, end=1+39/24,
        frames=39, subject="person", prompt="replacement", seed=42, has_audio=True,
        composite_weights_dir=str(body_swap.composite_dir()),face_detector_path="track.onnx")
    return body_swap.BodySwapFull(**(values | updates))


def test_all_retained_author_links_and_values():
    upstream = json.loads((ROOT / "workflows/H3_BODY_SWAP_MATCHED_HANDS.json").read_text(encoding="utf-8"))
    original = {str(n["id"]): n for n in upstream["nodes"]}
    links = {l[0]: (str(l[1]), l[2]) for l in upstream["links"]}
    setters = {n["widgets_values"][0]: n for n in original.values() if n["type"] == "SetNode"}
    def resolve(nid, slot):
        n = original[nid]
        if n["type"] == "GetNode":
            return resolve(*links[setters[n["widgets_values"][0]]["inputs"][0]["link"]])
        if n["type"] in ("SetNode", "Reroute"):
            return resolve(*links[n["inputs"][0]["link"]])
        if nid == "1186":
            return {1: ["1191", 1], 2: ["1258", 0], 3: ["1191", 2]}[slot]
        return [nid, slot]
    graph = build_body_swap_prompt(params())
    loaders = {"1199": ("unet_name", "unet_path", "unet"), "1188": ("clip_name", "clip_path", "text_encoder"),
        "1117": ("vae_name", "vae_path", "vae_video"), "1118": ("vae_name", "vae_path", "vae_audio"),
        "1190": ("ckpt_name", "checkpoint_path", "sam"), "1201": ("lora_name", "lora_path", "turbo"),
        "1280": ("bg_removal_name", "model_path", "background"), "1442": ("name", "model_path", "controlnet")}
    substitutions = {("1242", "image"), ("1243", "image"), ("1127", "text"), ("1154", "prompt"),
                     ("1198", "seed"), ("1277", "filename_prefix")}
    for nid, node in graph.items():
        if nid in ("1191", "body_restore"):
            continue
        author = original[nid]
        for inp in author["inputs"]:
            if inp["link"] is None:
                continue
            key = inp["name"]
            if nid == "1277" and key in ("images", "audio"):
                continue
            assert node["inputs"][key] == resolve(*links[inp["link"]]), (nid, key)
        widgets = author.get("widgets_values") or []
        if isinstance(widgets, dict):
            values = widgets
        else:
            if nid == "1198": widgets = [widgets[0], *widgets[2:]]
            names = [i["name"] for i in author["inputs"] if i.get("widget")]
            values = dict(zip(names, widgets))
        for key, value in values.items():
            if key == "upload" or (nid, key) in substitutions:
                continue
            inp = next((i for i in author["inputs"] if i["name"] == key), None)
            if inp and inp["link"] is not None:
                continue
            if nid in loaders and key == loaders[nid][0]:
                _, path_key, model_key = loaders[nid]
                assert Path(node["inputs"][path_key]).name == Path(value).name
                assert Path(settings.defaults()["body_swap"]["models"][model_key]).name == Path(value).name
            else:
                assert node["inputs"][key] == value, (nid, key)
        for value in node["inputs"].values():
            if isinstance(value, list): assert value[0] in graph
    assert graph["1277"]["inputs"]["images"] == ["body_restore", 0]
    assert graph["1277"]["inputs"]["audio"] == ["1191", 2]
    assert graph["body_restore"]["inputs"]["hands"] == ["1438", 0]
    assert graph["body_restore"]["inputs"]["source"] == ["1258", 0]
    assert graph["1440"]["inputs"]["operation"] == "subtract"
    assert graph["1211"]["inputs"]["resize_method"] == "auto"
    assert graph["1273"]["inputs"]["resize_method"] == "auto"
    assert graph["1150"]["inputs"]["grow_temp_mode"] == "both"


def test_registry_template_defaults_and_silent_export():
    graph = get_handler("body_swap").build(params())
    pipe = pipeline_for("body_swap")
    assert pipe.final_node == "1277" and pipe.sampler_nodes == ("1198",)
    assert sum(pipe.stage_weight.values()) == pytest.approx(1)
    assert set(pipe.stage_by_node) - set(graph) == {"body_background","body_fit","body_old_alpha"}
    assert "audio" not in build_body_swap_prompt(params(has_audio=False))["1277"]["inputs"]
    golden = json.loads((ROOT / "workflows/ShellMax_BodySwap.api.json").read_text())
    replacements = {"__SOURCE__": "source.mp4", "__FRONT__": "front.png", "__SIDE__": "side.png",
        "__START__": 1, "__FRAMES__": 39, "__HAS_AUDIO__": True, "__PROMPT__": "replacement",
        "__SUBJECT__": "person", "__SEED__": 42, "__PREFIX__": params().filename_prefix,
        **{f"__{k.upper()}__": v for k, v in params().models.items()}}
    for node in golden.values():
        for key, value in list(node["inputs"].items()):
            if isinstance(value, str) and value in replacements: node["inputs"][key] = replacements[value]
    assert graph == golden
    d = settings.defaults()["body_swap"]
    for key, nid, field in [("steps", "1198", "steps"), ("cfg", "1198", "cfg"), ("sampler", "1198", "sampler_name"),
        ("scheduler", "1198", "scheduler"), ("shift_video", "1202", "shift_video"), ("shift_audio", "1202", "shift_audio"),
        ("control_strength", "1443", "strength"), ("crop_megapixels", "1211", "upscale_megapixels"),
        ("frame_rate", "1277", "frame_rate"), ("crf", "1277", "crf")]:
        assert d[key] == graph[nid]["inputs"][field]


@pytest.mark.parametrize("duration,frames", [(0.1, 0), (5/24, 5), (22/24, 22), (2, 39), (175/24, 175), (100, 175)])
def test_grid_never_extends_requested_fragment(duration, frames):
    assert body_swap.fragment_frames(duration) == frames
    assert frames / 24 <= duration + 1e-6


def test_reference_validation_fragment_and_provenance(tmp_path, monkeypatch):
    photo = tmp_path / "photo.png"
    photo.touch()
    identity = SimpleNamespace(kind="image", path=str(photo), refmod_file=None)
    asset = SimpleNamespace(id=7, path="source.mp4", width=896, height=512, duration=10, fps=30, has_audio=True)
    monkeypatch.setattr(body_swap_jobs, "source_asset", lambda aid, pid: asset)
    @contextmanager
    def session(): yield SimpleNamespace(get=lambda cls, uid: identity)
    monkeypatch.setattr(body_swap_jobs, "session", session)
    monkeypatch.setattr(body_swap, "missing_models", lambda variant="ref2va": [])
    ui = body_swap.BodySwapUI(source_asset_id=7, front_upload_id="front", side_upload_id="side", start=1, end=3, seed=42)
    g = body_swap_jobs.expand(ui, 4)
    assert g.kind == "body_swap" and g.project_id == 4 and g.source_asset_id == 7
    assert g.ui_params["front_upload_id"] == "front" and g.ui_params["side_upload_id"] == "side"
    assert g.full_params["start"] == 1 and g.full_params["end"] == 1+39/24 and g.full_params["frames"] == 39
    assert g.seed == 42 and g.full_params["has_audio"]
    assert g.full_params["recipe_version"] == 6
    assert g.full_params["composite_weights_dir"] == str(body_swap.composite_dir())
    assert g.full_params["face_detector_path"] == str(body_swap.YUNET_PATH)
    assert len(g.full_params["sources"]) == 2
    sg = body_swap_jobs.expand_singularity(ui, 4)
    assert sg.kind == "body_swap_singularity" and sg.seed == g.seed
    assert sg.full_params["variant"] == "singularity" and sg.full_params["frames"] == 39
    # The fragment may come from a long video; H3 limits duration, not the source offset.
    asset.duration = 300
    late = body_swap_jobs.expand(ui.model_copy(update={"start": 200, "end": 202}), 4)
    assert late.full_params["start"] == 200 and late.full_params["frames"] == 39
    body_swap.BodySwapUI(source_asset_id=7, front_upload_id="front", side_upload_id="side", start=200, end=202)
    asset.duration = 10
    with pytest.raises(HTTPException, match="за пределы"):
        body_swap_jobs.expand(ui.model_copy(update={"end": 11}), 4)
    with pytest.raises(HTTPException, match="7,29"):
        body_swap_jobs.expand(ui.model_copy(update={"end": 9}), 4)
    with pytest.raises(HTTPException, match="короткий"):
        body_swap_jobs.expand(ui.model_copy(update={"end": 1.1}), 4)
    identity.refmod_file = "bundle.refmod"
    with pytest.raises(HTTPException, match="фотографии"):
        body_swap_jobs.expand(ui, 4)
    with pytest.raises(ValidationError):
        body_swap.BodySwapUI(source_asset_id=7, front_upload_id="front", side_upload_id="side", start=2, end=1)


def test_partial_weights_not_ready(tmp_path, monkeypatch):
    path = tmp_path / "body.safetensors"
    monkeypatch.setattr(body_swap, "model_paths", lambda variant="ref2va": {"unet": path})
    monkeypatch.setattr(body_swap, "manifest", lambda: {"unet": {"size": 4}})
    monkeypatch.setattr(body_swap, "missing_composite", lambda: [])
    detector=tmp_path/"yunet.onnx"
    detector.touch()
    monkeypatch.setattr(body_swap,"YUNET_PATH",detector)
    path.write_bytes(b"123")
    assert body_swap.missing_models() == [path.name]
    path.write_bytes(b"1234")
    assert not body_swap.missing_models()


@pytest.mark.parametrize("version,filename,config_key", [
    (2, "ShellMax_BodySwap_Full.api.json", "full_base"),
    (3, "ShellMax_BodySwap_Full_Reference.api.json", "full_reference"),
    (4, "ShellMax_BodySwap_Complete.api.json", "full_coverage"),
    (5, "ShellMax_BodySwap_Background.api.json", "full_background"),
    (6, "ShellMax_BodySwap_Fitted.api.json", "full"),
])
def test_full_character_recipe_matches_workflow_and_removes_source_hands(version, filename, config_key):
    p = params(recipe_version=version)
    graph = build_body_swap_prompt(p)
    golden = json.loads((ROOT / "workflows" / filename).read_text())
    replacements = {"__SOURCE__": p.source_path, "__FRONT__": p.sources[0].file, "__SIDE__": p.sources[1].file,
        "__START__": p.start, "__FRAMES__": p.frames, "__HAS_AUDIO__": p.has_audio, "__PROMPT__": p.prompt,
        "__SUBJECT__": p.subject, "__SEED__": p.seed, "__PREFIX__": p.filename_prefix,
        "__COMPOSITE_WEIGHTS__": p.composite_weights_dir,
        "__FACE_DETECTOR__": p.face_detector_path,
        **{f"__{key.upper()}__": value for key, value in p.models.items()}}
    for node in golden.values():
        for key, value in list(node["inputs"].items()):
            if isinstance(value, str) and value in replacements: node["inputs"][key] = replacements[value]
    assert graph == golden
    for node in graph.values():
        for value in node["inputs"].values():
            if isinstance(value, list): assert value[0] in graph
    d = settings.defaults()["body_swap"][config_key]
    assert graph["1198"]["inputs"]["steps"] == d["steps"]
    assert graph["1198"]["inputs"]["cfg"] == d["cfg"]
    assert graph["1443"]["inputs"]["strength"] == d["control_strength"]
    assert graph["1443"]["inputs"]["mask"] == ["1211", 1]
    assert graph["1443"]["inputs"]["source_video"] == ["1211", 0]
    if version >= 4:
        assert graph["1211"]["inputs"]["masks"] == ["body_coverage", 0]
        assert graph["body_coverage"]["inputs"]["mask"] == ["1136", 0]
        assert graph["body_coverage"]["inputs"]["expand"] == d["mask_grow"]
    else:
        assert graph["1211"]["inputs"]["masks"] == ["1136", 0]
    assert graph["body_union"]["inputs"]["destination"] == ["1211", 1]
    assert graph["body_union"]["inputs"]["source"] == (["body_fit",1] if version==6 else ["1281", 0])
    assert graph["1277"]["inputs"]["images"] == ["1273", 0]
    if version == 5:
        assert graph["body_background"]["inputs"] == {
            "source": ["1211", 0], "donor": ["1216", 0], "coverage": ["1211", 1],
            "alpha": ["1281", 0], "weights_dir": p.composite_weights_dir}
        assert graph["1273"]["inputs"]["cropped_images"] == ["body_background", 0]
        assert pipeline_for("body_swap").stage_by_node["body_background"] == "stitch"
    if version == 6:
        assert graph["body_old_alpha"]["inputs"]["image"]==["1211",0]
        assert graph["body_fit"]["inputs"]=={
            "source":["1211",0],"donor":["1216",0],"source_alpha":["body_old_alpha",0],"alpha":["1281",0],
            "detector_path":p.face_detector_path,"background_radius":d["background_radius"],"background_margin":d["background_margin"]}
        assert graph["1273"]["inputs"]["cropped_images"]==["body_fit",0]
        assert "body_background" not in graph
        assert pipeline_for("body_swap").stage_by_node["body_fit"]=="stitch"
    assert not any("RestoreHands" in n["class_type"] for n in graph.values())
    assert any("Lora" in n["class_type"] for n in graph.values()) == d["turbo"]
    if version >= 3:
        assert graph["1443"]["inputs"]["end_percent"] == d["control_end"]
        assert graph["1446"]["inputs"]["detect_face"] == "disable"
    assert "audio" not in build_body_swap_prompt(params(recipe_version=version, has_audio=False))["1277"]["inputs"]


def test_background_runtime_is_required_before_queueing(tmp_path,monkeypatch):
    monkeypatch.setattr(body_swap, "model_paths", lambda variant="ref2va": {})
    monkeypatch.setattr(body_swap, "manifest", lambda: {})
    monkeypatch.setattr(body_swap, "missing_composite", lambda: ["ProPainter.pth"])
    detector=tmp_path/"yunet.onnx"
    detector.touch()
    monkeypatch.setattr(body_swap,"YUNET_PATH",detector)
    assert body_swap.missing_models() == ["ProPainter.pth"]


def test_head_registration_detector_is_required(tmp_path,monkeypatch):
    monkeypatch.setattr(body_swap,"model_paths",lambda variant="ref2va":{})
    monkeypatch.setattr(body_swap,"manifest",lambda:{})
    monkeypatch.setattr(body_swap,"missing_composite",lambda:[])
    monkeypatch.setattr(body_swap,"YUNET_PATH",tmp_path/"missing.onnx")
    assert body_swap.missing_models()==["yunet.onnx"]


def test_reference_roles_do_not_claim_mannequin_and_portrait_are_two_views():
    prompt = body_swap.replacement_prompt("Black leather jacket.")
    assert "<Picture 1> -> <Subject 1>: attribute_transfer" in prompt
    assert "<Picture 2> -> <Subject 1>: partially_preserved" in prompt
    assert "Both pictures show one person" not in prompt
    assert "including hands" in prompt
    assert "Black leather jacket." in prompt
    assert "overall_soundscape:\nSilence." in prompt
    assert "shot lasts 0.917 seconds" in body_swap.replacement_prompt("",22/24,True)
    assert "Preserve the source sound" in body_swap.replacement_prompt("",22/24,True)
