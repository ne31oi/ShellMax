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


def test_compose_and_edit_include_skill_craft_emphasis():
    """Skill-derived operational rules live in CINEMA_CRAFT and reach compose/edit."""
    compose = compose_system([], 5.0)
    edit = prompt.edit_system([], 5.0)
    for s in (compose, edit, prompt.CINEMA_CRAFT):
        assert "Anti-drift" in s
        assert "preparation → trigger" in s
        assert "VFX = trigger" in s
        assert "Continuity" in s
        assert "РЕАЛИЗМ И КИНОШНОСТЬ" in s
    # Face path keeps its own rules; do not force full craft block onto FaceRefine.
    assert "Anti-drift" not in face_system()


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


def test_wide_framing_validator_accepts_wide_size_later_in_first_summary_sentence():
    source = "summary:\nA medium shot.\nretention_analysis:\nSame.\ndetailed_description:\n[Shot 1] A medium shot.\noverall_soundscape:\nQuiet."
    wide = (
        "summary:\nA young man with digital-themed tattoos stands in a sterile white void within a continuous wide shot.\n"
        "retention_analysis:\nSame.\n"
        "detailed_description:\n[Shot 1] A wide long shot frames his full body within the white space.\n"
        "overall_soundscape:\nQuiet."
    )
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


def test_lighting_and_camera_checks_reject_stale_details_after_combined_edit():
    instruction = (
        "Сделай весь клип средним планом по пояс. Поставь камеру на уровне талии, "
        "на 30 градусов справа от героя и поверни её к нему; камера остаётся неподвижной. "
        "Свет сделай жёстким боковым справа от камеры с глубокими тенями."
    )
    stale = (
        "subject_definitions:\nThe space is uniformly lit with soft diffused white light.\n"
        "summary:\nA medium shot holds under hard side light.\nretention_analysis:\nSame.\n"
        "detailed_description:\n[Shot 1] A medium shot at waist height frames the subject. "
        "The camera executes a rapid horizontal shift across his face, transitioning to a frontal wide composition. "
        "The soft diffused white light illuminates his face.\n"
        "overall_soundscape:\nQuiet."
    )
    assert prompt.shot_size_edit_issues(stale, "поменяй план на средний", stale)
    assert any("мягкий свет" in issue or "visual_style" in issue
               for issue in prompt.lighting_edit_issues(instruction, stale))
    assert any("неподвижной" in issue or "угол" in issue or "справа" in issue
               for issue in prompt.camera_edit_issues(instruction, stale))
    fixed = (
        "subject_definitions:\nA hard side key from camera-right creates deep shadows.\n"
        "summary:\nA medium shot holds throughout under hard side light.\nretention_analysis:\nSame.\n"
        "detailed_description:\n[Shot 1] A medium shot frames the subject at waist height, "
        "with the fixed camera 30 degrees to the subject's right, aimed toward him. "
        "A hard side key from camera-right creates deep shadows while the subject turns his head.\n"
        "visual_style:\nHard side light from camera-right creates deep shadows.\n"
        "overall_soundscape:\nQuiet."
    )
    assert prompt.shot_size_edit_issues(stale, "поменяй план на средний", fixed) == []
    assert prompt.lighting_edit_issues(instruction, fixed) == []
    assert prompt.camera_edit_issues(instruction, fixed) == []
    approaching = fixed.replace("the subject turns his head", "his eyes track the approaching camera lens")
    assert any("приближающейся" in issue for issue in prompt.camera_edit_issues(instruction, approaching))
    not_aimed = fixed.replace("aimed toward him", "looking across the empty void")
    assert any("поверни камеру" in issue for issue in prompt.camera_edit_issues(instruction, not_aimed))


def test_prompt_completion_rejects_cut_off_tags_and_wrong_visual_style_order():
    candidate = (
        "subject_definitions:\nPerson.\nsummary:\nMedium shot.\nretention_analysis:\nSame.\n"
        "detailed_description:\n[Shot 1] Medium shot.\nvisual_style:\nHard side light.\n"
        "overall_soundscape:\nQuiet.\nnon_diegetic_music:\nFrom <Audio"
    )
    assert any("Дополни" in issue for issue in prompt.prompt_completion_issues(candidate))
    assert any("Дополни" in issue for issue in prompt.prompt_completion_issues(candidate, "length"))
    reordered = candidate.replace("visual_style:\nHard side light.\n", "")
    reordered = reordered.replace("detailed_description:", "visual_style:\nHard side light.\ndetailed_description:")
    assert any("Размести visual_style" in issue for issue in prompt.prompt_completion_issues(reordered))


