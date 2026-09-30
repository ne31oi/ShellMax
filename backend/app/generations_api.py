"""Generations and post-process jobs (face / enhance / interpolate)."""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import services
from .api_common import not_found, state
from .db.models import Generation, MediaAsset, Upload, select, session
from .hub import hub
from .jobs.estimator import estimate as estimate_time
from .jobs.persist import push_generation
from .workflow import enhance, face, interpolate
from .workflow.params import EnhanceUIParams, FaceUIParams, InterpolateUIParams, UIParams
from .workflow.sol_refiner import SoLRefinerUI
from .workflow.fidelity_upscale import FidelityUI

router = APIRouter()


@router.get("/fidelity-upscale/defaults")
def fidelity_defaults(asset_id: int):
    from .workflow.fidelity_upscale import defaults
    return defaults(asset_id)


@router.post("/fidelity-upscale")
async def create_fidelity_job(ui: FidelityUI, request: Request, project_id: int = 1):
    g = services.create_asset_job("fidelity_upscale", ui, project_id)
    await push_generation(g)
    state(request).jobs.enqueue(g.id)
    return g


@router.get("/sol-refiner/defaults")
def sol_refiner_defaults(asset_id: int):
    from .sol_refiner_jobs import defaults
    return defaults(asset_id)


@router.post("/sol-refiner")
async def create_sol_refiner(ui: SoLRefinerUI, request: Request, project_id: int = 1):
    g = services.create_asset_job("sol_refine", ui, project_id)
    await push_generation(g)
    state(request).jobs.enqueue(g.id)
    return g

# ---------------------------------------------------------------- generations
@router.get("/generations")
def list_generations(project_id: int = 1, limit: int = 200):
    with session() as s:
        return s.exec(select(Generation).where(Generation.project_id == project_id)
                      .order_by(Generation.id.desc()).limit(limit)).all()


@router.post("/generations")
async def create_generation(ui: UIParams, request: Request, project_id: int = 1):
    gens = services.create_generations(ui, project_id)
    jobs = state(request).jobs
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
        g = s.get(Generation, gid) or not_found()
    created = services.recreate_generations(g, same_seed=body.same_seed, variants=body.variants)
    jobs = state(request).jobs
    for row in created:
        await push_generation(row)
        jobs.enqueue(row.id)
    return created


# ---------------------------------------------------------------- face refine (MiniMax_H3_FaceRefine_Best)
@router.get("/face/defaults")
def face_defaults(asset_id: int):
    return services.face_defaults(asset_id)


class FaceDetectIn(BaseModel):
    upload_id: str


@router.get("/face/estimate")
def face_estimate(asset_id: int):
    with session() as s:
        asset = s.get(MediaAsset, asset_id) or not_found()
    _, _, frames, _ = face.source_frames(asset.duration, asset.fps)
    _, profile = services.get_profile(None)
    return estimate_time(face.face_work_units(profile.face, frames), "face")


@router.post("/face/detect")
def face_detect(body: FaceDetectIn):
    """Close-up crop around the largest face of a reference image (None found -> portrait framing)."""
    with session() as s:
        up = s.get(Upload, body.upload_id) or not_found()
    box = face.detect_face_box(up.path)
    return {"found": box is not None, "crop": face.closeup_crop_for(box)}


@router.post("/face")
async def create_face(ui: FaceUIParams, request: Request, project_id: int = 1):
    g = services.create_face_refine(ui, project_id)
    await push_generation(g)
    state(request).jobs.enqueue(g.id)
    return g


# ---------------------------------------------------------------- enhance (SeedVR2 upscale / restore)
@router.get("/enhance/defaults")
def enhance_defaults(asset_id: int):
    return services.enhance_defaults(asset_id)


@router.get("/enhance/estimate")
def enhance_estimate(asset_id: int, scale: float = 1.0):
    with session() as s:
        asset = s.get(MediaAsset, asset_id) or not_found()
    frames = max(1, round((asset.duration or 1) * (asset.fps or 24)))
    recipe = enhance.default_recipe().model_copy(update={"scale": scale})
    units = enhance.enhance_work_units(recipe, frames, int(asset.width or 1280), int(asset.height or 720))
    return estimate_time(units, "enhance")


@router.post("/enhance")
async def create_enhance_job(ui: EnhanceUIParams, request: Request, project_id: int = 1):
    g = services.create_enhance(ui, project_id)
    await push_generation(g)
    state(request).jobs.enqueue(g.id)
    return g


# ---------------------------------------------------------------- interpolate (native RIFE / FILM)
@router.get("/interpolate/defaults")
def interpolate_defaults(asset_id: int):
    return services.interpolate_defaults(asset_id)


@router.get("/interpolate/estimate")
def interpolate_estimate(asset_id: int, multiplier: int = 2, model: str = "rife"):
    with session() as s:
        asset = s.get(MediaAsset, asset_id) or not_found()
    frames = max(1, round((asset.duration or 1) * (asset.fps or 24)))
    recipe = interpolate.default_recipe(model if model in ("rife", "film") else "rife")
    recipe = recipe.model_copy(update={"multiplier": max(2, min(16, multiplier))})
    units = interpolate.interpolate_work_units(
        recipe, frames, int(asset.width or 1280), int(asset.height or 720))
    return estimate_time(units, "interpolate")


@router.post("/interpolate")
async def create_interpolate_job(ui: InterpolateUIParams, request: Request, project_id: int = 1):
    g = services.create_interpolate(ui, project_id)
    await push_generation(g)
    state(request).jobs.enqueue(g.id)
    return g


@router.post("/generations/{gid}/cancel")
async def cancel_generation(gid: int, request: Request):
    await state(request).jobs.cancel(gid)
    return {"ok": True}


@router.post("/generations/cancel-all")
async def cancel_all_generations(request: Request):
    ids = await state(request).jobs.cancel_all()
    return {"ok": True, "cancelled": ids}


@router.delete("/generations/{gid}")
async def delete_generation(gid: int, request: Request):
    jobs = state(request).jobs
    if jobs.running and jobs.running.gen_id == gid:
        raise HTTPException(409, "Генерация ещё идёт — сначала остановите её")
    with session() as s:
        root = s.get(Generation, gid) or not_found()
        # Cascade: face/enhance that refine this gen's draft/output (and their descendants).
        to_delete: list[Generation] = [root]
        asset_ids: set[int] = {aid for aid in (root.draft_asset_id, root.output_asset_id) if aid}
        changed = True
        while changed:
            changed = False
            for g in s.exec(select(Generation)).all():
                if g.id in {x.id for x in to_delete}:
                    continue
                if g.source_asset_id and g.source_asset_id in asset_ids:
                    if jobs.running and jobs.running.gen_id == g.id:
                        raise HTTPException(409, "Связанная задача ещё идёт — сначала остановите её")
                    to_delete.append(g)
                    for aid in (g.draft_asset_id, g.output_asset_id):
                        if aid:
                            asset_ids.add(aid)
                    changed = True
        deleted_ids: list[int] = []
        for g in to_delete:
            for aid in (g.draft_asset_id, g.output_asset_id):
                asset = s.get(MediaAsset, aid) if aid else None
                if asset:
                    services.remove_asset_files(asset)
                    s.delete(asset)
            deleted_ids.append(g.id)
            s.delete(g)
        s.commit()
    for did in deleted_ids:
        await hub.broadcast({"type": "generation_deleted", "id": did})
    return {"ok": True, "deleted_ids": deleted_ids}
