"""Thin routes for Fantastic H3 integration."""

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, FileResponse
from pydantic import BaseModel

from . import services, refmods, mask_tracking
from .api_common import state
from .db.models import Generation, MediaAsset, session
from .jobs.persist import push_generation
from .workflow.fantastic import MaskEditUI, RefModCreateUI, MaskTrackUI

router = APIRouter()


@router.get("/refmods")
async def refmod_library():
    return await refmods.catalogue()


@router.get("/refmods/limits")
def refmod_limits():
    return refmods.limits()


@router.get("/refmods/edit")
async def refmod_edit_defaults(file: str):
    return await refmods.revision_defaults(file)


@router.delete("/refmods")
async def delete_refmod(file: str):
    return await refmods.delete_member(file)


@router.get("/refmods/preview")
async def refmod_preview(name: str):
    try:
        return Response(await refmods.preview(name), media_type="image/png")
    except httpx.HTTPError as exc:
        raise HTTPException(404, "Превью RefMod не найдено") from exc


class UseRefMod(BaseModel):
    file: str


@router.post("/refmods/use")
async def use_refmod(body: UseRefMod):
    return await refmods.use_member(body.file)


async def _enqueue(kind, ui, request, project_id):
    g = services.create_asset_job(kind, ui, project_id)
    await push_generation(g)
    state(request).jobs.enqueue(g.id)
    return g


@router.post("/refmods/create")
async def create_refmod(ui: RefModCreateUI, request: Request, project_id: int = 1):
    return await _enqueue("refmod_create", ui, request, project_id)


@router.post("/refmods/edit")
async def edit_refmod(ui: RefModCreateUI, request: Request, project_id: int = 1):
    if not ui.source_refmod_file:
        raise HTTPException(422, "Выберите RefMod для редактирования")
    return await _enqueue("refmod_create", ui, request, project_id)


@router.get("/mask-edit/defaults")
def mask_defaults(asset_id: int):
    with session() as s:
        asset = s.get(MediaAsset, asset_id)
        gen = s.get(Generation, asset.generation_id) if asset and asset.generation_id else None
    if asset is None or asset.kind != "video":
        raise HTTPException(404, "Клип не найден")
    return {"asset": asset, "prompt": (gen.ui_params or {}).get("prompt", "") if gen else "",
            "strength": 0.8, "grow": 16, "feather": 12,
            "quality": "standard"}


@router.post("/mask-edit")
async def mask_edit(ui: MaskEditUI, request: Request, project_id: int = 1):
    return await _enqueue("mask_edit", ui, request, project_id)


@router.get("/mask-track/status")
def mask_track_status():
    model = mask_tracking.model_path()
    return {"available": model is not None, "model": model.name if model else None}


@router.post("/mask-track")
async def mask_track(ui: MaskTrackUI, request: Request, project_id: int = 1):
    return await _enqueue("mask_track", ui, request, project_id)


@router.get("/mask-track/{gid}/sprite")
def mask_track_sprite(gid: int):
    with session() as s:
        job = s.get(Generation, gid)
    mask = (job.info or {}).get("mask") if job and job.kind == "mask_track" else None
    if not mask:
        raise HTTPException(404, "Превью маски пока не готово")
    return FileResponse(mask_tracking.resolve_mask(mask["sprite"]["file"], "png"), media_type="image/png")
