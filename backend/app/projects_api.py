"""Projects, timeline, export, plans, beat analysis."""

from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import services, settings
from .api_common import not_found, state
from .db.models import MediaAsset, Project, kv_get, kv_set, select, session
from .jobs.persist import push_generation
from .media import library
from .workflow import presets
from .workflow.params import UIParams

router = APIRouter()

# ---------------------------------------------------------------- projects / timeline (NLE)
@router.get("/projects")
def list_projects():
    with session() as s:
        return s.exec(select(Project).order_by(Project.id)).all()


class ProjectIn(BaseModel):
    name: str = "Новый проект"


@router.post("/projects")
def create_project(body: ProjectIn):
    name = (body.name or "").strip()[:80] or "Новый проект"
    with session() as s:
        p = Project(name=name)
        s.add(p)
        s.commit()
        s.refresh(p)
        return p


@router.patch("/projects/{pid}")
def rename_project(pid: int, body: ProjectIn):
    name = (body.name or "").strip()[:80] or "Без названия"
    with session() as s:
        p = s.get(Project, pid) or not_found()
        p.name = name
        s.add(p)
        s.commit()
        s.refresh(p)
        return p


@router.get("/projects/{pid}")
def get_project(pid: int):
    from .timeline_schema import normalize_timeline
    with session() as s:
        p = s.get(Project, pid) or not_found()
        data = p.model_dump()
        data["timeline"] = normalize_timeline(p.timeline)
        return data


@router.put("/projects/{pid}/timeline")
def put_timeline(pid: int, timeline: dict):
    from .timeline_schema import normalize_timeline
    from pydantic import ValidationError
    try:
        normalized = normalize_timeline(timeline)
    except ValidationError as e:
        raise HTTPException(400, f"Некорректный таймлайн: {e.errors()[0].get('msg', 'ошибка')}") from e
    with session() as s:
        p = s.get(Project, pid) or not_found()
        p.timeline = normalized
        s.add(p)
        s.commit()
    return normalized


@router.post("/projects/{pid}/export")
async def export_project(pid: int):
    """Trim + concat the project's video track into a new library asset."""
    from .media.timeline_export import export_project_timeline
    with session() as s:
        p = s.get(Project, pid) or not_found()
        raw = p.timeline
    asset = await export_project_timeline(pid, raw or {})
    return asset


class PlansEnqueueIn(BaseModel):
    plan_ids: list[str]
    mode: str = "draft"  # draft | final


@router.post("/projects/{pid}/plans/enqueue")
async def enqueue_plans(pid: int, body: PlansEnqueueIn, request: Request):
    """Queue generate jobs for storyboard plans (serial JobManager)."""
    from . import plans as plans_svc
    if body.mode not in ("draft", "final"):
        raise HTTPException(400, "mode должен быть draft или final")
    if not body.plan_ids:
        raise HTTPException(400, "Не выбраны планы")
    with session() as s:
        s.get(Project, pid) or not_found()
    try:
        gens = await plans_svc.create_plan_generations(pid, body.plan_ids, body.mode)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    jobs = state(request).jobs
    for g in gens:
        await push_generation(g)
        jobs.enqueue(g.id)
    with session() as s:
        p = s.get(Project, pid)
        timeline = p.timeline if p else {}
    return {"generations": gens, "timeline": timeline}


class BeatRangeIn(BaseModel):
    start: float | None = 0
    end: float | None = None


@router.post("/assets/{aid}/analyze-beats")
def analyze_asset_beats(aid: int, body: BeatRangeIn | None = None):
    """Detect beat/downbeat markers for Resolve-style timeline snap.

    Optional body: { start, end } — analyze only this media window (seconds).
    Returned beat times are relative to `start` (0 = window begin).
    """
    from .media.beats import analyze_beats
    with session() as s:
        asset = s.get(MediaAsset, aid) or not_found()
        path = asset.path
    start = float(body.start or 0) if body else 0.0
    end = float(body.end) if body and body.end is not None else None
    cache_key = f"beats:v2:{aid}:{start:.3f}:{end if end is not None else 'full'}"
    cached = kv_get(cache_key)
    if isinstance(cached, dict) and cached.get("beats") is not None:
        return cached
    try:
        result = analyze_beats(path, start_s=start, end_s=end)
    except FileNotFoundError:
        raise HTTPException(404, "Файл медиа не найден") from None
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, str(e)) from e
    kv_set(cache_key, result)
    return result


