"""Uploads and media assets."""

import json
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import services, settings
from .api_common import not_found
from .db.models import Generation, MediaAsset, Upload, select, session
from .jobs.persist import register_asset
from .media import library

router = APIRouter()

# ---------------------------------------------------------------- uploads (references)
@router.post("/uploads")
async def upload(file: UploadFile = File(...)):
    return await services.save_upload(file)


@router.get("/uploads")
def list_uploads(used: bool = True):
    """Unique reference uploads the user has used (generations / face / plans)."""
    return services.list_uploads(used_only=used)


@router.get("/uploads/{uid}")
def get_upload(uid: str):
    with session() as s:
        return s.get(Upload, uid) or not_found()


@router.get("/uploads/{uid}/file")
def upload_file(uid: str):
    with session() as s:
        up = s.get(Upload, uid) or not_found()
    return FileResponse(up.path)


@router.post("/uploads/{uid}/edit")
async def edit_upload(uid: str, body: services.RefEdit):
    """Crop / fragment of a reference as a derived upload (the original is kept)."""
    return await services.edit_upload(uid, body)


@router.get("/uploads/{uid}/peaks")
async def upload_peaks(uid: str):
    with session() as s:
        up = s.get(Upload, uid) or not_found()
    return await services.peaks_cached(Path(up.path), uid, up.duration)


@router.get("/uploads/{uid}/thumb")
def upload_thumb(uid: str):
    thumb = settings.THUMBS_DIR / f"up_{uid}.jpg"
    if thumb.exists():
        return FileResponse(thumb)
    return upload_file(uid)



# ---------------------------------------------------------------- assets
@router.get("/assets")
def list_assets(project_id: int = 1):
    with session() as s:
        return s.exec(select(MediaAsset).where(MediaAsset.project_id == project_id)
                      .order_by(MediaAsset.id.desc())).all()


@router.delete("/assets/{aid}")
async def delete_asset(aid: int):
    """Remove an imported library file. Generated/draft assets are deleted with their generation."""
    with session() as s:
        a = s.get(MediaAsset, aid) or not_found()
        if a.source != "imported" and a.source != "exported":
            raise HTTPException(400, "Удалять можно только импортированные и экспортированные файлы — сгенерированные удаляются вместе с задачей")
        dependents = [g for g in s.exec(select(Generation)).all() if g.source_asset_id == aid]
        if dependents:
            raise HTTPException(
                409,
                f"Файл используется в {len(dependents)} "
                f"{'задаче' if len(dependents) == 1 else 'задачах'} улучшения — сначала удалите их",
            )
        services.remove_asset_files(a)
        s.delete(a)
        s.commit()
    await hub.broadcast({"type": "asset_deleted", "id": aid})
    return {"ok": True}


@router.get("/assets/{aid}/file")
def asset_file(aid: int):
    with session() as s:
        a = s.get(MediaAsset, aid) or not_found()
    return FileResponse(a.path)


@router.get("/assets/{aid}/peaks")
async def asset_peaks(aid: int):
    """Waveform peaks for timeline A-tracks (same format as upload peaks)."""
    with session() as s:
        a = s.get(MediaAsset, aid) or not_found()
    return await services.peaks_cached(Path(a.path), f"asset_{aid}", a.duration)


@router.get("/assets/{aid}/thumb")
def asset_thumb(aid: int):
    with session() as s:
        a = s.get(MediaAsset, aid) or not_found()
    if a.thumb and Path(a.thumb).exists():
        return FileResponse(a.thumb)
    raise HTTPException(404)


class FrameIn(BaseModel):
    t: float


@router.post("/assets/{aid}/frame")
async def asset_frame(aid: int, body: FrameIn):
    """Grab a frame as a new reference image upload."""
    with session() as s:
        a = s.get(MediaAsset, aid) or not_found()
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
        a = s.get(MediaAsset, aid) or not_found()
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
        a = s.get(MediaAsset, aid) or not_found()
    if os.name == "nt":
        subprocess.Popen(["explorer", "/select,", a.path])
    return {"ok": True}



