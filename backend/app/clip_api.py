"""Project-scoped directing API. Every accepted proposal is revision checked."""

import uuid
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.routing import APIRoute
from pydantic import BaseModel, Field

from .clip_schema import (AudioAnalysis, BlockDraft, BlockVersion, ClipBlock, ClipDocument,
                          Passport, Section, Treatment, check_coverage)
from .clip_service import (ACTIVE, assembly_timeline, block_by_id, get_clip, proposal_timeline,
                           ref_tags, save_document, selected_takes, snapshot)
from .db.models import AssistantChat, ClipJob, ClipProject, ClipRevision, MediaAsset, Project, select, session
from .media.clip_audio import model_ready

class ClipRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def guarded(request):
            try:
                return await handler(request)
            except ValueError as e:
                raise HTTPException(422, str(e)) from e
        return guarded


router = APIRouter(prefix="/api/assistant", tags=["clip"], route_class=ClipRoute)


class CreateIn(BaseModel):
    project_id: int
    idea: str = Field(min_length=1, max_length=12000)
    audio_asset_id: int
    audio_start: float = Field(default=0, ge=0)
    audio_end: float | None = None
    ref_ids: list[str] = Field(default_factory=list)


class EditIn(BaseModel):
    revision: int
    passport: Passport | None = None
    idea: str | None = None
    name: str | None = None
    lyrics: str | None = None
    sections: list[Section] | None = None
    ref_ids: list[str] | None = None
    quality: Literal["draft", "standard", "high"] | None = None
    audio_asset_id: int | None = None
    audio_start: float | None = None
    audio_end: float | None = None


class OperationIn(BaseModel):
    revision: int
    kind: Literal["analyze", "discuss", "treatment", "develop", "generate", "review", "preview"]
    text: str = Field(default="", max_length=12000)
    block_id: str | None = None
    mode: Literal["draft", "final"] = "draft"
    selections: dict[str, int] = Field(default_factory=dict)
    shot_ids: list[str] = Field(default_factory=list)


class RevisionIn(BaseModel):
    revision: int


class ApprovalIn(RevisionIn):
    mode: Literal["draft", "final"]
    selections: dict[str, int] = Field(default_factory=dict)


def audio_asset(project_id, aid, start, end):
    with session() as s:
        asset = s.get(MediaAsset, aid)
    if not asset or asset.project_id != project_id or asset.kind != "audio" or not Path(asset.path).is_file():
        raise HTTPException(422, "Выберите существующий аудиотрек этого проекта")
    end = end if end is not None else asset.duration
    if end is None or start < 0 or start >= end or end > (asset.duration or 0) + 0.001:
        raise HTTPException(422, "Проверьте границы аудиотрека")
    return end


def editable(cid, revision):
    row = get_clip(cid)
    if revision != row.revision:
        raise HTTPException(409, "Проект изменился — обновите страницу")
    with session() as s:
        running = s.exec(select(ClipJob).where(ClipJob.clip_id == cid, ClipJob.status.in_(ACTIVE))).first()
    if running:
        raise HTTPException(409, "Дождитесь операции или остановите её перед правкой")
    return row, ClipDocument.model_validate(row.document)


@router.get("/clip-projects")
def list_clips(project_id: int):
    with session() as s:
        rows = s.exec(select(ClipProject).where(ClipProject.project_id == project_id).order_by(ClipProject.updated.desc())).all()
    return [{"id": r.id, "name": r.document["name"], "revision": r.revision} for r in rows]


@router.post("/clip-projects")
def create_clip(body: CreateIn):
    with session() as s:
        if not s.get(Project, body.project_id):
            raise HTTPException(404, "Проект не найден")
    end = audio_asset(body.project_id, body.audio_asset_id, body.audio_start, body.audio_end)
    ref_tags(body.ref_ids)
    doc = ClipDocument(name=body.idea.strip()[:60], idea=body.idea.strip(), audio_asset_id=body.audio_asset_id,
                       audio_start=body.audio_start, audio_end=end, ref_ids=list(dict.fromkeys(body.ref_ids)))
    cid, chat_id = uuid.uuid4().hex[:12], uuid.uuid4().hex[:12]
    with session() as s:
        s.add(AssistantChat(id=chat_id, title="Клип: " + doc.name))
        s.add(ClipProject(id=cid, project_id=body.project_id, chat_id=chat_id, document=doc.model_dump()))
        s.commit()
    return snapshot(cid)


@router.get("/clip-projects/{cid}")
def read_clip(cid: str):
    return snapshot(cid)


@router.patch("/clip-projects/{cid}")
def edit_clip(cid: str, body: EditIn):
    row, doc = editable(cid, body.revision)
    before = doc.model_copy(deep=True)
    for field in ("passport", "idea", "name", "ref_ids", "quality", "audio_asset_id", "audio_start", "audio_end"):
        value = getattr(body, field)
        if value is not None:
            setattr(doc, field, value)
    doc = ClipDocument.model_validate(doc.model_dump())
    ref_tags(doc.ref_ids)
    audio_asset(row.project_id, doc.audio_asset_id, doc.audio_start, doc.audio_end)
    changed_audio = any(getattr(doc, k) != getattr(before, k) for k in ("audio_asset_id", "audio_start", "audio_end"))
    if changed_audio:
        doc.analysis = None
    if body.lyrics is not None or body.sections is not None:
        if not doc.analysis:
            raise HTTPException(422, "Сначала разберите трек")
        if body.lyrics is not None:
            doc.analysis.lyrics = body.lyrics
        if body.sections is not None:
            check_coverage([(x.start, x.end) for x in body.sections], doc.audio_start, doc.audio_end)
            doc.analysis.sections = body.sections
    changed_canon = doc.passport != before.passport or doc.ref_ids != before.ref_ids or doc.idea != before.idea
    if changed_canon or changed_audio or body.lyrics is not None or body.sections is not None:
        doc.passport_approved = False
        for block in doc.blocks:
            block.stale = True
    save_document(cid, body.revision, doc)
    return snapshot(cid)


