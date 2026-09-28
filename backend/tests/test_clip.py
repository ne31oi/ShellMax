"""Clip contracts: revisions, approvals, isolation, recovery and final assembly."""

import asyncio
import json
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlmodel import SQLModel, Session, create_engine
from sqlalchemy.pool import StaticPool

from app import clip_api, clip_service
from app.clip_schema import (AudioAnalysis, BlockDraft, BlockVersion, CameraCard, ClipBlock,
                            ClipDocument, Passport, Shot, check_coverage)
from app.db import models
from app.db.models import ClipJob, ClipProject, Generation, MediaAsset, Project


@pytest.fixture
def db(monkeypatch, tmp_path):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)
    factory = lambda: Session(engine, expire_on_commit=False)
    for module in (models, clip_service, clip_api):
        monkeypatch.setattr(module, "session", factory)
    audio = tmp_path / "music.wav"
    audio.touch()
    with factory() as s:
        s.add(Project(id=1, name="Test"))
        s.add(Project(id=2, name="Other"))
        s.add(MediaAsset(id=1, project_id=1, kind="audio", path=str(audio), name="Music", duration=10, has_audio=True))
        s.commit()
    yield factory
    engine.dispose()


def shot(sid="s1", start=0, duration=2):
    return Shot(id=sid, name="Кадр", start=start, duration=duration, idea="Раскрыть пространство", action="Вход, остановка, реакция",
                music="Пауза", subject_motion="Справа налево", background_motion="Неподвижен",
                incoming_cut="По движению", outgoing_cut="На реакцию", light="Слева",
                camera=CameraCard(**{k: "Неподвижно" for k in CameraCard.model_fields}), prompt="subject_definitions:\nA subject")


def seed(factory):
    document = ClipDocument(name="Клип", idea="Идея", audio_asset_id=1, audio_start=1, audio_end=5,
                            passport=Passport(concept="Сохранить красный костюм"), passport_approved=True,
                            blocks=[ClipBlock(id="b1", name="Первый", start=0, end=2, intent="Начало",
                                              versions=[BlockVersion(version=1, shots=[shot()])]),
                                    ClipBlock(id="b2", name="Второй", start=2, end=4, intent="Конец",
                                              versions=[BlockVersion(version=1, shots=[shot("s2", 2)])])])
    with factory() as s:
        s.add(ClipProject(id="c1", project_id=1, chat_id="chat1", document=document.model_dump()))
        s.commit()
    return document


def test_revision_conflict_preserves_passport(db):
    doc = seed(db)
    changed = doc.model_copy(deep=True)
    changed.passport.costume = "Красный костюм"
    clip_service.save_document("c1", 0, changed)
    with pytest.raises(HTTPException) as exc:
        clip_service.save_document("c1", 0, doc)
    assert exc.value.status_code == 409
    assert clip_service.get_clip("c1").document["passport"]["costume"] == "Красный костюм"
    history = clip_api.revisions("c1")
    assert len(history) == 1 and history[0].document["passport"]["costume"] == ""


def test_coverage_checks_holes_overlaps_and_end():
    check_coverage([(0, 1), (1, 2.1)], 0, 2.1)
    for spans in ([(0, 1), (1.2, 2)], [(0, 1.2), (1, 2)], [(0, 1)]):
        with pytest.raises(ValueError):
            check_coverage(spans, 0, 2)


def test_align_shots_closes_subframe_endpoint_drift_and_rejects_real_gap():
    shots = [shot("s1", 0, 2.01), shot("s2", 2.01, 1.98)]
    clip_service.align_shots_to_block(shots, 0, 3.99)
    assert shots[0].start == 0 and shots[1].start == shots[0].duration
    assert round((shots[-1].start + shots[-1].duration) * 24) == round(3.99 * 24)

    with pytest.raises(ValueError, match="закрывать интервал"):
        clip_service.align_shots_to_block([shot("s1", 0, 1)], 0, 3)
    with pytest.raises(ValueError, match="идти подряд"):
        clip_service.align_shots_to_block([shot("s1", 0, 1), shot("s2", 1.2, 2)], 0, 3)


def test_partial_or_extra_model_json_rejected():
    with pytest.raises(ValueError):
        clip_service.decode_json('{"shots": [', BlockDraft)
    with pytest.raises(ValueError):
        clip_service.decode_json(json.dumps({"shots": [shot().model_dump()], "launch": True}), BlockDraft)


