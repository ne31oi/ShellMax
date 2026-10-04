"""Check the API adapter against the author workflow, including every retained link."""
import json
import importlib.util
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app import settings
from app.jobs.registry import get_handler, pipeline_for
from app.workflow.builder_head_swap import build_head_swap_prompt
from app.workflow.fantastic import MediaSource
from app.workflow.head_swap import HeadSwapFull
from app.workflow.head_swap import model_paths
from app.workflow import head_swap
from app import head_swap_jobs

ROOT = Path(__file__).resolve().parents[2]


def params(**updates):
    return HeadSwapFull(source_path="source.mp4", sources=[MediaSource(path="face.png", file="face.png", kind="picture")],
        models={key: str(path) for key, path in model_paths().items()},
        seed=42, frame_rate=24, has_audio=True, **updates)


def test_every_retained_upstream_link_and_value():
    upstream = json.loads((ROOT / "workflows/minimax_h3_head_swap_workflow.json").read_text())
    nodes = {str(n["id"]): n for n in upstream["nodes"]}
    links = {l[0]: (str(l[1]), l[2]) for l in upstream["links"]}
    setters = {n["widgets_values"][0]: n for n in nodes.values() if n["type"] == "SetNode"}
    def resolve(nid, slot):
        n = nodes[nid]
        if n["type"] == "GetNode":
            setter = setters[n["widgets_values"][0]]
            return resolve(*links[setter["inputs"][0]["link"]])
        if n["type"] == "SetNode" or n.get("mode") == 4:
            return resolve(*links[n["inputs"][0]["link"]])
        if nid in ("194", "742"):
            return resolve(*links[n["inputs"][0]["link"]])
        if nid == "821":  # apply_upscale_second_pass = True in author workflow
            return resolve(*links[n["inputs"][1]["link"]])
        return [nid, slot]
    graph = build_head_swap_prompt(params())
    # Source geometry is padded, not resized/resampled to the author's demo settings.
    geometry = {"362", "289", "400", "587", "530"}
    substitutions = {"2": {"unet_path": "unet"}, "1": {"clip_path": "text_encoder"},
        "85": {"clip_path": "vision_encoder"}, "3": {"vae_path": "vae_video"},
        "29": {"vae_path": "vae_audio"}, "64": {"lora_path": "turbo"},
        "586": {"lora_path": "head_lora"}, "484": {"lora_path": "lms"}, "530": {"model_path": "upscaler"}}
    for nid, node in graph.items():
        if nid in {"head_pad", "head_restore", "539", "320"}:
            continue
        original = nodes[nid]
        for inp in original.get("inputs", []):
            if inp["link"] is None:
                continue
            key = inp["name"]
            expected = resolve(*links[inp["link"]])
            if nid in geometry and (key in {"width", "height", "length", "mode.width", "mode.height"}):
                continue
            if key == "image" and nid in {"81", "548"}:
                assert node["inputs"][key] == ["head_pad", 0]
                continue
            if key == "audio" and nid in {"81", "548"}:
                # The demo switches to EmptyAudio. ShellMax preserves the actual soundtrack.
                assert node["inputs"][key] == ["320", 2]
                continue
            assert node["inputs"][key] == expected, (nid, key, expected)
        for key, value in node["inputs"].items():
            if isinstance(value, list):
                assert value[0] in graph
            if key in substitutions.get(nid, {}):
                assert Path(value).name == Path(settings.defaults()["head_swap"]["models"][substitutions[nid][key]]).name
        if nid in {"1", "3", "29", "586", "484"}:
            stock = original["widgets_values"]
            assert Path(node["inputs"][next(iter(substitutions[nid]))]).name == Path(stock[0].replace("\\", "/")).name
    # Freeze all operative widget values directly from the upstream JSON.
    for nid, keys in {"9": ["shift_video", "shift_audio"], "58": ["attention"],
        "11": ["cfg"], "15": ["sampler_name"], "181": ["scheduler", "steps", "denoise"],
        "535": ["sigmas"], "829": ["string_a"], "550": ["string_b"], "830": ["string_b"]}.items():
        stock = nodes[nid]["widgets_values"]
        if nid in {"550", "830"}: stock = stock[1:]
        for key, value in zip(keys, stock): assert graph[nid]["inputs"][key] == value
    for nid in ("64", "586", "484"):
        assert graph[nid]["inputs"]["strength_model"] == nodes[nid]["widgets_values"][1]
    keys = ["prompt", "max_length", "sampling_mode", "sampling_mode.temperature", "sampling_mode.top_k",
        "sampling_mode.top_p", "sampling_mode.min_p", "sampling_mode.repetition_penalty", "sampling_mode.seed",
        "sampling_mode.presence_penalty", "thinking", "use_default_template"]
    assert [graph["826"]["inputs"][k] for k in keys] == nodes["826"]["widgets_values"][:12]
    assert graph["826"]["inputs"]["image"] == ["362", 0]
    assert not any(k.startswith("ref_videos") for nid in ("400", "587") for k in graph[nid]["inputs"])
    assert all(graph[nid]["inputs"]["frame_idx"] == 0 for nid in ("81", "548"))
    # User explicitly requested existing weights instead of the author's downloads.
    d = settings.defaults()
    m = d["head_swap"]["models"]
    assert m["unet"] == d["engine"]["unet"]
    assert m["turbo"] == d["engine"]["loras_main"][0]["path"]
    assert m["upscaler"] == d["engine"]["upscaler"]
    assert Path(m["vision_encoder"]).name == "qwen3vl_4b_INT8_ConvRot_HQ.safetensors"
    assert graph["85"]["inputs"]["type"] == "ltxv"
    from app.workflow.head_swap import manifest
    assert set(manifest()) == {"head_lora"}


