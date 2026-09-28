"""Assistant system prompts: the user's spec is the rulebook, references are listed exactly."""

import asyncio

from app import assistant_api
from app.llm import prompt
from app.llm.prompt import RefInfo, SPEC, compose_system, extract_prompt, face_system
from app.llm.registry import CHOICES, DEFAULT_CHOICE, FILES
from app.workflow.cinematography import (
    assistant_cinematography_block,
    cinematic_technique_presets,
    normalize_cinematic_technique,
    resolve_cinematic_technique_ids,
    user_cinematic_technique_directive,
)


def test_preserving_framing_does_not_trigger_a_shot_size_edit():
    instructions = [
        "Измени только свет; общий план не меняй.",
        "Поставь камеру низко, сохрани общий план.",
        "Поверни камеру по дуге; сохрани общий план.",
    ]
    for instruction in instructions:
        assert prompt._framing_target(instruction) is None
        assert prompt.shot_size_edit_directive(instruction) == ""

    assert prompt._framing_target("Поменяй план на общий") == "wide"
    assert prompt.shot_size_edit_directive("Поменяй план на общий")


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
    assert "КРУПНОСТЬ" in s
    face = prompt.edit_system([], 2.0, face=True)
    assert "УЛУЧШЕНИЯ ЛИЦА" in face and "<Picture 2>" in face and "РЕФЕРЕНСЫ" not in face


def test_shot_size_edit_directive():
    assert "КРУПНОСТЬ" in prompt.shot_size_edit_directive("сделай крупный план")
    assert "ко ВСЕМ кадрам" in prompt.shot_size_edit_directive("close-up please")
    wide = prompt.shot_size_edit_directive("поменяй план на общий")
    assert "ко ВСЕМ кадрам" in wide
    assert "от начала до конца" in wide
    assert "не заканчивает крупным планом" in wide
    assert "отдельного CAMERA / SHOT поля нет" in wide
    assert "КРУПНОСТЬ" in prompt.shot_size_edit_directive("приблизь камеру")
    assert prompt.shot_size_edit_directive("поменяй цвет куртки") == ""
    assert "Не превращай её в" in prompt.EDIT_RULES


def test_wide_framing_validator_rejects_mixed_scale_and_face_moves():
    source = """subject_definitions:\n<Subject 1>\n\nsummary:\nA medium shot follows the subject.\n\nretention_analysis:\n<Subject 1>\n\ndetailed_description:\n[Shot 1] A medium shot frames the subject waist-up.\n\n[Shot 2] A close-up frames the face.\n\noverall_soundscape:\nQuiet.\n\nnon_diegetic_music:\nN/A"""
    mixed = """subject_definitions:\n<Subject 1>\n\nsummary:\nThe clip stays in a wide shot.\n\nretention_analysis:\n<Subject 1>\n\ndetailed_description:\n[Shot 1] A wide shot frames the full body in the environment.\nThe camera moves across the subject's face.\n\n[Shot 2] A close-up frames the face.\n\noverall_soundscape:\nQuiet.\n\nnon_diegetic_music:\nN/A"""
    issues = prompt.shot_size_edit_issues(source, "поменяй план на общий", mixed)
    assert any("Камера" in issue for issue in issues)
    assert any("несовместимая крупность" in issue for issue in issues)


def test_wide_framing_validator_rejects_summary_that_opens_on_a_detail():
    source = """subject_definitions:
<Subject 1>

summary:
A medium close-up opens the clip.

retention_analysis:
<Subject 1>

detailed_description:
[Shot 1] A medium close-up frames the face.

overall_soundscape:
Quiet.

non_diegetic_music:
N/A"""
    unchanged = """subject_definitions:
<Subject 1>

summary:
The subject begins in a profile view focused on his neck tattoo, then shifts to a frontal wide shot at full-body distance.

retention_analysis:
<Subject 1>

detailed_description:
[Shot 1] A wide shot frames the full body of <Subject 1>.
The camera tracks across his face before settling.

overall_soundscape:
Quiet.

non_diegetic_music:
N/A"""
    issues = prompt.shot_size_edit_issues(source, "поменя план на общий", unchanged)
    assert any("не начинает клип" in issue for issue in issues)
    assert any("Камера" in issue for issue in issues)