@pytest.mark.asyncio
async def test_editorial_disagreement_returns_reviewable_block(db, monkeypatch):
    doc = seed(db)
    monkeypatch.setattr(clip_service, "ref_tags", lambda ids: ({}, [], []))
    manager = clip_service.ClipManager(None, None)
    manager.cancels["develop"] = threading.Event()
    async def update(*args, **kwargs): pass
    manager.update = update
    calls = []
    async def llm(jid, system, user, images=None, schema=None):
        calls.append(schema)
        if schema is BlockDraft:
            return json.dumps({"shots": [shot().model_dump()]}, ensure_ascii=False)
        if schema is clip_service.EditorialReview:
            return json.dumps({"approved": False, "notes": ["Спорная смена камеры между кадрами"]})
        return "\n".join(f"{field}: заполнено" for field in (
            "subject_definitions", "summary", "retention_analysis", "detailed_description",
            "overall_soundscape", "non_diegetic_music"))
    manager.llm = llm
    result = await manager._develop(ClipJob(id="develop", request={"block_id": "b1"}), doc)
    assert result["editor_approved"] is False
    assert result["review"] == ["Спорная смена камеры между кадрами"]
    assert len(result["shots"]) == 1 and result["shots"][0]["prompt"]
    assert calls.count(BlockDraft) == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["complete", "resume", "exhausted", "invalid", "cancelled", "disconnected"])
async def test_structured_reply_continuation_is_bounded_and_validated(mode):
    full = json.dumps({"shots": [shot().model_dump()]}, ensure_ascii=False)
    cut = full.index("subject_definitions") + 8
    calls = []
    class Assistant:
        def precheck(self): pass
        async def stream(self, system, user, images):
            calls.append(user)
            if mode == "complete":
                yield {"delta": full}
            elif mode == "invalid":
                yield {"delta": '{"shots": []}'}
            elif len(calls) == 1:
                yield {"delta": full[:cut]}
            elif mode == "resume":
                assert full[:cut] in user
                yield {"delta": full[cut:]}
            else:
                yield {"delta": "more text"}
            if mode != "disconnected":
                yield {"done": True, "cancelled": mode == "cancelled"}
    manager = clip_service.ClipManager(Assistant(), None)
    manager.cancels["test"] = threading.Event()
    async def update(*args, **kwargs): pass
    manager.update = update
    if mode in ("complete", "resume"):
        result = await manager.llm("test", "System", "Block", schema=BlockDraft)
        assert result == full
        assert clip_service.decode_json(result, BlockDraft).shots == [shot()]
    else:
        with pytest.raises(ValueError, match="Повторите операцию") as exc:
            await manager.llm("test", "System", "Block", schema=BlockDraft)
        assert "validation error" not in str(exc.value)
    assert len(calls) == {"resume": 2, "exhausted": 3}.get(mode, 1)
    assert manager.owned_llm_job is None


def test_only_selected_block_gets_new_version(db):
    doc = seed(db)
    before = doc.blocks[1].model_dump()
    with db() as s:
        s.add(ClipJob(id="j1", clip_id="c1", kind="develop", status="done", base_revision=0,
                      result={"block_id": "b1", "shots": [shot("replacement").model_dump()],
                              "review": ["Проверить камеру"], "editor_approved": False}))
        s.commit()
    result = clip_api.accept("c1", "j1", clip_api.RevisionIn(revision=0))
    assert result["document"]["blocks"][1] == before
    versions = result["document"]["blocks"][0]["versions"]
    assert len(versions) == 2 and versions[0]["shots"][0]["id"] == "s1"
    assert versions[1]["draft_approved"] is False
    assert versions[1]["editor_approved"] is False
    assert clip_service.proposal_timeline("c1", "b1")["plans"][0]["reviewNotes"] == ["Проверить камеру"]
    with pytest.raises(HTTPException):
        clip_api.accept("c1", "j1", clip_api.RevisionIn(revision=1))


def test_canon_change_invalidates_blocks_not_history(db):
    seed(db)
    out = clip_api.edit_clip("c1", clip_api.EditIn(revision=0, passport=Passport(concept="Другая концепция")))
    assert not out["document"]["passport_approved"]
    assert all(b["stale"] and len(b["versions"]) == 1 for b in out["document"]["blocks"])