def test_registry_output_audio_and_recipe_defaults():
    p = params()
    graph = get_handler("head_swap").build(p)
    pipe = pipeline_for("head_swap")
    assert pipe.final_node == "539" and pipe.sampler_nodes == ("14", "537")
    assert sum(pipe.stage_weight.values()) == pytest.approx(1)
    for nid in ("81", "548", "539"):
        assert graph[nid]["inputs"]["audio"] == ["320", 2]
    assert graph["320"]["inputs"]["frame_load_cap"] == 0
    assert graph["320"]["inputs"]["force_rate"] == 0
    silent = build_head_swap_prompt(p.model_copy(update={"has_audio": False, "frame_rate": 30}))
    assert silent["539"]["inputs"]["frame_rate"] == 30
    assert all("audio" not in silent[nid]["inputs"] for nid in ("81", "548", "539"))
    d = settings.defaults()["head_swap"]
    for key, nid, field in [("head_strength", "586", "strength_model"), ("turbo_strength", "64", "strength_model"),
        ("lms_strength", "484", "strength_model"), ("steps", "181", "steps"), ("scheduler", "181", "scheduler"),
        ("sigmas_second", "535", "sigmas"), ("ref_image_size", "400", "ref_image_size"), ("crf", "539", "crf")]:
        assert d[key] == graph[nid]["inputs"][field]


def test_partial_lora_and_missing_existing_weights_are_not_ready(tmp_path, monkeypatch):
    lora = tmp_path / "head.safetensors"
    vision = tmp_path / "vision.safetensors"
    monkeypatch.setattr(head_swap, "model_paths", lambda: {"head_lora": lora, "vision_encoder": vision})
    monkeypatch.setattr(head_swap, "manifest", lambda: {"head_lora": {"size": 4}})
    monkeypatch.setattr(head_swap, "missing_composite", lambda: [])
    lora.write_bytes(b"123")
    assert head_swap.missing_models() == [lora.name, vision.name]
    lora.write_bytes(b"1234")
    vision.touch()
    assert not head_swap.missing_models()


def test_temporal_compositor_requires_complete_weights_and_pinned_runtime(tmp_path, monkeypatch):
    weights = tmp_path / "weights"
    weights.mkdir()
    spec = {"weights": [{"name": "matanyone2.pth", "size": 4}],
            "sources": {"matanyone2": {"repo": "official", "commit": "pinned"}}}
    monkeypatch.setattr(head_swap, "composite_manifest", lambda: spec)
    monkeypatch.setattr(head_swap, "composite_dir", lambda: weights)
    monkeypatch.setattr(settings, "ROOT", tmp_path)
    (weights / "matanyone2.pth").write_bytes(b"123")
    assert head_swap.missing_composite() == ["matanyone2.pth", "matanyone2 (код обработки)"]
    marker = tmp_path / "comfy/head_swap_runtime/matanyone2/shellmax_revision.json"
    marker.parent.mkdir(parents=True)
    marker.write_text(json.dumps(spec["sources"]["matanyone2"]))
    (weights / "matanyone2.pth").write_bytes(b"1234")
    assert head_swap.missing_composite() == []
    marker.write_text("incomplete download")
    assert head_swap.missing_composite() == ["matanyone2 (код обработки)"]


