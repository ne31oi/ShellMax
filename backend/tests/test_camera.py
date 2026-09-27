"""Camera technique catalog for the assistant (HSE → H3)."""

from app.workflow.camera import (
    CAMERA_IDS,
    assistant_camera_block,
    camera_presets,
    normalize_camera,
)


def test_presets_cover_all_ids_with_auto_first():
    presets = camera_presets()
    assert [p["id"] for p in presets] == list(CAMERA_IDS)
    assert presets[0]["id"] == "auto" and presets[0]["label"] == "Авто"
    dutch = next(p for p in presets if p["id"] == "dutch_angle")
    assert dutch["emotion"] and dutch["hint"]


def test_normalize_unknown_falls_back_to_auto():
    assert normalize_camera(None) == "auto"
    assert normalize_camera("nope") == "auto"
    assert normalize_camera("snorricam") == "snorricam"


def test_assistant_block_forces_expert_over_text():
    auto = assistant_camera_block("auto")
    assert "экспертный выбор ниже" in auto
    assert "Сейчас эксперт: auto" in auto
    assert "ПРИНУДИТЕЛЬНО" not in auto
    assert "одно главное движение камеры" in auto or "ОДИН приём" in auto

    block = assistant_camera_block("dolly_zoom")
    assert "ПРИНУДИТЕЛЬНО" in block
    assert "subject size" in block.lower() or "approximately constant" in block
    assert "противоречащие указания" in block
    assert "NEGATIVE" in block
    assert "height" in block.lower() or "0." in block


def test_user_camera_directive_for_compose():
    from app.workflow.camera import user_camera_directive

    auto = user_camera_directive("auto")
    assert "Авто" in auto and "dynamic camera" in auto

    forced = user_camera_directive("snorricam")
    assert "ОБЯЗАТЕЛЬНО" in forced and "snorricam" in forced
    assert "face" in forced.lower() or "Snorricam" in forced or "torso" in forced