def test_invalid_lighting_edit_gets_one_repair_pass():
    instruction = "Измени свет на жёсткий боковой справа, с глубокими тенями; общий план не меняй."
    bad = "A wide shot under soft diffused light."
    good = (
        "subject_definitions:\nA person under hard side light.\n"
        "summary:\nA wide shot under hard side light from camera-right.\n"
        "retention_analysis:\nSame.\n"
        "detailed_description:\n[Shot 1] Hard side light from camera-right creates deep shadows.\n"
        "visual_style:\nHard side light from camera-right creates deep shadows.\n"
        "overall_soundscape:\nQuiet.\nnon_diegetic_music:\nN/A."
    )

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
        requests = []

        async def stream(self, system, user, images):
            assert not self.active
            self.active = True
            self.calls += 1
            self.requests.append(user)
            try:
                yield {"stage": "writing"}
                yield {"delta": "draft" if self.calls == 1 else "repaired"}
                yield {"done": True, "prompt": bad if self.calls == 1 else good, "cancelled": False}
            finally:
                self.active = False

    assistant = FakeAssistant()

    async def collect():
        return [event async for event in assistant_api._checked_prompt_edit(
            assistant, "system", "original user request with full source", [], source, "поменяй план на общий"
        )]

    events = asyncio.run(collect())
    # Technique framing no longer triggers repair — one draft is enough when structure is complete.
    assert assistant.calls == 1 and not assistant.active
    assert events[-1].get("prompt") == bad
    assert not any("error" in event for event in events)


def test_dialogue_lines_verbatim():
    src = 'She smiles. <d>[Russian] Я Мисс Фортуна.</d> Then <d>Hi!</d>'
    assert prompt.dialogue_lines(src) == ["<d>[Russian] Я Мисс Фортуна.</d>", "<d>Hi!</d>"]
    assert prompt.dialogue_lines("") == []


def test_picture_gives_appearance_not_action():
    s = compose_system([RefInfo(kind="image", name="girl.png")], 2.0)
    assert "КАРТИНКА ЗАДАЁТ ТОЛЬКО ВНЕШНОСТЬ" in s
    assert "НЕ действие и НЕ кадрирование видео" in s or "НЕ действие видео" in s
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

    # Selects live in the user message as plain text, not in the system MD dump.
    system = compose_system([], 5.0, cinematic_techniques=selected)
    assert prompt.SPEC in system
    assert "=== КАМЕРА ===" not in system
    assert "DOLLY IN" not in system

    user = prompt.compose_user_message("стоит в серой комнате", cinematic_techniques=selected)
    assert "DOLLY IN" in user and "WIDE" in user and "HARD LIGHT" in user
    assert "PREVIS LOCK" in user
    assert "SHOT SIZE LOCK" in user or "CAMERA MOTION LOCK" in user
    assert "стоит в серой комнате" in user

    directives = assistant_api._expert_directives("auto", "auto", selected)
    assert "DOLLY IN" in directives and "HARD LIGHT" in directives


def test_cinematography_rules_are_available_to_compose_edit_and_chat():
    composed = compose_system([], 5.0, cinematic_technique="t6_8")
    edited = prompt.edit_system([], 5.0, cinematic_technique="t6_8")
    chat = prompt.chat_system([], 5.0, "", fresh=False, cinematic_technique="t6_8")
    fresh_chat = prompt.chat_system([], 5.0, "", fresh=True, cinematic_technique="t6_8")

    # Compose/edit system = MD spec only; techniques are plain text on the user side.
    assert prompt.SPEC in composed and prompt.SPEC in edited
    assert "t6_8" not in composed and "t6_8" not in edited
    user = prompt.compose_user_message("сцена", cinematic_technique="t6_8")
    assert "RULE OF THIRDS" in user or "6.8" in user or "t6_8" in user or "thirds" in user.lower()

    assert "=== КИНОТЕХНИКА" in chat  # chat still exposes catalog knowledge
    assert "t6_8" in chat or "RULE OF THIRDS" in chat
    assert "Выбор в интерфейсе: Авто" in fresh_chat
    assert "ПРИНУДИТЕЛЬНО" not in fresh_chat.split("Выбор в интерфейсе")[-1][:200]