def test_job_preserves_identity_provenance_and_rejects_refmod(tmp_path, monkeypatch):
    photo = tmp_path / "photo.png"
    photo.touch()
    identity = SimpleNamespace(kind="image", path=str(photo), refmod_file=None)
    asset = SimpleNamespace(id=7, path="source.mp4", width=896, height=512,
                            duration=22/24, fps=24, has_audio=True)
    monkeypatch.setattr(head_swap_jobs, "source_asset", lambda aid, pid: asset)
    @contextmanager
    def session():
        yield SimpleNamespace(get=lambda cls, row_id: identity)
    monkeypatch.setattr(head_swap_jobs, "session", session)
    monkeypatch.setattr(head_swap, "missing_models", lambda: [])
    target = head_swap.HeadSwapTarget(frame_index=0, box=head_swap.HeadBox(x=0.1, y=0.1, w=0.3, h=0.4))
    ui = head_swap.HeadSwapUI(source_asset_id=7, identity_upload_id="identity", seed=42, target=target)
    g = head_swap_jobs.expand(ui, 4)
    assert g.kind == "head_swap" and g.source_asset_id == 7 and g.project_id == 4
    assert g.full_params["sources"][0]["path"] == str(photo)
    assert g.full_params["has_audio"] and g.full_params["frame_rate"] == 24
    assert g.seed == 42
    assert g.full_params["target"] == target.model_dump()
    with pytest.raises(HTTPException, match="Обведите голову"):
        head_swap_jobs.expand(ui.model_copy(update={"target": None}), 4)
    with pytest.raises(HTTPException, match="за пределами"):
        head_swap_jobs.expand(ui.model_copy(update={"target": target.model_copy(update={"frame_index": 22})}), 4)
    identity.refmod_file = "face.refmod"
    with pytest.raises(HTTPException) as error:
        head_swap_jobs.expand(ui, 4)
    assert error.value.status_code == 422


