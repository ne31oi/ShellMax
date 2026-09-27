"""Assistant system prompts: the user's spec is the rulebook, references are listed exactly."""

from app.llm import prompt
from app.llm.prompt import RefInfo, SPEC, compose_system, extract_prompt, face_system
from app.llm.registry import CHOICES, DEFAULT_CHOICE, FILES


def test_spec_is_embedded_verbatim_without_markdown_escapes():
    assert "MiniMax H3 Singularity Video Prompt Writing Specification" in SPEC
    assert "\\" not in SPEC  # "subject\_definitions" etc. were unescaped
    assert SPEC in compose_system([], 2)
    assert SPEC in face_system()


def test_compose_lists_references_in_order_and_forbids_missing_kinds():
    s = compose_system([RefInfo(kind="image", name="hero.png"), RefInfo(kind="image", name="city.jpg"),
                        RefInfo(kind="audio", name="voice.wav")], 5)
    assert "<Picture 1> = hero.png" in s and "<Picture 2> = city.jpg" in s
    assert "<Audio 1> = voice.wav" in s
    assert "<Video N> ЗАПРЕЩЕНЫ" in s
    assert "~5" in s


def test_compose_without_references_forbids_tags():
    s = compose_system([], 2)
    assert "Референсов НЕТ" in s and "newly_generated" in s


def test_compose_audio_lipsync_rules():
    s = compose_system([RefInfo(kind="audio", name="track.mp3")], 5.0)
    assert "<Audio 1> = track.mp3" in s
    assert "fully_copy" in s and "липсинг" in s
    assert "non_diegetic_music = N/A" in s or "non_diegetic_music = N/A" in s.replace(" ", "")
    assert "ЗАПРЕЩЕНО при наличии аудио-рефа" in s
    assert "ЗАПРЕЩЕНО при наличии аудио-рефа" not in compose_system([], 2.0)


def test_extract_prompt_from_fence_and_fallback():
    reply = "Вот промпт:\n```text\nsubject_definitions:\n<Subject 1> ...\nnon_diegetic_music:\nN/A\n```\nГотово."
    assert extract_prompt(reply) == "subject_definitions:\n<Subject 1> ...\nnon_diegetic_music:\nN/A"
    assert extract_prompt("blah subject_definitions:\nX").startswith("subject_definitions:")


def test_default_model_is_studio_bonsai():
    assert DEFAULT_CHOICE == "bonsai"
    c = CHOICES["bonsai"]
    assert FILES[c.model].url.endswith("Ternary-Bonsai-2-27B-PQ2_0.gguf?download=true")
    assert "prism-b10709-9a9394a" in FILES["bonsai_engine_bin"].url
    assert c.sampling.top_k == 20 and c.sampling.presence_penalty == 1.5


def test_edit_system_keeps_spec_and_refs():
    s = prompt.edit_system([prompt.RefInfo(kind="image", name="girl.png")], 5.0)
    assert prompt.SPEC in s and "ТОЛЬКО то, о чём просят" in s
    assert "<Picture 1> = girl.png" in s and "~5.0 с" in s
    face = prompt.edit_system([], 2.0, face=True)
    assert "УЛУЧШЕНИЯ ЛИЦА" in face and "<Picture 2>" in face and "РЕФЕРЕНСЫ" not in face


def test_dialogue_lines_verbatim():
    src = 'She smiles. <d>[Russian] Я Мисс Фортуна.</d> Then <d>Hi!</d>'
    assert prompt.dialogue_lines(src) == ["<d>[Russian] Я Мисс Фортуна.</d>", "<d>Hi!</d>"]
    assert prompt.dialogue_lines("") == []


def test_picture_gives_appearance_not_action():
    s = compose_system([RefInfo(kind="image", name="girl.png")], 2.0)
    assert "КАРТИНКА ЗАДАЁТ ТОЛЬКО ВНЕШНОСТЬ" in s and "НЕ действие видео" in s
    assert "КАРТИНКА ЗАДАЁТ" not in compose_system([], 2.0)


def test_chat_system_fresh_hides_panel_state():
    refs = [RefInfo(kind="image", name="girl.png")]
    fresh = prompt.chat_system(refs, 5.0, "old draft about a donut", fresh=True)
    assert "girl.png" not in fresh and "donut" not in fresh and prompt.SPEC in fresh
    assert "=== КАМЕРА ===" not in fresh  # expert camera is panel state — hidden on fresh chat
    later = prompt.chat_system(refs, 5.0, "old draft about a donut", fresh=False)
    assert "<Picture 1> = girl.png" in later and "donut" in later
    assert "3–5 пронумерованных вариантов" in later and "существуют ТОЛЬКО в чате" in later
    assert "=== КАМЕРА ===" in later


def test_compose_camera_block_priority_and_expert_override():
    auto = compose_system([], 2.0, camera="auto")
    assert "=== КАМЕРА ===" in auto
    assert "экспертный выбор ниже" in auto
    assert "Сейчас эксперт: auto" in auto
    assert "low_angle" in auto and "dolly_zoom" in auto and "snorricam" in auto
    assert "один" in auto.lower() or "one" in auto.lower() or "ОДИН" in auto

    forced = compose_system([], 2.0, camera="dutch_angle")
    assert "Сейчас эксперт: dutch_angle" in forced
    assert "ПРИНУДИТЕЛЬНО" in forced
    assert "12–20°" in forced or "12-20" in forced
    assert "Dutch-angle" in forced or "Dutch angle" in forced.lower() or "dutch" in forced.lower()
    assert "NEGATIVE" in forced or "негатив" in forced.lower() or "no dutch" in forced.lower()


def test_compose_light_block():
    auto = compose_system([], 2.0, light="auto")
    assert "=== СВЕТ (эксперт) ===" in auto
    assert "ПРИНУДИТЕЛЬНО" not in auto.split("=== СВЕТ")[1]

    forced = compose_system([], 2.0, light="overhead_soft")
    assert "overhead_soft" in forced and "ПРИНУДИТЕЛЬНО" in forced.split("=== СВЕТ")[1]


def test_edit_system_includes_camera_unless_face():
    s = prompt.edit_system([], 5.0, camera="tracking", light="hard_side")
    assert "=== КАМЕРА ===" in s and "tracking" in s and "ПРИНУДИТЕЛЬНО" in s
    assert "=== СВЕТ (эксперт) ===" in s and "hard_side" in s
    face = prompt.edit_system([], 2.0, face=True, camera="snorricam", light="hard_side")
    assert "=== КАМЕРА ===" not in face
    assert "=== СВЕТ (эксперт) ===" not in face


def test_alternate_merges_failed_turns():
    from app.llm.service import _alternate

    out = _alternate([{"role": "assistant", "content": "hi"}, {"role": "user", "content": "a"},
                      {"role": "user", "content": "b"}, {"role": "assistant", "content": "c"}])
    assert out == [{"role": "user", "content": "a\n\nb"}, {"role": "assistant", "content": "c"}]