def test_refinements_are_selectable_without_inheriting_execution_job(db):
    doc = seed(db)
    with db() as s:
        s.add(Generation(id=1, project_id=1, status="done", seed=1, ui_params={}, output_asset_id=10,
                         info={"clip_id": "c1", "clip_job_id": "original", "block_id": "b1", "block_version": 1, "shot_id": "s1", "plan_mode": "final"}))
        s.add(Generation(id=2, project_id=1, kind="face", status="done", seed=1, ui_params={}, source_asset_id=10, output_asset_id=11))
        s.add(Generation(id=3, project_id=1, kind="enhance", status="done", seed=1, ui_params={}, source_asset_id=11, output_asset_id=12))
        s.commit()
    selected = clip_service.selected_takes("c1", doc.blocks[0], "final", {"s1": 3})[0][1]
    assert selected.id == 3 and "clip_job_id" not in selected.info
    assert len(clip_service.generations("c1")) == 3


def test_audio_replacement_clears_analysis(db):
    doc = seed(db)
    doc.analysis = AudioAnalysis(fingerprint="old", start=1, end=5)
    clip_service.save_document("c1", 0, doc)
    out = clip_api.edit_clip("c1", clip_api.EditIn(revision=1, audio_end=6))
    assert out["document"]["analysis"] is None
    assert out["document"]["blocks"][0]["stale"]


def test_cross_project_audio_rejected(db):
    with pytest.raises(HTTPException):
        clip_api.create_clip(clip_api.CreateIn(project_id=2, idea="Idea", audio_asset_id=1))


def test_assembly_requires_review_and_keeps_source_audio_time(db, tmp_path):
    doc = seed(db)
    with pytest.raises(ValueError, match="утвердите"):
        clip_service.assembly_timeline("c1")
    with db() as s:
        for i, b in enumerate(doc.blocks, 1):
            b.versions[0].draft_approved = b.versions[0].final_approved = True
            asset = tmp_path / f"take{i}.mp4"
            asset.touch()
            s.add(MediaAsset(id=i + 1, project_id=1, name="Take", kind="video", path=str(asset), duration=2.3))
            s.add(Generation(id=i, project_id=1, status="done", seed=1, ui_params={}, output_asset_id=i + 1,
                             info={"clip_id": "c1", "block_id": b.id, "block_version": 1, "shot_id": b.versions[0].shots[0].id, "plan_mode": "final"}))
            b.versions[0].selected_final = {b.versions[0].shots[0].id: i}
        s.commit()
    clip_service.save_document("c1", 0, doc)
    timeline = clip_service.assembly_timeline("c1")
    assert [c["out"] for c in timeline["tracks"][0]["clips"]] == [2, 2]
    assert all(c["muted"] for c in timeline["tracks"][0]["clips"])
    audio = timeline["tracks"][1]["clips"][0]
    assert (audio["in"], audio["out"], audio["start"]) == (1, 5, 0)
    with pytest.raises(ValueError):
        clip_service.selected_takes("c1", doc.blocks[0], "final", {"s1": 2})


@pytest.mark.asyncio
async def test_job_double_click_and_cancel_never_apply_partial_reply(db):
    seed(db)
    started = asyncio.Event()
    release = asyncio.Event()
    class Assistant:
        def precheck(self): pass
        def cancel(self): release.set()
        async def stream(self, *args):
            started.set()
            yield {"delta": "Незаконченный ответ"}
            await release.wait()
            yield {"done": True, "cancelled": True}
    manager = clip_service.ClipManager(Assistant(), None)
    request = {"text": "Идеи"}
    job = manager.create("c1", "discuss", 0, request)
    same = manager.create("c1", "discuss", 0, request)
    assert same.id == job.id
    task = manager.tasks[job.id]
    await started.wait()
    await manager.cancel(job.id)
    await task
    assert clip_service.get_clip("c1").revision == 0
    assert clip_service.get_clip("c1").document["messages"] == []
    with db() as s:
        assert s.get(ClipJob, job.id).status == "cancelled"


