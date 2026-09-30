"""Classical SwinIR restoration at original size or x2; no text, noise or VAE."""
import json
from pathlib import Path
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel

from .. import settings
from ..asset_sources import source_asset
from ..db.models import Generation


class FidelityUI(BaseModel):
    source_asset_id: int
    scale: Literal[1, 2] = 1


class FidelityFull(BaseModel):
    source_path: str
    model_path: str
    frame_rate: float
    # Zero keeps the old x2 output when replaying persisted pre-x1 jobs.
    width: int = 0
    height: int = 0
    crf: int = 17
    filename_prefix: str = "ShellMax/fidelity_upscale"


def config() -> dict:
    return json.loads((settings.CONFIG_DIR / "fidelity-upscale.json").read_text(encoding="utf-8"))


def model_path() -> Path:
    return settings.ROOT / config()["model"]


def ready() -> bool:
    try:
        return model_path().stat().st_size == config()["size"]
    except OSError:
        return False


def defaults(asset_id: int) -> dict:
    asset = source_asset(asset_id)
    return {"asset": asset, "ready": ready(), "frames": max(1, round((asset.duration or 0) * (asset.fps or 24))),
            "scale": config()["scale"],
            "width": (asset.width or 0) * config()["scale"], "height": (asset.height or 0) * config()["scale"]}


def expand(ui: FidelityUI, project_id: int) -> Generation:
    asset = source_asset(ui.source_asset_id, project_id)
    if not ready():
        raise HTTPException(422, "SwinIR не установлен — запустите scripts/install_fidelity_upscale.py")
    if not asset.width or not asset.height:
        raise HTTPException(422, "Размер исходного видео не определён — импортируйте клип заново")
    full = FidelityFull(source_path=asset.path, model_path=str(model_path()), frame_rate=asset.fps or 24,
                        width=asset.width * ui.scale, height=asset.height * ui.scale,
                        crf=config()["crf"])
    frames = max(1, round((asset.duration or 0) * full.frame_rate))
    units = max(1, asset.width * asset.height * frames * config()["model_scale"] ** 2)
    return Generation(project_id=project_id, kind="fidelity_upscale", source_asset_id=asset.id,
                      ui_params=ui.model_dump(), full_params=full.model_dump(), seed=0,
                      profile_name=f"SwinIR · бережный ×{ui.scale}", work_units=units)
