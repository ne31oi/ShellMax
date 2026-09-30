"""Validate local video sources before a post-process job is queued."""
from pathlib import Path

from fastapi import HTTPException

from .db.models import MediaAsset, session


def source_asset(asset_id: int, project_id: int | None = None) -> MediaAsset:
    with session() as s:
        asset = s.get(MediaAsset, asset_id)
    if asset is None or asset.kind != "video" or (project_id is not None and asset.project_id != project_id):
        raise HTTPException(404, "Клип не найден")
    if not Path(asset.path).is_file():
        raise HTTPException(422, "Файл клипа не найден — выберите другой клип")
    return asset