def test_cinematic_technique_validator_catches_omitted_expert_choice():
    assert prompt.cinematic_technique_edit_issues("t8_3", "A static camera holds on the subject.")
    assert prompt.cinematic_technique_edit_issues("t8_3", "One smooth rack focus moves from the hand to the face.") == []
    assert prompt.cinematic_technique_edit_issues("auto", "Any prompt") == []
    issues = prompt.cinematic_technique_edit_issues(
        ["t2_3", "t3_4", "t7_10"], "A wide shot with a dolly in shows the subject."
    )
    assert issues and any("HARD LIGHT" in issue for issue in issues)


def test_selected_wide_framing_applies_globally_and_ignores_negative_constraints():
    assert prompt.selected_shot_size_instruction("сохрани действие", ["t3_4"]) == "поменяй план на общий"
    assert prompt.selected_shot_size_instruction("первый кадр крупный", ["t3_4"]) == "первый кадр крупный"
    source = "summary:\nClose-up.\nretention_analysis:\nSame.\ndetailed_description:\n[Shot 1] Close-up.\noverall_soundscape:\nQuiet."
    candidate = (
        "summary:\nA wide shot holds throughout, without transitioning into a close-up.\n"
        "retention_analysis:\nSame.\ndetailed_description:\n"
        "[Shot 1] A static wide/long shot frames the full body. The camera remains still. "
        "NEGATIVE: no close-up, no medium shot, no zoom into the face.\n"
        "overall_soundscape:\nQuiet."
    )
    assert prompt.shot_size_edit_issues(source, "поменяй план на общий", candidate) == []


def test_other_selected_shot_sizes_apply_to_every_shot():
    source = (
        "summary:\nA wide shot.\nretention_analysis:\nSame.\n"
        "detailed_description:\n[Shot 1] A wide shot.\n[Shot 2] A wide shot.\n"
        "overall_soundscape:\nQuiet."
    )
    examples = (
        ("t3_6", "cowboy shot"),
        ("t3_7", "medium shot"),
        ("t3_8", "medium close-up"),
        ("t3_9", "close-up"),
        ("t3_10", "extreme close-up"),
    )
    for selected, shot_size in examples:
        instruction = prompt.selected_shot_size_instruction("сохрани действие", [selected])
        assert "ВСЕМ кадрам" in prompt.shot_size_edit_directive(instruction)
        candidate = (
            f"summary:\nA {shot_size} holds throughout.\nretention_analysis:\nSame.\n"
            f"detailed_description:\n[Shot 1] A {shot_size} frames the subject.\n"
            f"[Shot 2] A {shot_size} frames the subject. NEGATIVE: no wide shot.\n"
            "overall_soundscape:\nQuiet."
        )
        assert prompt.shot_size_edit_issues(source, instruction, candidate) == []
        mixed = candidate.replace(f"[Shot 2] A {shot_size}", "[Shot 2] A wide shot")
        assert any("Кадр 2" in issue or "кадре 2" in issue
                   for issue in prompt.shot_size_edit_issues(source, instruction, mixed))


def test_selected_camera_and_light_reject_contradictory_or_missing_placement():
    candidate = (
        "summary:\nA wide shot with a static camera.\n"
        "detailed_description:\n[Shot 1] The camera shifts to the left.\n"
        "overall_soundscape:\nQuiet."
    )
    issues = prompt.cinematic_technique_edit_issues(["t2_2", "t7_11"], candidate)
    assert any("Статичная камера" in issue for issue in issues)
    assert any("visual_style" in issue for issue in issues)
    executed = candidate.replace("The camera shifts to the left.", "The camera executes a rapid horizontal shift.")
    assert any("Статичная камера" in issue
               for issue in prompt.cinematic_technique_edit_issues("t2_2", executed))


def test_technical_edit_keeps_reference_tags_without_resending_images():
    assert not prompt.use_reference_images_for_edit("Поменяй план на общий, сохрани лицо", ["t3_4"])
    assert prompt.use_reference_images_for_edit("Поменяй план на общий и исправь лицо по фото", ["t3_4"])
    assert prompt.use_reference_images_for_edit("Исправь сходство с референсом", [])


