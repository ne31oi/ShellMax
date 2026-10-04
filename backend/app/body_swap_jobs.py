"""Validate source ownership, references and the explicit H3 fragment before queueing."""
from pathlib import Path

from fastapi import HTTPException

from .asset_sources import source_asset
from .db.models import Generation, Upload, session
from .workflow import body_swap
from .workflow.fantastic import MediaSource
from .workflow.presets import new_seed


def defaults(asset_id: int, project_id: int) -> dict:
    asset = source_asset(asset_id, project_id)
    missing = body_swap.missing_models()
    variants = {variant: {"ready": not (names := body_swap.missing_models(variant)), "missing": names}
                for variant in body_swap.KINDS}
    frames = body_swap.fragment_frames(asset.duration or 0)
    return {"asset": asset, "ready": not missing, "missing": missing,
            "frames": frames, "max_duration": body_swap.MAX_FRAMES / body_swap.FPS, "variants": variants}


def expand(ui: body_swap.BodySwapUI, project_id: int) -> Generation:
    asset = source_asset(ui.source_asset_id, project_id)
    if not asset.width or not asset.height or not asset.duration or not asset.fps:
        raise HTTPException(422, "Параметры клипа не определены — импортируйте видео заново")
    if ui.end > asset.duration + 1e-6:
        raise HTTPException(422, "Фрагмент выходит за пределы исходного клипа")
    if ui.end - ui.start > body_swap.MAX_FRAMES / 24 + 1e-6:
        raise HTTPException(422, "Body Swap: выберите фрагмент до 7,29 секунды")
    frames = body_swap.fragment_frames(ui.end - ui.start)
    if frames < 5:
        raise HTTPException(422, "Фрагмент слишком короткий — нужно хотя бы 5 кадров при 24 fps")
    sources = []
    with session() as s:
        for uid in (ui.front_upload_id, ui.side_upload_id):
            photo = s.get(Upload, uid)
            if photo is None or photo.kind != "image" or photo.refmod_file:
                raise HTTPException(422, "Выберите фотографии костюма и тела, затем лица и волос")
            if not Path(photo.path).is_file():
                raise HTTPException(422, "Фотография не найдена — загрузите её заново")
            sources.append(MediaSource(path=photo.path, kind="picture"))
    missing = body_swap.missing_models(ui.variant)
    if missing:
        raise HTTPException(422, "Body Swap: установите модели через scripts/install_body_swap.py. Не найдены: " + ", ".join(missing))
    seed = ui.seed if ui.seed is not None else new_seed()
    full = body_swap.BodySwapFull(recipe_version=6, variant=ui.variant, source_path=asset.path, sources=sources,
        models={key: str(path) for key, path in body_swap.model_paths(ui.variant).items()},
        start=ui.start, end=ui.start + frames / 24, frames=frames,
        subject=ui.subject.strip(), prompt=body_swap.replacement_prompt(ui.description, frames / 24, asset.has_audio), seed=seed, has_audio=asset.has_audio,
        composite_weights_dir=str(body_swap.composite_dir()),face_detector_path=str(body_swap.YUNET_PATH))
    return Generation(project_id=project_id, kind=body_swap.KINDS[ui.variant], source_asset_id=asset.id,
        ui_params=ui.model_dump(), full_params=full.model_dump(), seed=seed,
        profile_name=f"Body Swap · {'Singularity' if ui.variant == 'singularity' else 'Ref2VA'} · полный персонаж", work_units=0.7 * frames)


def expand_singularity(ui: body_swap.BodySwapUI, project_id: int) -> Generation:
    return expand(ui.model_copy(update={"variant": "singularity"}), project_id)
