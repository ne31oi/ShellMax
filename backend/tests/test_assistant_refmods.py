"""Photo RefMods keep H3 Video labels but provide photo provenance to the assistant."""

import asyncio
from contextlib import contextmanager

import pytest
from sqlmodel import SQLModel, Session, create_engine

from app import assistant_api, refmods
from app.db.models import Generation, Upload
from app.llm import prompt
from app.llm.references import load_references


@pytest.fixture
def store(tmp_path, monkeypatch):
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(refmods.settings, "THUMBS_DIR", tmp_path)
    with Session(engine, expire_on_commit=False) as s:
        yield s
    engine.dispose()


def add_photo_stack(store, tmp_path, *, metadata=True):
    for name in ("person", "glasses", "cap"):
        path = tmp_path / f"{name}.jpg"
        path.write_bytes(b"photo")
        store.add(Upload(id=name, kind="image", orig_name=name, path=str(path)))
    store.add(Generation(project_id=1, kind="refmod_create", status="done", seed=0,
        ui_params={"upload_ids": ["person", "glasses", "cap"]},
        full_params={"name": "example", "label": "Character", "description": "Character with accessories",
                     "sources": [{"kind": "picture"}] * 3}))
    stack = Upload(id="stack", kind="video", orig_name="Character · RefMod", path="example.safetensors",
        refmod_file="ShellMax/example", refmod_meta={"source_kind": "photo_set",
            "description": "Character with accessories", "source_upload_ids": ["person", "glasses", "cap"]} if metadata else None)
    store.add(stack)
    store.commit()
    return stack


@pytest.mark.parametrize("metadata", [True, False])
def test_photo_stack_sends_all_available_sources_without_inventing_picture_tags(store, tmp_path, metadata):
    add_photo_stack(store, tmp_path, metadata=metadata)
    infos, images = load_references(store, [assistant_api.ComposeRef(upload_id="stack", with_audio=True)])
    assert [p.name for p in images] == ["person.jpg", "glasses.jpg", "cap.jpg"]
    assert not infos[0].with_audio
    block = prompt.compose_system(infos, 3)
    assert "набор статичных фото" in block
    assert "Character with accessories" in block
    for index, name in enumerate(("person", "glasses", "cap"), 1):
        assert f"Вложенная картинка {index}: <Video 1> — {name}" in block
    assert prompt.reference_tag_issues(infos, "<Video 1>") == []
    assert "<Picture 1>" not in prompt._refs_block(infos)
    assert "<Picture K>" not in prompt._refs_block(infos)


def test_missing_photo_sources_use_preview_but_do_not_claim_all_photos_are_visible(store, tmp_path):
    stack = add_photo_stack(store, tmp_path)
    for path in tmp_path.glob("*.jpg"):
        path.unlink()
    (tmp_path / "up_stack.jpg").write_bytes(b"preview")
    infos, images = load_references(store, [assistant_api.ComposeRef(upload_id=stack.id)])
    assert images == [tmp_path / "up_stack.jpg"]
    assert infos[0].attached_images == ["превью RefMod"]
    (tmp_path / "up_stack.jpg").unlink()
    infos, images = load_references(store, [assistant_api.ComposeRef(upload_id=stack.id)])
    assert not images and not infos[0].image_available
    assert "Фото/превью этого набора НЕ приложены" in prompt._refs_block(infos)


def test_technical_edits_keep_metadata_without_claiming_images_were_attached(store, tmp_path):
    add_photo_stack(store, tmp_path)
    infos, images = load_references(store, [assistant_api.ComposeRef(upload_id="stack")], include_images=False)
    assert images == [] and infos[0].attached_images == []
    assert "набор статичных фото" in prompt.edit_system(infos, 3)
    assert "Фото/превью этого набора НЕ приложены" in prompt.edit_system(infos, 3)


def test_mixed_references_and_paired_audio_keep_native_numbering(store, tmp_path):
    add_photo_stack(store, tmp_path)
    store.add(Upload(id="clip", kind="video", orig_name="clip", path="clip.mp4"))
    store.add(Upload(id="voice", kind="audio", orig_name="voice", path="voice.safetensors",
        refmod_file="voice_audio", refmod_meta={"source_kind": "audio", "voice_description": "Low voice"}))
    store.commit()
    refs = [assistant_api.ComposeRef(upload_id="stack"), assistant_api.ComposeRef(upload_id="voice"),
            assistant_api.ComposeRef(upload_id="person"), assistant_api.ComposeRef(upload_id="clip", with_audio=True)]
    infos, _ = load_references(store, refs)
    block = prompt._refs_block(infos)
    assert "<Video 1> = clip" in block and "<Video 2> = Character" in block
    assert "<Audio 2> = voice" in block
    assert "Метаданные <Audio 2>, Описание голоса" in block
    assert "Вложенная картинка 1: <Picture 1> — person" in block
    assert "Вложенная картинка 2: <Video 2> — person" in block
    assert prompt.reference_tag_issues(infos, "<Picture 1> <Video 1> <Video 2> <Audio 1> <Audio 2>") == []


@pytest.mark.parametrize("operation", ["compose", "edit"])
def test_assistant_endpoints_receive_photo_stack_context(store, tmp_path, monkeypatch, operation):
    add_photo_stack(store, tmp_path)
    @contextmanager
    def session():
        yield store
    monkeypatch.setattr(assistant_api, "session", session)
    monkeypatch.setattr(assistant_api, "_svc", lambda request: object())
    monkeypatch.setattr(assistant_api, "_precheck", lambda svc: None)
    captured = {}
    async def checked(svc, system, user, images, *args):
        captured.update(system=system, images=images)
        yield {"done": True, "prompt": "<Video 1>"}
    monkeypatch.setattr(assistant_api, "_checked_prompt_edit", checked)
    refs = [assistant_api.ComposeRef(upload_id="stack")]
    if operation == "compose":
        response = assistant_api.compose(assistant_api.ComposeIn(text="Персонаж в очках и кепке", refs=refs), None)
    else:
        response = assistant_api.edit(assistant_api.EditIn(prompt="subject_definitions:\n<Video 1>",
            instruction="Добавь очки и кепку", refs=refs), None)
    async def consume():
        return [chunk async for chunk in response.body_iterator]
    asyncio.run(consume())
    assert "набор статичных фото" in captured["system"]
    assert len(captured["images"]) == 3


def test_imported_stack_metadata_survives_upload_reload(store, tmp_path, monkeypatch):
    @contextmanager
    def session():
        yield store
    async def catalogue():
        item = {"name": "external", "label": "External", "desc": "Identity and jacket", "appearance": "Green jacket"}
        channel = {"file": "external", "kind": "video", "source": "stack", "tokens": 12}
        channel["context"] = refmods.member_metadata(item, channel, {})
        return {"items": [{**item, "visual": channel}]}
    monkeypatch.setattr(refmods, "session", session)
    monkeypatch.setattr(refmods, "catalogue", catalogue)
    monkeypatch.setattr(refmods, "resolve_member", lambda file: tmp_path / "external.safetensors")
    upload = asyncio.run(refmods.use_member("external"))
    store.expire_all()
    infos, images = load_references(store, [assistant_api.ComposeRef(upload_id=upload.id)])
    assert not images
    assert infos[0].source_kind == "photo_set"
    assert "Green jacket" in prompt._refs_block(infos)