def test_technical_edit_keeps_the_subjects_sharp_head_turn():
    source = (
        "detailed_description:\n[Shot 1] A close-up frames the face.\n\n"
        "<Subject 1> makes a sharp, staccato head movement toward the camera, "
        "turning his face in two distinct jerks.\n\noverall_soundscape:\nQuiet."
    )
    instruction = "Поменяй план на общий, сохрани движение головы"
    assert "staccato head movement" in prompt.subject_action_edit_directive(source, instruction, ["t3_4"])
    weak = "[Shot 1] A wide shot frames the full body. His head shifts slightly with breathing."
    issues = prompt.subject_action_edit_issues(source, instruction, ["t3_4"], weak)
    assert len(issues) == 2
    strong = "[Shot 1] A wide shot frames the full body. His head turns sharply in two distinct jerks."
    assert prompt.subject_action_edit_issues(source, instruction, ["t3_4"], strong) == []
    one_paragraph = source.replace("\n\n", " ")
    assert "staccato head movement" in prompt.subject_action_edit_directive(one_paragraph, instruction, ["t3_4"])
    assert len(prompt.subject_action_edit_issues(one_paragraph, instruction, ["t3_4"], weak)) == 2


def test_invalid_cinematic_technique_edit_gets_one_repair_pass():
    good = (
        "subject_definitions:\nA person.\nsummary:\nA rack focus.\nretention_analysis:\nSame.\n"
        "detailed_description:\n[Shot 1] A smooth rack focus shifts from the hand to the face.\n"
        "overall_soundscape:\nQuiet.\nnon_diegetic_music:\nN/A."
    )

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
                text = "A static camera holds." if self.calls == 1 else good
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
    assert not any("delta" in event for event in events)
    assert events[-1].get("prompt") == good
    assert not any("error" in event for event in events)


def test_checked_prompt_edit_always_returns_prompt_after_failed_repairs():
    """Never toast 'original saved' — keep repairing then mechanically enforce techniques."""

    class FakeAssistant:
        active = False
        calls = 0

        async def stream(self, system, user, images):
            assert not self.active
            self.active = True
            self.calls += 1
            try:
                yield {"stage": "writing"}
                # Always omit worm's-eye so repairs never clear the issue by themselves.
                text = (
                    "subject_definitions:\nA person from <Picture 1>.\n"
                    "summary:\nEye level portrait.\nretention_analysis:\nSame.\n"
                    "detailed_description:\n[Shot 1] Eye level close-up.\n"
                    "overall_soundscape:\nQuiet.\nnon_diegetic_music:\nN/A."
                )
                yield {"done": True, "prompt": text, "cancelled": False}
            finally:
                self.active = False

    assistant = FakeAssistant()
    refs = [RefInfo(kind="image", name="a.jpg")]

    async def collect():
        return [event async for event in assistant_api._checked_prompt_edit(
            assistant, "system", "user", [], "", "worm's eye", ["t4_5"], refs
        )]

    events = asyncio.run(collect())
    # Technique markers are not repaired anymore — only refs/completion.
    assert assistant.calls == 1
    assert not any("error" in event for event in events)
    final = events[-1]
    assert final.get("done") and "<Picture 1>" in final["prompt"]


def test_enforce_prompt_requirements_injects_missing_techniques_and_refs():
    raw = (
        "subject_definitions:\nA person shown in  and .\n"
        "summary:\nEye level dolly.\nretention_analysis:\nSame.\n"
        "detailed_description:\n[Shot 1] Eye level medium shot. NEGATIVE: no shake.\n"
        "overall_soundscape:\nQuiet.\nnon_diegetic_music:\nN/A."
    )
    refs = [RefInfo(kind="image", name="a.jpg"), RefInfo(kind="image", name="b.jpg")]
    fixed = prompt.enforce_prompt_requirements(raw, ["t4_5", "t3_8"], refs)
    assert "<Picture 1>" in fixed and "<Picture 2>" in fixed
    assert "worm" in fixed.lower()
    assert "medium close-up" in fixed.lower() or "MEDIUM CLOSE-UP" in fixed
    assert prompt.cinematic_technique_edit_issues(["t4_5", "t3_8"], fixed) == []
    assert prompt.reference_tag_issues(refs, fixed) == []