def test_selected_head_graph_isolates_source_and_keeps_both_author_sampler_passes():
    target = head_swap.HeadSwapTarget(frame_index=12, box=head_swap.HeadBox(x=0.6, y=0.1, w=0.2, h=0.35))
    legacy = build_head_swap_prompt(params())
    graph = build_head_swap_prompt(params(target=target))
    golden = json.loads((ROOT / "workflows/ShellMax_HeadSwap_Target.api.json").read_text())
    assert set(graph) == set(golden)
    for nid in legacy:
        if nid not in {"head_pad", "head_restore", "539"}:
            assert graph[nid] == legacy[nid], nid
    assert graph["head_pad"]["inputs"]["images"] == ["head_track", 0]
    assert graph["head_restore"]["inputs"]["source"] == ["head_track", 0]
    track = graph["head_track"]["inputs"]
    assert json.loads(track["target"]) == target.model_dump()
    assert track["images"] == ["320", 0]
    cfg = settings.defaults()["head_swap"]["target"]
    for key in ("detector", "confidence", "identity_threshold", "canvas", "crop_factor", "smooth_window", "size_smooth_window"):
        assert track[key] == cfg[key] == golden["head_track"]["inputs"][key]
    stitch = graph["head_stitch"]["inputs"]
    assert stitch["base_images"] == ["320", 0]
    assert stitch["masks"] == ["head_composite", 0]
    assert stitch["transform"] == ["head_track", 1]
    assert stitch["refined_crops"] == ["head_composite", 1]
    assert graph["head_stitch"]["class_type"] == "ShellMaxH3HeadSwapStitch"
    assert stitch["source_foreground"] == ["head_composite", 3]
    assert graph["head_masks"]["inputs"]["selection_masks"] == ["head_track", 7]
    assert graph["head_masks"]["inputs"]["refined_crops"] == ["head_restore", 0]
    assert graph["head_masks"]["inputs"]["source_crops"] == ["head_track", 0]
    assert graph["head_masks"]["inputs"]["threshold"] == cfg["mask_threshold"]
    assert graph["head_composite"]["inputs"]["edge_grow"] == cfg["mask_edge_grow"]
    assert graph["head_masks"]["class_type"] == "ShellMaxH3HeadSwapContours"
    assert graph["head_composite"]["class_type"] == "ShellMaxH3HeadSwapTemporal"
    assert graph["head_composite"]["inputs"]["contours"] == ["head_masks", 0]
    assert Path(graph["head_composite"]["inputs"]["weights_dir"]) == head_swap.composite_dir()
    assert graph["539"]["inputs"]["images"] == ["head_stitch", 0]
    assert graph["539"]["inputs"]["audio"] == ["320", 2]
    assert graph["head_preview"]["inputs"]["save_output"] is False
    overrides = {
        ("head_track", "target"): target.model_dump_json(),
        ("head_preview", "frame_rate"): 24,
        ("head_preview", "filename_prefix"): params().filename_prefix + "_track",
        ("head_composite", "weights_dir"): str(head_swap.composite_dir()),
    }
    for nid in ("head_track", "head_masks", "head_composite", "head_stitch", "head_preview", "head_report"):
        assert graph[nid]["class_type"] == golden[nid]["class_type"]
        assert graph[nid]["inputs"] == {
            key: overrides.get((nid, key), value) for key, value in golden[nid]["inputs"].items()
        }, nid
    for key in ("feather", "colour_match", "blend"):
        assert stitch[key] == cfg[key]
    assert stitch["colour_match"] == 0
    assert Path(graph["head_sam"]["inputs"]["checkpoint_path"]).name == "sam3.pt"
    assert graph["head_masks"]["inputs"]["model"] == ["head_sam", 0]
    assert graph["head_masks"]["inputs"]["clip"] == ["head_sam", 1]
    assert graph["head_report"]["inputs"]["source"] == ["head_composite", 2]
    stages = list(pipeline_for("head_swap").stage_weight)
    assert stages.index("decode") < stages.index("mask") < stages.index("stitch")
    assert pipeline_for("head_swap").stage_by_node["head_sam"] == "load"
    assert pipeline_for("head_swap").stage_by_node["head_composite"] == "mask"
    assert graph["head_track"]["inputs"]["canvas"] == 0
    old_saved = params(target=target)
    old_saved.models.pop("sam")
    assert build_head_swap_prompt(old_saved) == graph
    assert pipeline_for("head_swap").draft_node == "head_preview"
    assert pipeline_for("head_swap").report_node == "head_report"
    for nid, node in graph.items():
        for value in node["inputs"].values():
            if isinstance(value, list):
                assert value[0] in graph
            if isinstance(value, str):
                assert not value.startswith("__"), (nid, value)


def test_source_rectangle_chooses_right_person_and_follows_face_scale():
    spec = importlib.util.spec_from_file_location("head_geometry", ROOT / "comfy_nodes/shellmax_nodes/head_swap_geometry.py")
    geometry = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(geometry)
    left = (100, 100, 180, 200)
    right = (500, 100, 580, 200)
    head = (480, 60, 120, 150)
    assert geometry.select_face([left, right], head) == right
    assert geometry.select_face([right, left], head) == right
    relative = geometry.head_region(head, right)
    assert geometry.region_in_canvas(relative, (200, 200, 160, 200)) == (160, 120, 240, 300)
    with pytest.raises(ValueError, match="несколько лиц"):
        geometry.select_face([left, right], (0, 0, 700, 300))
    with pytest.raises(ValueError, match="не найдено"):
        geometry.select_face([left, right], (250, 50, 100, 200))


def test_target_box_stays_inside_video_and_validates_frame_index():
    from pydantic import ValidationError
    for values in ({"x": 0.9, "y": 0, "w": 0.2, "h": 0.2}, {"x": 0, "y": 0, "w": 0, "h": 1}):
        with pytest.raises(ValidationError):
            head_swap.HeadBox(**values)
    with pytest.raises(ValidationError):
        head_swap.HeadSwapTarget(frame_index=-1, box=head_swap.HeadBox(x=0, y=0, w=1, h=1))
