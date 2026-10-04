"""Masked assistant context must preserve source timing and replacement labels."""

import json
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app import assistant_api
from app.db.models import Generation, MediaAsset, Upload
from app.llm import mask_prompt, prompt
from app.llm.mask_prompt import MaskPromptIn, mask_system, prepare_mask_prompt
from app.llm.service import AssistantBusy


@pytest.fixture
def context(tmp_path, monkeypatch):
    source = tmp_path / "source.mp4"
    source.touch()
    replacement = tmp_path / "replacement.png"
    replacement.touch()
    asset = MediaAsset(id=10, project_id=1, kind="video", name="Source", path=str(source),
                       duration=5, has_audio=True, generation_id=20)
    photo = Upload(id="photo", kind="image", orig_name="replacement.png", path=str(replacement))
    refmod = Upload(id="refmod", kind="video", orig_name="Saved identity", path="", refmod_file="example_visual",
                    refmod_meta={"source_upload_ids": ["photo"], "source_kind": "pictures"})
    generation = Generation(id=20, project_id=1, seed=1,
                            ui_params={"prompt": "Original from <Picture 9> and <Video 3>. <d>Привет!</d>"})
    rows = {(MediaAsset, 10): asset, (Upload, "photo"): photo, (Upload, "refmod"): refmod,
            (Generation, 20): generation}

    @contextmanager
    def store():
        yield SimpleNamespace(get=lambda model, uid: rows.get((model, uid)))

    extracted = []

    async def extract(source_path, target_path, time):
        assert source_path == source
        target_path.touch()
        extracted.append(time)

    monkeypatch.setattr(mask_prompt, "session", store)
    monkeypatch.setattr(mask_prompt.settings, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(mask_prompt.library, "extract_frame", extract)
    return asset, photo, refmod, extracted


def request(**patch):
    return MaskPromptIn(source_asset_id=10, text="Замени человека на человека с <Picture 1>",
                        refs=[{"upload_id": "photo"}], start=1, end=1 + 22 / 24, **patch)


def test_mask_system_keeps_verbatim_spec_exact_short_duration_and_copy_audio():
    system = mask_system([prompt.RefInfo(kind="image", name="hero.png")], 22 / 24, keep_audio=True, invert=False)
    assert prompt.SPEC in system and prompt.OUTPUT_CONTRACT in system
    assert "0.916667 seconds" in system and "inside the mask" in system
    assert "<Picture 1> = hero.png" in system
    assert "original fragment audio is copied" in system and "not generation references" in system
    assert "non_diegetic_music: N/A" in system


def test_mask_without_refs_preserves_source_and_without_sound_preserves_silence():
    system = mask_system([], 1, keep_audio=True, invert=True, has_audio=False)
    assert "outside the mask" in system
    assert "source clip is silent" in system and "Preserve silence" in system
    assert "reference labels are forbidden" in system
    assert "unedited source content remains preserved" in system
    generated = mask_system([], 1, keep_audio=False, invert=False)
    assert "Audio will be generated" in generated and "audio is copied" not in generated


async def test_context_keeps_source_previews_separate_from_replacement_labels(context):
    body = request(prompt="subject_definitions:\nNew hero from <Picture 1>.")
    system, user, images, infos = await prepare_mask_prompt(body)
    assert len(infos) == 1 and len(images) == 3
    assert images[0].name == "replacement.png"
    assert "Attached image 2: source preview" in user and "Attached image 3: source preview" in user
    assert "<Picture 9>" not in user and "<Video 3>" not in user
    assert "<Picture 1>" in user and "<d>Привет!</d>" in user
    assert "Current masked-edit prompt" in user and "full updated prompt" in user
    assert context[-1] == pytest.approx([body.start, body.end - 1 / 24])
    assert "<Video N> ЗАПРЕЩЕНЫ" in system


async def test_refmods_and_ordinary_refs_use_the_generation_order(context):
    body = MaskPromptIn(source_asset_id=10, text="Замени человека", start=1, end=2,
                        refs=[{"upload_id": "refmod"}, {"upload_id": "photo"}])
    system, user, images, infos = await prepare_mask_prompt(body)
    assert [info.kind for info in infos] == ["image", "video"]
    assert "<Picture 1> = replacement.png" in system and "<Video 1> = Saved identity" in system
    assert len(images) == 4 and "Attached image 3: source preview" in user


@pytest.mark.parametrize("patch, status", [({"source_asset_id": 99}, 404), ({"end": 6}, 422),
                                         ({"refs": [{"upload_id": "missing"}]}, 404)])
async def test_invalid_source_or_reference_fails_before_extracting(context, patch, status):
    body = MaskPromptIn.model_validate({**request().model_dump(), **patch})
    with pytest.raises(HTTPException) as exc:
        await prepare_mask_prompt(body)
    assert exc.value.status_code == status
    assert context[-1] == []


async def test_missing_source_file_has_actionable_error(context):
    from pathlib import Path
    Path(context[0].path).unlink()
    with pytest.raises(HTTPException, match="добавьте его заново"):
        await prepare_mask_prompt(request())


async def test_unavailable_frames_do_not_claim_source_was_viewed(context, monkeypatch):
    async def fail(*args):
        raise RuntimeError("Frame unavailable")
    monkeypatch.setattr(mask_prompt.library, "extract_frame", fail)
    _, user, images, _ = await prepare_mask_prompt(request())
    assert len(images) == 1
    assert "Do not claim to have viewed the source clip" in user


@pytest.mark.parametrize("patch", [{"start": 2, "end": 1}, {"text": "  "},
                                  {"refs": [{"upload_id": "photo", "with_audio": True}]}])
def test_request_rejects_invalid_interval_empty_brief_and_unpaired_soundtrack(patch):
    with pytest.raises(ValidationError):
        MaskPromptIn.model_validate({**request().model_dump(), **patch})


async def test_busy_assistant_never_prepares_source_frames(context):
    def busy():
        raise AssistantBusy("Идёт генерация видео")
    app_request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(assistant=SimpleNamespace(precheck=busy))))
    response = await assistant_api.mask_prompt(request(), app_request)
    assert response.status_code == 409 and context[-1] == []


async def test_mask_route_streams_only_finished_prompt_and_repairs_with_source_context(context):
    complete = ("subject_definitions:\nHero from <Picture 1>.\nsummary:\nMasked replacement.\n"
                "retention_analysis:\nKeep motion.\ndetailed_description:\n[Shot 1] Preserve source.\n"
                "overall_soundscape:\nOriginal audio.\nnon_diegetic_music:\nN/A")
    calls = []

    class Assistant:
        def precheck(self):
            pass

        async def stream(self, system, user, images):
            calls.append(user)
            yield {"delta": "Unfinished draft"}
            yield {"done": True, "prompt": complete if len(calls) > 1 else "Incomplete",
                   "cancelled": False}

    app_request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(assistant=Assistant())))
    response = await assistant_api.mask_prompt(request(prompt=complete), app_request)
    events = [json.loads(part.removeprefix("data: ").strip()) async for part in response.body_iterator]
    assert events[-1]["done"] and events[-1]["prompt"] == complete
    assert not any("delta" in event for event in events)
    assert len(calls) == 2
    assert "Source clip: Source" in calls[1] and "Current masked-edit prompt" in calls[1]
