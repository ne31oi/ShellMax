"""Look / delivery presets inject cinematic cues into visual_style."""

from app.workflow.look import apply_look, normalize_look
from app.workflow.params import UIParams
from app.workflow.presets import expand
from tests.test_presets import profile


def test_normalize_unknown_look():
    assert normalize_look("nope") == "natural"
    assert normalize_look("cinema") == "cinema"


def test_apply_look_creates_visual_style():
    base = "subject_definitions:\nA.\n\nsummary:\nB.\n\noverall_soundscape:\nC.\n\nnon_diegetic_music:\nN/A"
    out = apply_look(base, "cinema")
    assert "visual_style:" in out
    assert "motivated key light" in out
    assert out.index("visual_style:") < out.index("overall_soundscape:")
    # idempotent
    assert apply_look(out, "cinema") == out


def test_apply_look_natural_is_noop():
    p = "subject_definitions:\nA.\n\noverall_soundscape:\nC."
    assert apply_look(p, "natural") == p


def test_expand_injects_cinema_look():
    full = expand(UIParams(prompt="summary:\nA walk.\n\noverall_soundscape:\nAmbience.", look="cinema"),
                  profile(), [], [], seed=1, filename_prefix="x")
    assert "motivated key light" in full.prompt
