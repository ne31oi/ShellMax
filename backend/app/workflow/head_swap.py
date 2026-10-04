"""Parameters and model discovery for the author's aligned-video Head Swap recipe."""
import json
from pathlib import Path

from pydantic import BaseModel, Field, model_validator

from .. import settings
from .fantastic import MediaSource
from .model_paths import resolve_models


class HeadBox(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(gt=0, le=1)
    h: float = Field(gt=0, le=1)

    @model_validator(mode="after")
    def inside_frame(self):
        if self.x + self.w > 1.0001 or self.y + self.h > 1.0001:
            raise ValueError("Рамка головы должна находиться внутри кадра")
        return self


class HeadSwapTarget(BaseModel):
    frame_index: int = Field(ge=0)
    box: HeadBox


class HeadSwapUI(BaseModel):
    source_asset_id: int
    identity_upload_id: str
    seed: int | None = Field(default=None, ge=0, le=0xffffffffffffffff)
    target: HeadSwapTarget | None = None  # old saved jobs predate explicit selection


class HeadSwapFull(BaseModel):
    source_path: str
    sources: list[MediaSource] = Field(min_length=1, max_length=1)
    models: dict[str, str]
    seed: int
    frame_rate: float
    has_audio: bool
    target: HeadSwapTarget | None = None
    composite_weights_dir: str = ""  # old saved jobs resolve the current local compositor
    filename_prefix: str = "ShellMax/head_swap"


def manifest() -> dict:
    return json.loads((settings.CONFIG_DIR / "head-swap-models.json").read_text(encoding="utf-8"))


def composite_manifest() -> dict:
    return json.loads((settings.CONFIG_DIR / "head-swap-composite.json").read_text(encoding="utf-8"))


def composite_dir() -> Path:
    return settings.portable_dir() / "ComfyUI/models" / settings.defaults()["head_swap"]["composite_weights_dir"]


def missing_composite() -> list[str]:
    spec = composite_manifest()
    directory = composite_dir()
    missing = [weight["name"] for weight in spec["weights"]
               if not (directory / weight["name"]).is_file()
               or (directory / weight["name"]).stat().st_size != weight["size"]]
    runtime = settings.ROOT / "comfy/head_swap_runtime"
    for name, source in spec["sources"].items():
        marker = runtime / name / "shellmax_revision.json"
        try:
            installed = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            installed = None
        if installed != source:
            missing.append(name + " (код обработки)")
    return missing


def model_paths() -> dict[str, Path]:
    return resolve_models(settings.defaults()["head_swap"]["models"])


def missing_models() -> list[str]:
    pinned = manifest()
    return [p.name for key, p in model_paths().items()
            if not p.is_file() or (key in pinned and p.stat().st_size != pinned[key]["size"])] + missing_composite()
