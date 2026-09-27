"""UI decisions -> full workflow parameters."""

from app.jobs.queue import asset_title, humanize_error
from app.workflow.params import EngineProfile, LoraSpec, ResolvedRef, UIParams, clean_path
from app.workflow.presets import (
    REALISM_STEM,
    default_profile,
    expand,
    resolution_for,
    with_lora_triggers,
)


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
    six = "summary:\nA.\n\ndetailed_description:\nB.\n\noverall_soundscape:\nC.\n\nnon_diegetic_music:\nN/A"
    full = expand(UIParams(prompt=six, look="social"), profile(), [], [style], seed=1, filename_prefix="x")
    assert [l.path for l in full.loras_main] == ["F:/turbo.safetensors", "F:/cinema.safetensors"]
    # Style trigger + look cues both go into visual_style (trigger first).
    assert "visual_style:\n\ncinematic look." in full.prompt
    assert "Punchy contemporary" in full.prompt
    assert full.prompt.index("cinematic look.") < full.prompt.index("Punchy contemporary")
    assert full.prompt.index("Punchy contemporary") < full.prompt.index("overall_soundscape:")
    assert not full.prompt.rstrip().endswith("cinematic look")
    assert [l.path for l in full.loras_final] == ["F:/lms.safetensors"]


def test_realism_style_goes_on_final_chain_with_trigger():
    style = (LoraSpec(path=f"F:/{REALISM_STEM}.safetensors", strength=1.0), ["r34l1sm"])
    six = "summary:\nA.\n\ndetailed_description:\nB.\n\noverall_soundscape:\nC."
    full = expand(UIParams(prompt=six, look="social"), profile(), [], [style], seed=1, filename_prefix="x")
    assert [l.path for l in full.loras_main] == ["F:/turbo.safetensors"]
    assert [l.path for l in full.loras_final] == ["F:/lms.safetensors", f"F:/{REALISM_STEM}.safetensors"]
    assert "r34l1sm." in full.prompt
    assert full.prompt.index("r34l1sm.") < full.prompt.index("overall_soundscape:")
    # Realism + look can coexist (both are photographic).
    assert "Punchy contemporary" in full.prompt


def test_default_profile_has_no_realism_lora():
    prof = default_profile()
    stems = {l.path.replace("\\", "/").rsplit("/", 1)[-1].rsplit(".", 1)[0]
             for l in [*prof.loras_main, *prof.loras_final]}
    assert REALISM_STEM not in stems
    assert any("lms" in s for s in stems)


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
    assert humanize_error("RuntimeError",
                          "Expected mha_graph.execute(handle, variant_pack, workspace_ptr.get()).is_good()")[0] == "oom"
    assert humanize_error("FileNotFoundError", "ShellMax: файл не найден: F:/x")[1] == "файл не найден: F:/x"
    assert humanize_error("ValueError", "boom", "KSampler")[0] == "generic"


def test_apply_history_status_oom():
    from app.jobs.queue import Running, apply_history_status

    r = Running(gen_id=1)
    hist = {
        "status": {
            "status_str": "error",
            "completed": False,
            "messages": [
                ["execution_start", {"prompt_id": "x"}],
                ["execution_error", {
                    "exception_type": "torch.OutOfMemoryError",
                    "exception_message": "CUDA out of memory. Tried to allocate 9.17 GiB.",
                    "node_type": "SamplerCustomAdvanced",
                }],
            ],
        }
    }
    assert apply_history_status(r, hist) is True
    assert r.done.is_set()
    assert r.error and r.error[0] == "oom"


def test_apply_history_status_empty():
    from app.jobs.queue import Running, apply_history_status

    r = Running(gen_id=1)
    assert apply_history_status(r, {}) is False
    assert not r.done.is_set()


def test_asset_title_skips_header_and_tags():
    prompt = "subject_definitions:\n<Subject 1> walks in <Picture 1> city streets at night"
    assert asset_title(prompt, 3) == "walks in city streets at night"
    assert asset_title("", 3) == "Генерация 3"
    structured = "subject_definitions:\n<Subject 1> is the woman in <Picture 1>.\n\nsummary:\n[reference] A woman dances in the rain"
    assert asset_title(structured, 4) == "Woman dances in the rain"


def test_style_triggers_go_into_visual_style():
    six = "summary:\nA.\n\ndetailed_description:\nB.\n\noverall_soundscape:\nC.\n\nnon_diegetic_music:\nN/A"
    out = with_lora_triggers(six, ["r34l1sm"])
    assert "detailed_description:\nB.\n\nvisual_style:\n\nr34l1sm.\n\noverall_soundscape:" in out
    styled = "detailed_description:\nB.\n\nvisual_style:\n\nReal footage.\n\noverall_soundscape:\nC."
    assert "visual_style:\n\nr34l1sm.\n\nReal footage." in with_lora_triggers(styled, ["r34l1sm"])
    assert with_lora_triggers(out, ["r34l1sm"]) == out  # already there: unchanged
    assert with_lora_triggers("девушка танцует", ["r34l1sm"]) == "девушка танцует\n\nr34l1sm."
