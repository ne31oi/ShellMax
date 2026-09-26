"""REST + websocket API consumed by the frontend."""

import os
import subprocess
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import services, settings
from .db.models import (EngineProfileRow, Generation, MediaAsset, Project, StyleLora, Upload, kv_get, kv_set,
                        select, session)
from .fs import browse
from .hub import hub
from .jobs.estimator import estimate_seconds
from .jobs.queue import push_generation, register_asset
from .media import library
from .workflow import presets
from .workflow.params import ASPECT_RATIOS, FPS, MAX_REFS, EngineProfile, UIParams, frame_count

router = APIRouter(prefix="/api")


def _state(request: Request):
    return request.app.state


# ---------------------------------------------------------------- meta
@router.get("/meta")
def meta():
    d = settings.defaults()
    qp = presets.quality_presets()
    return {
        "fps": FPS,
        "aspects": [{"id": a, "ratio": list(r), "short": a.split(" ")[0]} for a, r in ASPECT_RATIOS.items()],
        "quality": [{"id": k, "label": v["label"],
                     "resolutions": {a: presets.resolution_for(a, k) for a in ASPECT_RATIOS}} for k, v in qp.items()],
        "duration": {"min": 1.0, "max": 20.0, "optimal": [5.0, 15.0]},
        "max_refs": MAX_REFS,
        "defaults": d["ui"],
    }


@router.get("/frames")
def frames(duration: float):
    n = frame_count(duration)
    return {"frames": n, "seconds": n / FPS}


@router.get("/estimate")
def estimate(aspect: str, quality: str, duration: float):
    res = presets.resolution_for(aspect, quality)["final"]
    return {"seconds": estimate_seconds(res[0] * res[1] * frame_count(duration))}


# ---------------------------------------------------------------- sticky ui state
@router.get("/state/ui")
def get_ui_state():
    return kv_get("ui_last", {})


@router.put("/state/ui")
def put_ui_state(value: dict):
    kv_set("ui_last", value)
    return {"ok": True}


# ---------------------------------------------------------------- engine
@router.get("/engine")
def engine_state(request: Request):
    return _state(request).engine.snapshot()


@router.post("/engine/{action}")
async def engine_action(action: str, request: Request):
    eng = _state(request).engine
    if action == "start":
        await eng.start()
    elif action == "stop":
        await eng.stop()
    elif action == "restart":
        await eng.restart()
    else:
        raise HTTPException(404)
    return eng.snapshot()


_FALLBACK_OPTIONS = {"sampler": ["seeds_2", "euler", "euler_ancestral", "res_multistep"],
                     "scheduler": ["simple", "sgm_uniform", "karras", "exponential", "beta", "normal"]}
_options_cache: dict = {}


def _combo_options(spec) -> list[str]:
    """object_info combo spec: legacy [[...options]] or new ["COMBO", {"options": [...]}]."""
    first = spec[0] if spec else []
    if isinstance(first, list):
        return first
    if len(spec) > 1 and isinstance(spec[1], dict):
        return spec[1].get("options", [])
    return []


@router.get("/engine/options")
async def engine_options(request: Request):
    """Choices for expert dropdowns, read from the engine itself (falls back while it is down)."""
    if not _options_cache:
        client = _state(request).engine.client
        try:
            ks = await client.object_info("KSamplerSelect")
            bs = await client.object_info("BasicScheduler")
            _options_cache["sampler"] = _combo_options(ks["KSamplerSelect"]["input"]["required"]["sampler_name"])
            _options_cache["scheduler"] = _combo_options(bs["BasicScheduler"]["input"]["required"]["scheduler"])
        except Exception:  # noqa: BLE001 - engine not ready yet
            return {**_FALLBACK_OPTIONS, "live": False}
    return {**_options_cache, "live": True}


@router.get("/engine/log")
def engine_log(request: Request, tail: int = 400):
    return {"lines": _state(request).engine.log_tail(tail)}


# ---------------------------------------------------------------- profiles
@router.get("/profiles")
def list_profiles():
    with session() as s:
        rows = s.exec(select(EngineProfileRow).order_by(EngineProfileRow.id)).all()
    return [{"id": r.id, "name": r.name, "is_default": r.is_default, "data": r.data,
             "problems": services.profile_problems(EngineProfile(**r.data))} for r in rows]


class ProfileIn(BaseModel):
    data: EngineProfile
    is_default: bool = False


@router.post("/profiles")
def create_profile(body: ProfileIn):
    with session() as s:
        row = EngineProfileRow(name=body.data.name, data=body.data.model_dump(), is_default=body.is_default)
        s.add(row)
        s.commit()
        s.refresh(row)
        if body.is_default:
            _make_default(s, row.id)
    return {"id": row.id}


