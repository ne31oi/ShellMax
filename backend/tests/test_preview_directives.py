"""Preview → H3 hard directives (same profiles as the 3D cinema preview)."""

from app.workflow.preview_directives import (
    h3_directive_for_technique,
    preview_lock_preamble,
)


def test_extreme_wide_and_worms_eye_are_positive_locks():
    els = h3_directive_for_technique("t3_1")
    assert "SHOT SIZE LOCK" in els
    assert "extreme long shot" in els.lower() or "extreme wide" in els.lower()
    assert "FORBIDDEN" not in els
    assert "close-up" not in els.lower()

    worms = h3_directive_for_technique("t4_5")
    assert "ANGLE LOCK" in worms and "worm" in worms.lower()
    assert "0.12" in worms
    assert "FORBIDDEN" not in worms
    assert "eye-level" not in worms.lower()


def test_preview_directives_never_list_negatives():
    from app.workflow.cinematography import cinematic_technique_presets

    banned = ("FORBIDDEN", "do not", "don't", "NEGATIVE:", "never ")
    for item in cinematic_technique_presets():
        if item["id"] == "auto":
            continue
        line = h3_directive_for_technique(item["id"]).lower()
        for word in banned:
            assert word.lower() not in line, (item["id"], word, line)
    preamble = preview_lock_preamble().lower()
    for word in ("do not", "don't", "forbidden"):
        assert word not in preamble


def test_dolly_and_hard_light_carry_preview_geometry():
    dolly = h3_directive_for_technique("t2_3")
    assert "CAMERA MOTION LOCK" in dolly
    assert "dolly" in dolly.lower()
    assert "depth" in dolly.lower() or "end_z" in dolly or "depthΔ" in dolly

    hard = h3_directive_for_technique("t7_10")
    assert "LIGHT LOCK" in hard and "hard" in hard.lower()
    assert "visual_style" in hard.lower()
    assert "keyI=" not in hard and "fillI=" not in hard
    assert "softness=" not in hard


def test_every_preview_profile_yields_a_nonempty_lock():
    from app.workflow.cinematography import cinematic_technique_presets

    for item in cinematic_technique_presets():
        if item["id"] == "auto":
            continue
        line = h3_directive_for_technique(item["id"])
        assert line.strip(), item["id"]
        assert "PREVIS LOCK" in preview_lock_preamble()
