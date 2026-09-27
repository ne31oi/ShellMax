"""Expert lighting catalog (Shot Bible P8) for assistant + expand."""

from app.workflow.light import (
    LIGHT_IDS,
    apply_light,
    assistant_light_block,
    light_presets,
    normalize_light,
    user_light_directive,
)
from app.workflow.params import UIParams
from app.workflow.presets import expand
from tests.test_presets import profile


def test_presets_cover_all_ids_with_auto_first():
    presets = light_presets()
    assert [p["id"] for p in presets] == list(LIGHT_IDS)
    assert presets[0]["id"] == "auto" and presets[0]["label"] == "Авто"


def test_normalize_unknown_falls_back_to_auto():
    assert normalize_light(None) == "auto"
    assert normalize_light("nope") == "auto"
    assert normalize_light("hard_side") == "hard_side"


def test_assistant_block_forces_expert():
    auto = assistant_light_block("auto")
    assert "=== СВЕТ (эксперт) ===" in auto
    assert "ПРИНУДИТЕЛЬНО" not in auto

    block = assistant_light_block("soft_key_45")
    assert "ПРИНУДИТЕЛЬНО" in block
    assert "45" in block
    assert "Lighting geometry" in block


def test_user_light_directive():
    auto = user_light_directive("auto")
    assert "Авто" in auto and "visual_style" in auto

    forced = user_light_directive("practical_back")
    assert "ОБЯЗАТЕЛЬНО" in forced and "practical" in forced.lower()


def test_apply_light_creates_visual_style():
    base = "subject_definitions:\nA.\n\nsummary:\nB.\n\noverall_soundscape:\nC.\n\nnon_diegetic_music:\nN/A"
    out = apply_light(base, "hard_side")
    assert "visual_style:" in out
    assert "hard directional key" in out
    assert out.index("visual_style:") < out.index("overall_soundscape:")
    assert apply_light(out, "hard_side") == out


def test_apply_light_auto_is_noop():
    p = "subject_definitions:\nA.\n\noverall_soundscape:\nC."
    assert apply_light(p, "auto") == p


def test_expand_injects_light_before_look():
    full = expand(
        UIParams(
            prompt="summary:\nA walk.\n\noverall_soundscape:\nAmbience.",
            look="cinema",
            light="soft_key_45",
        ),
        profile(),
        [],
        [],
        seed=1,
        filename_prefix="x",
    )
    assert "Lighting geometry: large soft key" in full.prompt
    assert "motivated key light" in full.prompt
    assert full.prompt.index("Lighting geometry") < full.prompt.index("motivated key light")