def test_wide_framing_validator_accepts_one_consistent_wide_size():
    source = """subject_definitions:\n<Subject 1>\n\nsummary:\nThe clip is medium.\n\nretention_analysis:\n<Subject 1>\n\ndetailed_description:\n[Shot 1] A medium shot frames the hero waist-up.\n\n[Shot 2] A medium shot frames the hero waist-up.\n\noverall_soundscape:\nQuiet.\n\nnon_diegetic_music:\nN/A"""
    wide = """subject_definitions:\n<Subject 1>\n\nsummary:\nThe clip stays in a wide shot from the first frame to the last.\n\nretention_analysis:\n<Subject 1>\n\ndetailed_description:\n[Shot 1] A wide shot keeps the full body visible with the environment around it.\nThe camera tracks laterally while keeping the whole figure in frame.\n\n[Shot 2] A wide shot keeps the full body visible with the environment around it.\nThe camera holds at the same distance through the final frame.\n\noverall_soundscape:\nQuiet.\n\nnon_diegetic_music:\nN/A"""
    assert prompt.shot_size_edit_issues(source, "поменяй план на общий", wide) == []


def test_lighting_edit_validator_catches_ignored_change_but_not_preserved_light():
    instruction = (
        "Измени только свет: сделай жёсткий боковой ключ справа от камеры с глубокими тенями. "
        "Положение камеры и общий план не меняй."
    )
    unchanged = "The space is uniformly lit with soft diffused white light. The soft diffused white light illuminates his face evenly."
    issues = prompt.lighting_edit_issues(instruction, unchanged)
    assert issues and "жестк" in issues[0] and "боков" in issues[0] and "справа" in issues[0]

    changed = "Hard side light from camera-right creates deep shadows across the subject."
    assert prompt.lighting_edit_issues(instruction, changed) == []
    assert prompt.lighting_edit_directive(instruction)
    assert prompt.lighting_edit_issues("Поверни камеру по дуге, сохрани мягкий свет.", unchanged) == []


def test_invalid_lighting_edit_gets_one_repair_pass():
    instruction = "Измени свет на жёсткий боковой справа, с глубокими тенями; общий план не меняй."
    bad = "A wide shot under soft diffused light."
    good = "A wide shot under hard side light from camera-right, creating deep shadows."

    class FakeAssistant:
        active = False
        calls = 0

        async def stream(self, system, user, images):
            assert not self.active
            self.active = True
            self.calls += 1
            try:
                yield {"stage": "writing"}
                yield {"delta": "draft" if self.calls == 1 else "repaired"}
                yield {"done": True, "prompt": bad if self.calls == 1 else good, "cancelled": False}
            finally:
                self.active = False

    assistant = FakeAssistant()

    async def collect():
        return [event async for event in assistant_api._checked_prompt_edit(
            assistant, "system", "user", [], "", instruction
        )]

    events = asyncio.run(collect())
    assert assistant.calls == 2 and not assistant.active
    assert any(event.get("stage") == "repairing" for event in events)
    assert events[-1].get("prompt") == good


def test_invalid_wide_edit_finishes_before_repair_stream_starts():
    source = """subject_definitions:
<Subject 1>

summary:
A medium shot follows the subject.

retention_analysis:
<Subject 1>

detailed_description:
[Shot 1] A medium shot frames the subject waist-up.

overall_soundscape:
Quiet.

non_diegetic_music:
N/A"""
    bad = """subject_definitions:
<Subject 1>

summary:
The clip stays in a wide shot.

retention_analysis:
<Subject 1>

detailed_description:
[Shot 1] A wide shot frames the full body in the environment.
The camera tracks across the subject's face.

overall_soundscape:
Quiet.

non_diegetic_music:
N/A"""
    good = """subject_definitions:
<Subject 1>

summary:
A wide shot holds from the first frame to the last.

retention_analysis:
<Subject 1>

detailed_description:
[Shot 1] A wide shot keeps the full body visible with the environment around it.
The camera tracks laterally while maintaining the same distance and full-body framing.

overall_soundscape:
Quiet.

non_diegetic_music:
N/A"""

    class FakeAssistant:
        active = False
        calls = 0

        async def stream(self, system, user, images):
            assert not self.active
            self.active = True
            self.calls += 1
            try:
                yield {"stage": "writing"}
                yield {"delta": "draft" if self.calls == 1 else "repaired"}
                yield {"done": True, "prompt": bad if self.calls == 1 else good, "cancelled": False}
            finally:
                self.active = False

    assistant = FakeAssistant()

    async def collect():
        return [event async for event in assistant_api._checked_prompt_edit(
            assistant, "system", "user", [], source, "поменяй план на общий"
        )]

    events = asyncio.run(collect())
    assert assistant.calls == 2 and not assistant.active
    assert any(event.get("stage") == "repairing" for event in events)
    assert any(event.get("replace") == "" for event in events)
    assert events[-1].get("prompt") == good


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
    assert "=== КИНОТЕХНИКА" in fresh
    assert "RACK FOCUS" in fresh  # catalog knowledge remains available
    assert "Выбор в интерфейсе: Авто" in fresh


