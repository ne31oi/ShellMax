"""UI decisions -> full workflow parameters."""

from app.jobs.queue import asset_title, humanize_error
from app.workflow.params import EngineProfile, LoraSpec, ResolvedRef, UIParams, clean_path
from app.workflow.presets import default_profile, expand, resolution_for


def profile(**over) -> EngineProfile:
    base = dict(unet="F:/u.safetensors", text_encoder="F:/t.safetensors", vae_video="F:/vv.safetensors",
                vae_audio="F:/va.safetensors", upscaler="F:/up.safetensors",
                loras_main=[LoraSpec(path="F:/turbo.safetensors")],
                loras_final=[LoraSpec(path="F:/lms.safetensors", strength=0.5)])
    base.update(over)
    return EngineProfile(**base)


def test_quality_preset_maps_to_megapixels_and_scale():
    full = expand(UIParams(prompt="p", quality="draft"), profile(), [], [], seed=7, filename_prefix="x")
    assert (full.megapixels, full.upscale) == (0.3, 1.5)
    full = expand(UIParams(prompt="p"), profile(), [], [], seed=7, filename_prefix="x")
    assert (full.megapixels, full.upscale) == (0.5, 1.5)  # workflow default


def test_styles_append_to_main_chain_after_technical_loras():
    style = (LoraSpec(path="F:/cinema.safetensors", strength=0.8), ["cinematic look"])
    full = expand(UIParams(prompt="a cat"), profile(), [], [style], seed=1, filename_prefix="x")
    assert [l.path for l in full.loras_main] == ["F:/turbo.safetensors", "F:/cinema.safetensors"]
    assert full.prompt.endswith("cinematic look")
    assert [l.path for l in full.loras_final] == ["F:/lms.safetensors"]


def test_refs_pass_through_in_order():
    refs = [ResolvedRef(kind="image", path="a"), ResolvedRef(kind="video", path="b")]
    full = expand(UIParams(prompt="p"), profile(), refs, [], seed=1, filename_prefix="x")
    assert [r.path for r in full.refs] == ["a", "b"]


def test_explorer_copy_as_path_quotes_are_stripped():
    assert clean_path('"F:\\models\\x.safetensors"') == "F:\\models\\x.safetensors"
    assert profile(unet='  "F:/q.safetensors" ').unet == "F:/q.safetensors"


def test_resolution_table_standard_16_9():
    assert resolution_for("16:9 (Widescreen)", "standard") == {"base": [960, 544], "final": [1440, 832]}


def test_error_humanization():
    assert humanize_error("torch.OutOfMemoryError", "CUDA out of memory")[0] == "oom"
    assert humanize_error("FileNotFoundError", "ShellMax: файл не найден: F:/x")[1] == "файл не найден: F:/x"
    assert humanize_error("ValueError", "boom", "KSampler")[0] == "generic"


def test_asset_title_skips_header_and_tags():
    prompt = "subject_definitions:\n<Subject 1> walks in <Picture 1> city streets at night"
    assert asset_title(prompt, 3) == "walks in city streets at night"
    assert asset_title("", 3) == "Генерация 3"
    structured = "subject_definitions:\n<Subject 1> is the woman in <Picture 1>.\n\nsummary:\n[reference] A woman dances in the rain"
    assert asset_title(structured, 4) == "Woman dances in the rain"


def test_realism_lora_trigger_goes_into_visual_style():
    from app.workflow.presets import lora_triggers, with_lora_triggers

    prof = default_profile()
    assert lora_triggers(prof) == ["r34l1sm"]  # realism-people is on in the workflow's recipe
    off = prof.model_copy(update={"loras_final": [l.model_copy(update={"enabled": "realism" not in l.path})
                                                  for l in prof.loras_final]})
    assert lora_triggers(off) == []

    six = "summary:\nA.\n\ndetailed_description:\nB.\n\noverall_soundscape:\nC.\n\nnon_diegetic_music:\nN/A"
    out = with_lora_triggers(six, ["r34l1sm"])
    assert "detailed_description:\nB.\n\nvisual_style:\n\nr34l1sm.\n\noverall_soundscape:" in out
    styled = "detailed_description:\nB.\n\nvisual_style:\n\nReal footage.\n\noverall_soundscape:\nC."
    assert "visual_style:\n\nr34l1sm.\n\nReal footage." in with_lora_triggers(styled, ["r34l1sm"])
    assert with_lora_triggers(out, ["r34l1sm"]) == out  # already there: unchanged
    assert with_lora_triggers("девушка танцует", ["r34l1sm"]) == "девушка танцует\n\nr34l1sm."