def test_enforce_extreme_long_shot_rewrites_eye_closeup():
    """Selected ELS must own the frame — not sit as a tagline on top of an eye close-up."""
    bad = (
        "subject_definitions:\n<Subject 1>: person from <Picture 1>. "
        "The face, hair, and outfit remain consistent throughout the shot.\n"
        "summary:\nA close-up on the eyes.\n"
        "retention_analysis:\nSame.\n"
        "detailed_description:\n"
        "[Shot 1] Extreme close-up of the eyes with wet highlights. "
        "Apply EXTREME LONG SHOT / EXTREME WIDE (extreme long shot) as a mandatory parameter of this shot.\n"
        "overall_soundscape:\nQuiet.\nnon_diegetic_music:\nN/A."
    )
    assert prompt.selected_shot_size_instruction("x", ["t3_1"]) == "поменяй план на сверхдальний"
    assert prompt._framing_target(prompt.selected_shot_size_instruction("x", ["t3_1"])) == "extreme_wide"
    assert prompt.shot_size_edit_issues("", prompt.selected_shot_size_instruction("x", ["t3_1"]), bad)

    fixed = prompt.enforce_prompt_requirements(bad, ["t3_1"], [RefInfo(kind="image", name="a.jpg")])
    low = fixed.lower()
    assert "extreme long shot" in low or "extreme wide" in low
    assert "close-up on the eyes" not in low
    assert "extreme close-up of the eyes" not in low
    assert "as a mandatory parameter" not in low
    assert "framing lock" in low
    assert "wet highlights" not in low
    user = prompt.compose_user_message("стоит в серой комнате", cinematic_techniques=["t3_1"])
    assert "EXTREME LONG" in user or "EXTREME WIDE" in user
    assert prompt.SPEC in compose_system([], 5.0)
    instr = prompt.selected_shot_size_instruction("x", ["t3_1"])
    assert prompt.shot_size_edit_issues("", instr, fixed) == []
    assert prompt.cinematic_technique_edit_issues("t3_1", fixed) == []


def test_compose_camera_block_priority_and_expert_override():
    auto = compose_system([], 2.0, camera="auto")
    assert "=== КАМЕРА ===" not in auto
    assert prompt.SPEC in auto
    user = prompt.compose_user_message("сцена", camera="dutch_angle")
    assert "Голландский" in user or "12" in user


def test_compose_light_block():
    auto = compose_system([], 2.0, light="auto")
    assert "=== СВЕТ (эксперт) ===" not in auto
    user = prompt.compose_user_message("сцена", light="overhead_soft")
    assert "overhead" in user.lower() or "Overhead" in user or "мягк" in user.lower()


def test_edit_system_includes_camera_unless_face():
    s = prompt.edit_system([], 5.0, camera="tracking", light="hard_side")
    assert prompt.SPEC in s
    assert "=== КАМЕРА ===" not in s
    user = prompt.edit_user_message("subject_definitions:\nA.\nsummary:\nB.\n", "",
                                    camera="tracking", light="hard_side")
    assert "tracking" in user.lower() or "Tracking" in user
    face = prompt.edit_system([], 2.0, face=True, camera="snorricam", light="hard_side")
    assert "УЛУЧШЕНИЯ ЛИЦА" in face or "FaceRefine" in face


def test_alternate_merges_failed_turns():
    from app.llm.service import _alternate

    out = _alternate([{"role": "assistant", "content": "hi"}, {"role": "user", "content": "a"},
                      {"role": "user", "content": "b"}, {"role": "assistant", "content": "c"}])
    assert out == [{"role": "user", "content": "a\n\nb"}, {"role": "assistant", "content": "c"}]


def test_compose_shot_size_check_does_not_require_source_shot_count():
    """Compose has empty source; comparing to zero shots used to always fail MCU/etc."""
    instruction = prompt.selected_shot_size_instruction("стоит в серой комнате", ["t3_8"])
    candidate = (
        "summary:\nA medium close-up holds on the subject throughout.\n"
        "retention_analysis:\nSame.\n"
        "detailed_description:\n[Shot 1] A medium close-up chest-up frames the face and shoulders.\n"
        "overall_soundscape:\nQuiet."
    )
    assert prompt.shot_size_edit_issues("", instruction, candidate) == []
    bad = candidate.replace("medium close-up", "medium shot", 1).replace(
        "A medium close-up chest-up", "A medium shot"
    )
    assert prompt.shot_size_edit_issues("", instruction, bad)