@router.put("/profiles/{pid}")
def update_profile(pid: int, body: ProfileIn):
    with session() as s:
        row = s.get(EngineProfileRow, pid) or _404()
        row.name, row.data = body.data.name, body.data.model_dump()
        s.add(row)
        s.commit()
        if body.is_default:
            _make_default(s, pid)
    return {"ok": True, "problems": services.profile_problems(body.data)}


@router.delete("/profiles/{pid}")
def delete_profile(pid: int):
    with session() as s:
        if len(s.exec(select(EngineProfileRow)).all()) <= 1:
            raise HTTPException(400, "Нельзя удалить единственный профиль")
        row = s.get(EngineProfileRow, pid) or _404()
        s.delete(row)
        s.commit()
        if row.is_default:
            first = s.exec(select(EngineProfileRow)).first()
            _make_default(s, first.id)
    return {"ok": True}


@router.get("/profiles/workflow-defaults")
def workflow_defaults():
    return presets.default_profile().model_dump()


def _make_default(s, pid: int) -> None:
    for r in s.exec(select(EngineProfileRow)).all():
        r.is_default = r.id == pid
        s.add(r)
    s.commit()


# ---------------------------------------------------------------- styles (creative LoRA library)
class StyleIn(BaseModel):
    name: str
    path: str
    default_strength: float = 1.0
    triggers: list[str] = []


@router.get("/styles")
def list_styles():
    with session() as s:
        return s.exec(select(StyleLora).order_by(StyleLora.name)).all()


@router.post("/styles")
def create_style(body: StyleIn):
    chk = browse.check(body.path)
    if not chk["exists"]:
        raise HTTPException(422, f"Файл не найден: {chk['path']}")
    with session() as s:
        row = StyleLora(name=body.name or Path(chk["path"]).stem, path=chk["path"],
                        default_strength=body.default_strength, triggers=[t.strip() for t in body.triggers if t.strip()])
        s.add(row)
        s.commit()
        s.refresh(row)
        return row


@router.put("/styles/{sid}")
def update_style(sid: int, body: StyleIn):
    with session() as s:
        row = s.get(StyleLora, sid) or _404()
        row.name, row.path = body.name, browse.check(body.path)["path"]
        row.default_strength = body.default_strength
        row.triggers = [t.strip() for t in body.triggers if t.strip()]
        s.add(row)
        s.commit()
        return row


@router.delete("/styles/{sid}")
def delete_style(sid: int):
    with session() as s:
        row = s.get(StyleLora, sid) or _404()
        s.delete(row)
        s.commit()
    return {"ok": True}


# ---------------------------------------------------------------- filesystem
@router.get("/fs/list")
def fs_list(path: str = ""):
    try:
        return browse.list_dir(path)
    except FileNotFoundError:
        raise HTTPException(404, f"Папка не найдена: {path}")


@router.get("/fs/check")
def fs_check(path: str):
    return browse.check(path)


@router.get("/models/scan")
def models_scan():
    return browse.scan_models()


# ---------------------------------------------------------------- uploads (references)
@router.post("/uploads")
async def upload(file: UploadFile = File(...)):
    return await services.save_upload(file)


@router.get("/uploads/{uid}")
def get_upload(uid: str):
    with session() as s:
        return s.get(Upload, uid) or _404()


@router.get("/uploads/{uid}/file")
def upload_file(uid: str):
    with session() as s:
        up = s.get(Upload, uid) or _404()
    return FileResponse(up.path)


@router.get("/uploads/{uid}/thumb")
def upload_thumb(uid: str):
    thumb = settings.THUMBS_DIR / f"up_{uid}.jpg"
    if thumb.exists():
        return FileResponse(thumb)
    return upload_file(uid)


# ---------------------------------------------------------------- generations
@router.get("/generations")
def list_generations(project_id: int = 1, limit: int = 200):
    with session() as s:
        return s.exec(select(Generation).where(Generation.project_id == project_id)
                      .order_by(Generation.id.desc()).limit(limit)).all()


@router.post("/generations")
async def create_generation(ui: UIParams, request: Request, project_id: int = 1):
    gens = services.create_generations(ui, project_id)
    jobs = _state(request).jobs
    for g in gens:
        await push_generation(g)
        jobs.enqueue(g.id)
    return gens


class RetryIn(BaseModel):
    same_seed: bool = False
    variants: int = 1


@router.post("/generations/{gid}/retry")
async def retry_generation(gid: int, body: RetryIn, request: Request):
    with session() as s:
        g = s.get(Generation, gid) or _404()
    ui = UIParams(**{**g.ui_params, "seed": g.seed if body.same_seed else None, "variants": body.variants})
    return await create_generation(ui, request, g.project_id)


@router.post("/generations/{gid}/cancel")
async def cancel_generation(gid: int, request: Request):
    await _state(request).jobs.cancel(gid)
    return {"ok": True}


