"""DLSS5 video restoration, queued through the shared asset-job registry."""
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field

from .. import settings
from ..asset_sources import source_asset
from ..db.models import Generation

Mode = Literal["1x (DLAA / native)", "1.5x (Quality)", "1.724x (Balanced)", "2x (Performance)", "3x (Ultra Performance)"]
Style = Literal["Default", "Natural", "Cinematic"]


class DLSS5UI(BaseModel):
    source_asset_id: int
    mode: Mode = "1x (DLAA / native)"
    style: Style = "Default"
    intensity: float = Field(default=1.0, ge=0, le=1)


class DLSS5Full(BaseModel):
    source_path: str
    controls: dict
    codec: str = "H.264"
    container: str = "MP4"
    quality: str = "Good"
    filename_prefix: str = "ShellMax/dlss5"
    max_frames: int = 0


def readiness() -> tuple[bool, str]:
    pack = settings.portable_dir() / "ComfyUI/custom_nodes/ComfyUI-DLSS5-Enhancer"
    required = ("nvngx.dll", "nvngx_dlss.dll", "nvngx_dlssnr.dll", "dxgi.dll", "renodx-dlss5.addon64")
    if not all((pack / "runtime" / name).is_file() for name in required):
        return False, "Runtime DLSS5 не установлен — запустите scripts/install_dlss5.py через Python движка"
    if not all((pack / "ffmpeg/bin" / name).is_file() for name in ("ffmpeg.exe", "ffprobe.exe")):
        return False, "Не найдены ffmpeg/ffprobe DLSS5 — повторите scripts/install_dlss5.py"
    return True, ""


def defaults(asset_id: int) -> dict:
    asset = source_asset(asset_id)
    ready, detail = readiness()
    return {"asset": asset, "ready": ready, "detail": detail,
            "frames": max(1, round((asset.duration or 0) * (asset.fps or 24))),
            **settings.defaults()["dlss5"]["ui"]}


def expand(ui: DLSS5UI, project_id: int) -> Generation:
    asset = source_asset(ui.source_asset_id, project_id)
    ready, detail = readiness()
    if not ready:
        raise HTTPException(422, detail)
    factor = float(ui.mode.split("x", 1)[0])
    if max(asset.width or 0, asset.height or 0) * factor > 7680 or min(asset.width or 0, asset.height or 0) * factor > 4320:
        raise HTTPException(422, "Размер результата превышает предел DLSS5 — выберите меньший масштаб")
    d = settings.defaults()["dlss5"]
    full = DLSS5Full(source_path=asset.path, controls={**d["controls"], "upscaling_mode": ui.mode,
        "nr_style": ui.style, "nr_intensity": ui.intensity}, **d["encoding"])
    return Generation(project_id=project_id, kind="dlss5", source_asset_id=asset.id,
        ui_params=ui.model_dump(), full_params=full.model_dump(), seed=0, profile_name="DLSS5",
        work_units=max(1, (asset.width or 1) * (asset.height or 1) * (asset.duration or 1) * (asset.fps or 24) * factor ** 2))