@router.get("/clip-projects/{cid}/revisions")
def revisions(cid: str):
    get_clip(cid)
    with session() as s:
        return s.exec(select(ClipRevision).where(ClipRevision.clip_id == cid).order_by(ClipRevision.revision.desc())).all()


@router.post("/clip-projects/{cid}/operations")
async def operation(cid: str, body: OperationIn, request: Request):
    get_clip(cid)
    if body.kind == "discuss" and not body.text.strip():
        raise HTTPException(422, "Напишите сообщение")
    if body.kind in ("develop", "generate", "review", "preview") and not body.block_id:
        raise HTTPException(422, "Выберите блок")
    return request.app.state.clips.create(cid, body.kind, body.revision, body.model_dump(exclude={"revision", "kind"}))


@router.post("/clip-projects/{cid}/accept/{jid}")
def accept(cid: str, jid: str, body: RevisionIn):
    row, doc = editable(cid, body.revision)
    with session() as s:
        job = s.get(ClipJob, jid)
    if not job or job.clip_id != cid or job.status != "done":
        raise HTTPException(422, "Предложение ещё не готово")
    if job.base_revision != row.revision:
        raise HTTPException(409, "Это предложение относится к старой версии — создайте новое")
    if job.kind == "analyze":
        doc.analysis = AudioAnalysis.model_validate(job.result["analysis"])
        for block in doc.blocks:
            block.stale = True
    elif job.kind == "treatment":
        proposal = Treatment.model_validate(job.result)
        check_coverage([(b.start, b.end) for b in proposal.blocks], 0, doc.audio_end - doc.audio_start)
        # Archived structures remain in the accepted job, including every prior block version.
        with session() as s:
            stored = s.get(ClipJob, jid)
            stored.result = {**stored.result, "previous_document": doc.model_dump()}
            s.add(stored)
            s.commit()
        doc.passport = proposal.passport
        doc.passport_approved = True
        doc.blocks = [ClipBlock(**b.model_dump()) for b in proposal.blocks]
    elif job.kind == "develop":
        block = block_by_id(doc, job.result["block_id"])
        draft = BlockDraft.model_validate({"shots": job.result["shots"]})
        check_coverage([(s.start, s.start + s.duration) for s in draft.shots], block.start, block.end)
        block.versions.append(BlockVersion(version=(block.versions[-1].version + 1) if block.versions else 1,
                                           shots=draft.shots, review=job.result["review"]))
        block.stale = False
    else:
        raise HTTPException(422, "Эта операция не содержит предложения")
    save_document(cid, body.revision, doc)
    return snapshot(cid)


@router.post("/clip-projects/{cid}/approve-passport")
def approve_passport(cid: str, body: RevisionIn):
    _, doc = editable(cid, body.revision)
    if not doc.passport.concept.strip():
        raise HTTPException(422, "Заполните концепцию паспорта")
    doc.passport_approved = True
    save_document(cid, body.revision, doc)
    return snapshot(cid)


@router.post("/clip-projects/{cid}/blocks/{bid}/approve")
def approve_block(cid: str, bid: str, body: ApprovalIn):
    _, doc = editable(cid, body.revision)
    block = block_by_id(doc, bid)
    takes = selected_takes(cid, block, body.mode, body.selections)
    selected = {shot.id: gen.id for shot, gen in takes}
    version = block.versions[-1]
    if body.mode == "draft":
        version.draft_approved = True
        version.selected_draft = selected
    else:
        version.final_approved = True
        version.selected_final = selected
    save_document(cid, body.revision, doc)
    return snapshot(cid)


@router.get("/clip-projects/{cid}/blocks/{bid}/timeline")
def proposed_timeline(cid: str, bid: str):
    return proposal_timeline(cid, bid)


@router.get("/clip-projects/{cid}/assembly")
def assembly(cid: str):
    return {"revision": get_clip(cid).revision, "timeline": assembly_timeline(cid)}


@router.post("/clip-projects/{cid}/jobs/{jid}/stop")
async def stop_job(cid: str, jid: str, request: Request):
    with session() as s:
        job = s.get(ClipJob, jid)
    if not job or job.clip_id != cid:
        raise HTTPException(404, "Задание не найдено")
    await request.app.state.clips.cancel(jid)
    return {"ok": True}


@router.get("/audio-model")
def audio_model():
    with session() as s:
        job = s.exec(select(ClipJob).where(ClipJob.kind == "download_audio").order_by(ClipJob.created.desc())).first()
    return {"ready": model_ready(), "job": job}


@router.post("/audio-model/download")
async def download_audio_model(request: Request):
    return request.app.state.clips.create("", "download_audio", 0, {})
