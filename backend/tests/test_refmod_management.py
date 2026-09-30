"""RefMod revisions preserve originals; deleting a card respects jobs and roots."""

import asyncio
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlmodel import Session, SQLModel, create_engine

from app import fantastic_jobs, refmods
from app.db.models import Generation, Upload
from app.workflow.fantastic import RefModCreateUI


@pytest.fixture
def library(tmp_path, monkeypatch):
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    owned, legacy = tmp_path / "owned", tmp_path / "legacy"
    owned.mkdir(); legacy.mkdir()
    monkeypatch.setattr(refmods, "roots", lambda: [owned, legacy])
    monkeypatch.setattr(refmods.settings, "THUMBS_DIR", tmp_path)
    with Session(engine, expire_on_commit=False) as store:
        @contextmanager
        def session():
            yield store
        monkeypatch.setattr(refmods, "session", session)
        monkeypatch.setattr(fantastic_jobs, "session", session)
        yield store, owned, legacy
    engine.dispose()


def fake_catalogue(monkeypatch, item):
    async def catalogue():
        return {"items": [item], "limits": refmods.limits()}
    monkeypatch.setattr(refmods, "catalogue", catalogue)


def test_limits_distinguish_creation_recipe_from_generation_budget():
    limits = refmods.limits()
    assert limits["create_visual_tokens"] == 5120
    assert limits["total_tokens"] == dict.fromkeys(("generate", "generate_nvfp4", "generate_nvfp4_fast"))


def test_revision_rebuilds_reordered_cropped_sources_to_fresh_output(library, monkeypatch):
    store, owned, _ = library
    (owned / "original.safetensors").write_bytes(b"original")
    for name in ("face", "crop"):
        path = owned / (name + ".jpg")
        path.write_bytes(b"photo")
        store.add(Upload(id=name, kind="image", orig_name=name, path=str(path), source_id="face" if name == "crop" else None))
    store.commit()
    monkeypatch.setattr(fantastic_jobs, "_profile", lambda _: (SimpleNamespace(name="Test"), SimpleNamespace(vae_video="video", vae_audio="audio")))
    ui = RefModCreateUI(source_refmod_file="original", upload_ids=["crop", "face"], name="New", mode="Full Reference")
    revision = fantastic_jobs.expand_refmod_create(ui, 1)
    assert revision.kind == "refmod_create"
    assert revision.full_params["name"] != "original"
    assert [source["path"] for source in revision.full_params["sources"]] == [str(owned / "crop.jpg"), str(owned / "face.jpg")]
    revision.status = "done"
    store.add(revision); store.commit()
    context = refmods.creation_context(store)["ShellMax/" + revision.full_params["name"]]
    assert context["source_upload_ids"] == ["crop", "face"]
    assert context["mode"] == "Full Reference"
    assert (owned / "original.safetensors").read_bytes() == b"original"


def test_revision_reports_missing_source_files(library, monkeypatch):
    store, owned, _ = library
    store.add(Upload(id="missing", kind="image", orig_name="missing", path=str(owned / "missing.jpg")))
    store.commit()
    monkeypatch.setattr(fantastic_jobs, "_profile", lambda _: (None, None))
    with pytest.raises(HTTPException) as raised:
        fantastic_jobs.expand_refmod_create(RefModCreateUI(upload_ids=["missing"], name="New"), 1)
    assert raised.value.status_code == 422


def test_edit_defaults_recover_originals_and_report_missing(library, monkeypatch):
    store, owned, _ = library
    (owned / "photo.jpg").write_bytes(b"photo")
    store.add(Upload(id="photo", kind="image", orig_name="photo", path=str(owned / "photo.jpg")))
    store.add(Generation(project_id=1, kind="refmod_create", seed=0, status="done",
        ui_params={"upload_ids": ["photo", "missing"], "include_audio": False},
        full_params={"name": "ref", "label": "Ref", "mode": "Full Reference", "sources": [{"kind": "picture"}] * 2}))
    store.commit()
    fake_catalogue(monkeypatch, {"name": "ShellMax/ref", "label": "Ref", "visual": {"file": "ShellMax/ref"}})
    defaults = asyncio.run(refmods.revision_defaults("ShellMax/ref"))
    assert [up.id for up in defaults["uploads"]] == ["photo"]
    assert defaults["has_sources"] and defaults["missing_sources"] == 1
    assert defaults["mode"] == "Full Reference"


def test_multiple_sources_with_actual_video_are_not_called_photo_set(library):
    store, _, _ = library
    store.add(Generation(project_id=1, kind="refmod_create", seed=0, status="done",
        ui_params={"upload_ids": ["photo", "clip"]}, full_params={"name": "mixed", "sources": [{"kind": "picture"}, {"kind": "video"}]}))
    store.commit()
    assert refmods.creation_context(store)["ShellMax/mixed"]["source_kind"] == "video"


def add_pair(store, owned, monkeypatch):
    for channel in ("visual", "audio"):
        path = owned / f"pair_{channel}.safetensors"
        path.write_bytes(b"refmod")
        store.add(Upload(id=channel, kind="audio" if channel == "audio" else "video", orig_name="Pair", path=str(path), refmod_file=f"pair_{channel}"))
    (owned / "pair.png").write_bytes(b"preview")
    (owned / "source.jpg").write_bytes(b"source")
    store.commit()
    fake_catalogue(monkeypatch, {"visual": {"file": "pair_visual"}, "audio": {"file": "pair_audio"}, "preview": "pair"})


def test_delete_removes_both_channels_preview_uploads_but_keeps_source(library, monkeypatch):
    store, owned, _ = library
    add_pair(store, owned, monkeypatch)
    removed = asyncio.run(refmods.delete_member("pair_visual"))
    assert set(removed["files"]) == {"pair_visual", "pair_audio"}
    assert not (owned / "pair_visual.safetensors").exists()
    assert not (owned / "pair_audio.safetensors").exists()
    assert not (owned / "pair.png").exists()
    assert (owned / "source.jpg").read_bytes() == b"source"
    assert store.get(Upload, "visual") is None and store.get(Upload, "audio") is None


@pytest.mark.parametrize("params", [{"refs": [{"refmod_file": "pair_visual"}]}, {"source_refmod_file": "pair_visual"}, {"refs": [{"upload_id": "visual"}]}])
def test_delete_refuses_members_used_by_queued_job(library, monkeypatch, params):
    store, owned, _ = library
    add_pair(store, owned, monkeypatch)
    store.add(Generation(project_id=1, kind="generate_refmods", seed=0, status="queued", ui_params=params, full_params={}))
    store.commit()
    with pytest.raises(HTTPException) as raised:
        asyncio.run(refmods.delete_member("pair_visual"))
    assert raised.value.status_code == 409
    assert (owned / "pair_visual.safetensors").exists()


def test_delete_never_modifies_main_comfy_installation(library, monkeypatch):
    _, _, legacy = library
    path = legacy / "external.safetensors"
    path.write_bytes(b"read-only")
    fake_catalogue(monkeypatch, {"visual": {"file": "external"}})
    with pytest.raises(HTTPException) as raised:
        asyncio.run(refmods.delete_member("external"))
    assert raised.value.status_code == 422
    assert path.read_bytes() == b"read-only"
