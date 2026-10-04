"""Source and identity validation; all Head Swap jobs keep their original provenance."""
from pathlib import Path

from fastapi import HTTPException

from .asset_sources import source_asset
from .db.models import Generation, Upload, session
from .workflow import head_swap
from .workflow.fantastic import MediaSource
from .workflow.presets import new_seed


def defaults(asset_id: int, project_id: int) -> dict:
    asset = source_asset(asset_id, project_id)
    missing = head_swap.missing_models()
    return {"asset": asset, "ready": not missing, "missing": missing,
            "frames": max(1, round((asset.duration or 0) * (asset.fps or 24)))}


def expand(ui: head_swap.HeadSwapUI, project_id: int) -> Generation:
    asset = source_asset(ui.source_asset_id, project_id)
    with session() as s:
        identity = s.get(Upload, ui.identity_upload_id)
    if identity is None or identity.kind != "image" or identity.refmod_file:
        raise HTTPException(422, "Выберите фотографию головы для замены")
    if not Path(identity.path).is_file():
        raise HTTPException(422, "Фотография не найдена — загрузите её заново")
    if not asset.width or not asset.height or not asset.fps or not asset.duration:
        raise HTTPException(422, "Параметры клипа не определены — импортируйте видео заново")
    if round(asset.duration * asset.fps) > 3592:
        raise HTTPException(422, "Клип слишком длинный для H3 — выберите фрагмент до 3592 кадров")
    if ui.target is None:
        raise HTTPException(422, "Обведите голову человека, которого нужно заменить, на кадре исходного клипа")
    if ui.target.frame_index >= round(asset.duration * asset.fps):
        raise HTTPException(422, "Кадр для выбора головы находится за пределами клипа")
    missing = head_swap.missing_models()
    if missing:
        raise HTTPException(422, "Head Swap: проверьте установку LoRA (scripts/install_head_swap.py) и обработки края "
                            "(scripts/install_head_swap_composite.py). Не найдены: " + ", ".join(missing))
    seed = ui.seed if ui.seed is not None else new_seed()
    full = head_swap.HeadSwapFull(source_path=asset.path,
        sources=[MediaSource(path=identity.path, kind="picture")],
        models={key: str(path) for key, path in head_swap.model_paths().items()},
        seed=seed, frame_rate=asset.fps, has_audio=asset.has_audio, target=ui.target,
        composite_weights_dir=str(head_swap.composite_dir()))
    return Generation(project_id=project_id, kind="head_swap", source_asset_id=asset.id,
        ui_params=ui.model_dump(), full_params=full.model_dump(), seed=seed,
        profile_name="Head Swap · H3", work_units=asset.width * asset.height / 1e6 * round(asset.duration * asset.fps))