def test_cinematography_catalog_is_curated_and_expert_choice_is_explicit():
    presets = cinematic_technique_presets()
    assert presets[0]["id"] == "auto"
    assert len(presets) == 156  # Auto + every technique individually listed in the attached bible
    assert len({item["source_id"] for item in presets[1:]}) == 155
    assert len({item["category"] for item in presets[1:]}) == 13
    assert normalize_cinematic_technique("t8_3") == "t8_3"
    assert normalize_cinematic_technique("unknown") == "auto"

    selected = assistant_cinematography_block("t8_3")
    assert "стартовый кадр" in selected
    assert "focus begins on" in selected
    assert "каждая в своей категории" in selected
    assert "RACK FOCUS" in user_cinematic_technique_directive("t8_3")


def test_cinematography_keeps_independent_categories_and_removes_legacy_conflicts():
    selected = ["t2_3", "t3_4", "t7_10"]
    assert resolve_cinematic_technique_ids(selected) == selected
    assert resolve_cinematic_technique_ids(["t2_3", "t2_4", "t7_10"]) == ["t2_4", "t7_10"]
    assert resolve_cinematic_technique_ids([], "t8_3") == ["t8_3"]
    assert resolve_cinematic_technique_ids(selected, camera="tracking") == ["t3_4", "t7_10"]
    assert resolve_cinematic_technique_ids(selected, light="hard_side") == ["t2_3", "t3_4"]

    system = compose_system([], 5.0, cinematic_techniques=selected)
    assert "2.3 — Движение камеры / DOLLY IN" in system
    assert "3.4 — Крупность и тип плана / WIDE / LONG SHOT" in system
    assert "7.10 — Свет / HARD LIGHT" in system
    assert "=== КАМЕРА ===" not in system
    assert "=== СВЕТ (эксперт) ===" not in system

    directives = assistant_api._expert_directives("auto", "auto", selected)
    assert "Камера (эксперт" not in directives
    assert "Свет (эксперт" not in directives
    assert "DOLLY IN" in directives and "HARD LIGHT" in directives


def test_cinematography_rules_are_available_to_compose_edit_and_chat():
    composed = compose_system([], 5.0, cinematic_technique="t6_8")
    edited = prompt.edit_system([], 5.0, cinematic_technique="t6_8")
    chat = prompt.chat_system([], 5.0, "", fresh=False, cinematic_technique="t6_8")
    fresh_chat = prompt.chat_system([], 5.0, "", fresh=True, cinematic_technique="t6_8")

    for system in (composed, edited, chat):
        assert "=== КИНОТЕХНИКА" in system
        assert "t6_8" in system
        assert "NEGATIVE SPACE" in system
    assert "=== КИНОТЕХНИКА" in fresh_chat
    assert "Выбор в интерфейсе: 6.8" not in fresh_chat
    assert "Выбор в интерфейсе: Авто" in fresh_chat


def test_cinematic_technique_validator_catches_omitted_expert_choice():
    assert prompt.cinematic_technique_edit_issues("t8_3", "A static camera holds on the subject.")
    assert prompt.cinematic_technique_edit_issues("t8_3", "One smooth rack focus moves from the hand to the face.") == []
    assert prompt.cinematic_technique_edit_issues("auto", "Any prompt") == []
    issues = prompt.cinematic_technique_edit_issues(
        ["t2_3", "t3_4", "t7_10"], "A wide shot with a dolly in shows the subject."
    )
    assert len(issues) == 1 and "HARD LIGHT" in issues[0]


def test_invalid_cinematic_technique_edit_gets_one_repair_pass():
    class FakeAssistant:
        active = False
        calls = 0

        async def stream(self, system, user, images):
            assert not self.active
            self.active = True
            self.calls += 1
            try:
                yield {"stage": "writing"}
                yield {"delta": "draft" if self.calls == 1 else "repaired"}
                text = "A static camera holds." if self.calls == 1 else "A smooth rack focus shifts from the hand to the face."
                yield {"done": True, "prompt": text, "cancelled": False}
            finally:
                self.active = False

    assistant = FakeAssistant()

    async def collect():
        return [event async for event in assistant_api._checked_prompt_edit(
            assistant, "system", "user", [], "source", "", "t8_3"
        )]

    events = asyncio.run(collect())
    assert assistant.calls == 2 and not assistant.active
    assert any(event.get("stage") == "repairing" for event in events)
    assert events[-1].get("prompt") == "A smooth rack focus shifts from the hand to the face."


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
