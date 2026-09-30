"""Parameters for the separate, one-step NVIDIA SoL-Refiner workflow."""
import json
import math
from pathlib import Path

from pydantic import BaseModel, Field

from .. import settings


class SoLRefinerUI(BaseModel):
    source_asset_id: int
    prompt: str = Field(min_length=1, max_length=32000)
    seed: int | None = Field(default=0, ge=0, le=2**63 - 1)


class SoLRefinerFull(BaseModel):
    source_path: str
    prompt: str
    runtime_dir: str
    width: int = Field(gt=0, multiple_of=2)
    height: int = Field(gt=0, multiple_of=2)
    seed: int = 0
    decoder_seed: int = 0
    filename_prefix: str = "ShellMax/sol_refine"


def config() -> dict:
    return json.loads((settings.CONFIG_DIR / "sol-refiner.json").read_text(encoding="utf-8"))


def runtime_dir() -> Path:
    return settings.DATA_DIR / "sol-refiner"


def ready() -> bool:
    marker = runtime_dir() / "installed.json"
    try:
        cfg = config()
        return json.loads(marker.read_text(encoding="utf-8")) == cfg and all(
            (runtime_dir() / "model-int8" / entry["path"]).stat().st_size == entry["size"]
            for entry in cfg["files"].values())
    except (OSError, ValueError):
        return False


def output_size(width: int, height: int) -> tuple[int, int]:
    long_side = config()["long_side"]
    ratio = long_side / max(width, height)
    return max(2, round(width * ratio / 2) * 2), max(2, round(height * ratio / 2) * 2)


def padded_frames(count: int) -> int:
    return 1 + math.ceil((max(1, count) - 1) / 8) * 8