@pytest.mark.asyncio
async def test_restart_does_not_replay_creative_jobs(db):
    seed(db)
    with db() as s:
        s.add(ClipJob(id="unfinished", clip_id="c1", kind="develop", status="running"))
        s.commit()
    manager = clip_service.ClipManager(None, None)
    await manager.start()
    with db() as s:
        assert s.get(ClipJob, "unfinished").status == "interrupted"
    assert manager.tasks == {}


def test_api_operation_runs_on_event_loop(db):
    seed(db)
    class Manager:
        def create(self, *args):
            assert asyncio.get_running_loop().is_running()
            return {"ok": True}
    app = FastAPI()
    app.include_router(clip_api.router)
    app.state.clips = Manager()
    with TestClient(app) as client:
        response = client.post("/api/assistant/clip-projects/c1/operations", json={"revision": 0, "kind": "discuss", "text": "Test"})
        assert response.status_code == 200


def test_plan_duration_and_output_settings_roundtrip():
    from app.timeline_schema import normalize_timeline, parse_timeline
    doc = {"outputWidth": 832, "outputHeight": 1440, "outputFps": 24, "tracks": [
        {"id": "p", "kind": "plan", "plans": [{"id": "s", "duration": 1, "start": 0, "renderDuration": 1.625, "sourceIn": 0.2}]}]}
    parsed = parse_timeline(normalize_timeline(doc))
    assert parsed.output_width == 832 and parsed.output_height == 1440
    plan = next(t for t in parsed.tracks if t.id == "p").plans[0]
    assert plan.render_duration == 1.625 and plan.duration == 1 and plan.source_in == 0.2


@pytest.mark.asyncio
async def test_resume_reconciles_existing_generations_without_enqueue(db):
    seed(db)
    with db() as s:
        s.add(Generation(id=11, project_id=1, status="done", seed=1, ui_params={},
                         info={"clip_id": "c1", "clip_job_id": "resume", "shot_id": "s1"}))
        s.add(ClipJob(id="resume", clip_id="c1", kind="generate", status="running",
                      request={"block_id": "b1", "mode": "draft"}))
        s.commit()
    class Queue:
        def enqueue(self, _):
            pytest.fail("Restart must not enqueue another generation")
    manager = clip_service.ClipManager(None, Queue())
    await manager.start()
    await asyncio.gather(*list(manager.tasks.values()))
    with db() as s:
        job = s.get(ClipJob, "resume")
        assert job.status == "done" and job.result["generation_ids"] == [11]
        assert len(s.exec(models.select(Generation)).all()) == 1


@pytest.mark.asyncio
async def test_manual_plan_edit_is_not_submitted_or_overwritten(db):
    doc = seed(db)
    proposal = clip_service.proposal_timeline("c1", "b1")
    proposal["plans"][0]["prompt"] = "Manual work"
    timeline = {"tracks": [proposal["audio_track"], {"id": proposal["track_id"], "kind": "plan", "plans": proposal["plans"]}]}
    with db() as s:
        project = s.get(Project, 1)
        project.timeline = timeline
        s.add(project)
        s.commit()
    manager = clip_service.ClipManager(None, None)
    job = ClipJob(id="manual", clip_id="c1", kind="generate", request={"block_id": "b1", "mode": "draft"})
    with pytest.raises(ValueError, match="Планы изменены"):
        await manager._generate(job, doc, 1, False)
    with db() as s:
        assert s.get(Project, 1).timeline == timeline
        assert not s.exec(models.select(Generation)).all()


@pytest.mark.asyncio
async def test_queue_resume_uses_existing_comfy_prompt(monkeypatch):
    from app.jobs.queue import JobManager
    class Client:
        async def history(self, pid):
            assert pid == "existing-prompt"
            return {"status": {"completed": True, "status_str": "success"}}
        async def queue_prompt(self, _):
            pytest.fail("Recovery must not submit a graph")
    manager = JobManager(Client(), SimpleNamespace(state="ready", pid=42))
    async def collect(r):
        r.final_asset_id = 100
    results = []
    async def finish(gid, status, **kwargs):
        results.append((gid, status))
    monkeypatch.setattr(manager, "_collect_missing_outputs", collect)
    monkeypatch.setattr(manager, "_finish", finish)
    await manager._resume(Generation(id=12, project_id=1, status="running", seed=1, ui_params={}, comfy_prompt_id="existing-prompt"))
    assert results == [(12, "done")]
