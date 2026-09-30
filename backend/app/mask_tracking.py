"""SAM artifacts and model discovery; the shared model installation is read-only."""

import re
from pathlib import Path

from fastapi import HTTPException

from . import settings
from .db.models import Generation, MediaAsset, session
from .workflow.fantastic import AutoMaskLayer, MaskTrackFull, MaskTrackUI, MediaSource


def model_path() -> Path | None:
    roots = [settings.portable_dir() / "ComfyUI" / "models", settings.legacy_models_dir()]
    for name in ("sam3.1_multiplex_fp16.safetensors", "sam3.pt", "sam3.safetensors"):
        for root in roots:
            for folder in ("checkpoints", "sam3"):
                path = root / folder / name
                if path.is_file():
                    return path.resolve()
    return None


def resolve_mask(name: str, extension: str = "safetensors") -> Path:
    if not re.fullmatch(r"minimax_h3/masks/[\w-]+\." + extension + r" \[input\]", name, flags=re.ASCII):
        raise HTTPException(422, "Недопустимый файл маски")
    root = settings.portable_dir() / "ComfyUI" / "input"
    path = (root / name.removesuffix(" [input]")).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise HTTPException(422, "Маска не найдена — повторите выделение объекта")
    return path


def expand_mask_track(ui: MaskTrackUI, project_id: int) -> Generation:
    with session() as s:
        asset = s.get(MediaAsset, ui.source_asset_id)
    if not asset or asset.kind != "video" or not Path(asset.path).is_file():
        raise HTTPException(404, "Исходный клип не найден")
    if ui.end > (asset.duration or 0) + 0.001:
        raise HTTPException(422, "Фрагмент выходит за границы клипа")
    model = model_path()
    if not model:
        raise HTTPException(422, "Не найдена модель SAM — поместите SAM 3 или SAM 3.1 в папку checkpoints или sam3 движка")
    full = MaskTrackFull(sources=[MediaSource(path=asset.path, kind="video")], model_path=str(model),
                         start=ui.start, end=ui.end, text=ui.text.strip(), points=ui.points)
    return Generation(project_id=project_id, kind="mask_track", source_asset_id=asset.id,
                      ui_params=ui.model_dump(), full_params=full.model_dump(), seed=0,
                      profile_name=model.name, work_units=ui.end - ui.start)


def collect_output(g: Generation, output: dict) -> dict | None:
    reports = output.get("mmh3_mask")
    if not isinstance(reports, list) or not reports:
        return None
    info = reports[0]
    resolve_mask(info["file"])
    resolve_mask(info["sprite"]["file"], "png")
    return {"mask": info}


def validate_auto_layers(asset_id: int, layers) -> None:
    with session() as s:
        for layer in layers:
            if not isinstance(layer, AutoMaskLayer):
                continue
            job = s.get(Generation, layer.track_generation_id)
            if not job or job.kind != "mask_track" or job.status != "done" or job.source_asset_id != asset_id or (job.info or {}).get("mask", {}).get("file") != layer.result:
                raise HTTPException(422, "Эта маска относится к другому клипу — выполните выделение заново")
            resolve_mask(layer.result)