def test_gray_room_els_compose_keeps_action_and_framing():
    """Plain user text + ELS must not collapse into an eye CU after enforce."""
    framing = prompt.selected_shot_size_instruction("стоит в серой комнате", ["t3_1"])
    assert framing == "поменяй план на сверхдальний"
    draft = (
        "subject_definitions:\n<Subject 1>: person from <Picture 1>.\n"
        "summary:\nA dolly-in to a close-up on the eyes in a white void.\n"
        "retention_analysis:\nSame.\n"
        "detailed_description:\n"
        "[Shot 1] Extreme close-up of the eyes. The subject stands in a gray room.\n"
        "overall_soundscape:\nQuiet.\nnon_diegetic_music:\nN/A."
    )
    refs = [RefInfo(kind="image", name="face.jpg")]
    fixed = prompt.enforce_prompt_requirements(draft, ["t3_1"], refs)
    low = fixed.lower()
    assert "extreme long shot" in low or "extreme wide" in low
    assert "gray room" in low or "grey room" in low
    assert "close-up on the eyes" not in low
    assert "extreme close-up of the eyes" not in low
    assert prompt.shot_size_edit_issues("", framing, fixed) == []
    assert prompt.cinematic_technique_edit_issues(["t3_1"], fixed) == []
    assert prompt.reference_tag_issues(refs, fixed) == []


def test_shot_size_family_antonyms_block_sibling_variants():
    """Wide must not pass when only extreme-wide is written, and vice versa."""
    els = (
        "summary:\nAn extreme long shot / extreme wide holds: tiny figure in a vast space.\n"
        "detailed_description:\n[Shot 1] An extreme long shot keeps the subject tiny. NEGATIVE: no close-up.\n"
        "overall_soundscape:\nQuiet."
    )
    wide = (
        "summary:\nA wide shot / long shot holds the full body in the room.\n"
        "detailed_description:\n[Shot 1] A wide shot frames the full body. NEGATIVE: no close-up.\n"
        "overall_soundscape:\nQuiet."
    )
    assert prompt.cinematic_technique_edit_issues(["t3_1"], els) == []
    assert prompt.cinematic_technique_edit_issues(["t3_4"], wide) == []
    # Sibling false-pass: ELS text must not satisfy WIDE selection (and reverse).
    assert prompt.cinematic_technique_edit_issues(["t3_4"], els)
    assert prompt.cinematic_technique_edit_issues(["t3_1"], wide)
    # Close-up must not accept extreme close-up only.
    ecu = (
        "summary:\nAn extreme close-up isolates the iris.\n"
        "detailed_description:\n[Shot 1] An extreme close-up of the iris. NEGATIVE: no wide shot.\n"
        "overall_soundscape:\nQuiet."
    )
    assert prompt.cinematic_technique_edit_issues(["t3_9"], ecu)
    cu = (
        "summary:\nA close-up holds on the face.\n"
        "detailed_description:\n[Shot 1] A close-up frames the face tightly. NEGATIVE: no extreme close-up.\n"
        "overall_soundscape:\nQuiet."
    )
    assert prompt.cinematic_technique_edit_issues(["t3_9"], cu) == []


def test_pan_does_not_false_pass_on_whip_pan():
    whip = (
        "summary:\nA whip pan connects two rooms.\n"
        "detailed_description:\n[Shot 1] The camera executes a whip pan. NEGATIVE: no dolly.\n"
        "overall_soundscape:\nQuiet."
    )
    assert prompt.cinematic_technique_edit_issues(["t2_8"], whip)
    fixed = prompt.enforce_cinematic_techniques(["t2_8"], whip)
    assert prompt.cinematic_technique_edit_issues(["t2_8"], fixed) == []
    assert "whip pan" not in fixed.lower()


def test_marker_present_masks_longer_siblings():
    assert prompt._marker_present("close-up", "extreme close-up of the eye") is False
    assert prompt._marker_present("close-up", "a close-up of the face") is True
    assert prompt._marker_present("pan", "a whip pan left") is False
    assert prompt._marker_present("pan", "camera pans left") is True
    assert prompt._marker_present("wide", "extreme wide landscape") is False


