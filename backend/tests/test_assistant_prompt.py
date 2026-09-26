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