@router.delete("/generations/{gid}")
async def delete_generation(gid: int, request: Request):
    jobs = _state(request).jobs
    if jobs.running and jobs.running.gen_id == gid:
        raise HTTPException(409, "Генерация ещё идёт — сначала остановите её")
    with session() as s:
        g = s.get(Generation, gid) or _404()
        for aid in (g.draft_asset_id, g.output_asset_id):
            asset = s.get(MediaAsset, aid) if aid else None
            if asset:
                _remove_files(asset)
                s.delete(asset)
        s.delete(g)
        s.commit()
    await hub.broadcast({"type": "generation_deleted", "id": gid})
    return {"ok": True}


# ---------------------------------------------------------------- assets
@router.get("/assets")
def list_assets(project_id: int = 1):
    with session() as s:
        return s.exec(select(MediaAsset).where(MediaAsset.project_id == project_id)
                      .order_by(MediaAsset.id.desc())).all()


@router.get("/assets/{aid}/file")
def asset_file(aid: int):
    with session() as s:
        a = s.get(MediaAsset, aid) or _404()
    return FileResponse(a.path)


@router.get("/assets/{aid}/thumb")
def asset_thumb(aid: int):
    with session() as s:
        a = s.get(MediaAsset, aid) or _404()
    if a.thumb and Path(a.thumb).exists():
        return FileResponse(a.thumb)
    raise HTTPException(404)


class FrameIn(BaseModel):
    t: float


@router.post("/assets/{aid}/frame")
async def asset_frame(aid: int, body: FrameIn):
    """Grab a frame as a new reference image upload."""
    with session() as s:
        a = s.get(MediaAsset, aid) or _404()
    uid = uuid.uuid4().hex[:16]
    dest = settings.UPLOADS_DIR / f"{uid}.png"
    await library.extract_frame(Path(a.path), dest, body.t)
    meta = await library.probe(dest)
    await library.thumbnail(dest, settings.THUMBS_DIR / f"up_{uid}.jpg", "image")
    up = Upload(id=uid, kind="image", orig_name=f"{a.name} @ {body.t:.2f}s.png", path=str(dest),
                width=meta.width, height=meta.height)
    with session() as s:
        s.add(up)
        s.commit()
    return up


@router.post("/assets/{aid}/as-upload")
def asset_as_upload(aid: int):
    """Use a library clip itself as a reference (dragged from the media bin into the refs zone)."""
    with session() as s:
        a = s.get(MediaAsset, aid) or _404()
        uid = f"a{aid}"
        up = s.get(Upload, uid)
        if up is None:
            up = Upload(id=uid, kind=a.kind, orig_name=a.name, path=a.path, duration=a.duration,
                        width=a.width, height=a.height, has_audio=a.has_audio)
            s.add(up)
            s.commit()
            if a.thumb and Path(a.thumb).exists():
                import shutil
                shutil.copy2(a.thumb, settings.THUMBS_DIR / f"up_{uid}.jpg")
        return up


@router.post("/assets/import")
async def import_asset(file: UploadFile = File(...), project_id: int = 1):
    kind = library.kind_of(file.filename or "")
    if kind is None:
        raise HTTPException(415, "Неподдерживаемый тип файла")
    dest = settings.MEDIA_DIR / f"imp_{uuid.uuid4().hex[:10]}_{Path(file.filename).name}"
    with dest.open("wb") as f:
        while chunk := await file.read(1 << 20):
            f.write(chunk)
    aid = await register_asset(dest, generation_id=None, source="imported", project_id=project_id,
                               name=Path(file.filename).stem)
    with session() as s:
        return s.get(MediaAsset, aid)


@router.post("/assets/{aid}/reveal")
def reveal_asset(aid: int):
    with session() as s:
        a = s.get(MediaAsset, aid) or _404()
    if os.name == "nt":
        subprocess.Popen(["explorer", "/select,", a.path])
    return {"ok": True}


def _remove_files(asset: MediaAsset) -> None:
    for p in (asset.path, asset.thumb):
        if p:
            Path(p).unlink(missing_ok=True)


# ---------------------------------------------------------------- projects / timeline (NLE)
@router.get("/projects")
def list_projects():
    with session() as s:
        return s.exec(select(Project).order_by(Project.id)).all()


@router.get("/projects/{pid}")
def get_project(pid: int):
    with session() as s:
        return s.get(Project, pid) or _404()


@router.put("/projects/{pid}/timeline")
def put_timeline(pid: int, timeline: dict):
    with session() as s:
        p = s.get(Project, pid) or _404()
        p.timeline = timeline
        s.add(p)
        s.commit()
    return {"ok": True}


# ---------------------------------------------------------------- live events
@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await hub.connect(ws)
    try:
        await ws.send_json({"type": "engine", "engine": ws.app.state.engine.snapshot()})
        while True:
            await ws.receive_text()  # keepalive; the UI doesn't send commands here
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(ws)


def _404():
    raise HTTPException(404, "не найдено")