def test_use_reference_images_off_for_technique_only_compose_text():
    assert prompt.use_reference_images_for_edit("стоит в серой комнате", ["t3_1"]) is False
    assert prompt.use_reference_images_for_edit("поправь лицо по референсу", ["t3_1"]) is True
    assert prompt.use_reference_images_for_edit("стоит в серой комнате", []) is True


def test_cinematic_technique_markers_cover_user_bible_picks():
    techs = ["t3_8", "t4_5", "t5_9", "t6_14", "t7_22", "t8_1", "t14_2"]
    void = (
        "summary:\nA slow dolly-in from medium shot to close-up at eye level.\n"
        "detailed_description:\n[Shot 1] Eye level, shallow depth of field, white void.\n"
        "overall_soundscape:\nQuiet."
    )
    issues = prompt.cinematic_technique_edit_issues(techs, void)
    assert len(issues) >= 6
    assert any("WORM" in issue for issue in issues)
    assert any("GOLDEN HOUR" in issue for issue in issues)
    assert any("NEO-NOIR" in issue for issue in issues)

    good = (
        "summary:\nA medium close-up worm's-eye anamorphic neo-noir portrait with look space.\n"
        "detailed_description:\n"
        "[Shot 1] A medium close-up chest-up from worm's-eye / ground level uses anamorphic oval bokeh, "
        "look space ahead of the gaze, golden hour warmth, and shallow focus / shallow depth of field "
        "in a neo-noir grade.\n"
        "visual_style:\nGolden hour low warm sun from camera-left, soft fill, selective saturation.\n"
        "overall_soundscape:\nQuiet."
    )
    assert prompt.cinematic_technique_edit_issues(techs, good) == []
    eye_level = good.replace("worm's-eye / ground level", "eye level").replace("worm's-eye", "eye-level")
    assert any("Worm" in issue or "WORM" in issue or "eye-level" in issue
               for issue in prompt.cinematic_technique_edit_issues(["t4_5"], eye_level))


def test_every_catalog_technique_has_working_validation_markers():
    """Every selectable bible technique must fail on unrelated prose and pass on a marker probe."""
    from app.workflow.cinematography import cinematic_technique_presets, technique_validation_markers

    unrelated = "A chair stands in a quiet hallway with no camera notes."
    for item in cinematic_technique_presets():
        if item["id"] == "auto":
            continue
        markers = technique_validation_markers(item)
        assert markers, f"no markers for {item['source_id']} {item['label']}"
        assert prompt.cinematic_technique_edit_issues(item["id"], unrelated), (
            f"{item['source_id']} {item['label']} falsely accepts unrelated prose"
        )
        probe = (
            f"summary:\nShot uses {markers[0]}.\n"
            f"detailed_description:\n[Shot 1] The framing applies {markers[0]} clearly.\n"
        )
        # Light techniques also require a visual_style section.
        if item["category"] == "Свет":
            probe += f"visual_style:\n{markers[0]} with a clear key direction and fill.\n"
        probe += "overall_soundscape:\nQuiet."
        remaining = prompt.cinematic_technique_edit_issues(item["id"], probe)
        assert remaining == [], f"{item['source_id']} {item['label']}: {remaining} (probe={markers[0]!r})"


def test_reference_tag_issues_require_every_attached_media_label():
    refs = [
        RefInfo(kind="image", name="a.jpg"),
        RefInfo(kind="image", name="b.jpg"),
        RefInfo(kind="audio", name="t.wav"),
    ]
    missing = "subject_definitions:\nA person shown in  and .\nsummary:\nX."
    issues = prompt.reference_tag_issues(refs, missing)
    assert any("<Picture 1>" in issue for issue in issues)
    assert any("<Picture 2>" in issue for issue in issues)
    assert any("<Audio 1>" in issue for issue in issues)

    ok = (
        "subject_definitions:\n"
        "<Subject 1>: same person shown in <Picture 1> and <Picture 2>.\n"
        "summary:\nA look with <Audio 1>.\n"
    )
    assert prompt.reference_tag_issues(refs, ok) == []
    assert prompt.reference_tag_issues([], missing) == []
    assert prompt.reference_tag_issues(None, missing) == []
