"""Native ComfyUI frame interpolation (RIFE / FILM) on an existing clip."""

from pathlib import Path

from .. import settings
from .params import InterpolateFullParams, InterpolateRecipe, InterpolateUIParams


def model_presets() -> list[dict]:
    return settings.defaults()["interpolate_model_presets"]


def multiplier_presets() -> list[dict]:
    return settings.defaults()["interpolate_multiplier_presets"]


def _resolve(rel: str) -> str:
    if Path(rel).is_absolute():
        return rel
    return str((settings.legacy_models_dir() / rel).resolve())


def _pick_model(preset: str) -> str:
    d = settings.defaults()["interpolate"]
    if preset == "film":
        path = _resolve(d["film"])
        if Path(path).is_file():
            return path
        for alt in d.get("film_fallbacks", []):
            p = _resolve(alt)
            if Path(p).is_file():
                return p
        return path
    path = _resolve(d["model"])
    if Path(path).is_file():
        return path
    for alt in d.get("model_fallbacks", []):
        p = _resolve(alt)
        if Path(p).is_file():
            return p
    return path


def default_recipe(model_preset: str = "rife") -> InterpolateRecipe:
    d = settings.defaults()["interpolate"]
    return InterpolateRecipe(
        model=_pick_model(model_preset),
        model_preset=model_preset if model_preset in ("rife", "film") else "rife",
        multiplier=int(d.get("multiplier", 2)),
        crf=int(d.get("crf", 17)),
    )


def expand_interpolate(ui: InterpolateUIParams, source_path: str, frame_rate: float,
                       filename_prefix: str) -> InterpolateFullParams:
    preset = ui.model if ui.model in ("rife", "film") else "rife"
    r = default_recipe(preset)
    if ui.multiplier is not None:
        r = r.model_copy(update={"multiplier": max(2, min(16, int(ui.multiplier)))})
    out_fps = frame_rate * r.multiplier
    return InterpolateFullParams(
        source_path=source_path,
        frame_load_cap=0,
        frame_rate=out_fps,
        recipe=r,
        filename_prefix=filename_prefix,
    )


def interpolate_work_units(recipe: InterpolateRecipe, frames: int, width: int, height: int) -> float:
    """Cost ∝ pairs × (multiplier−1) × pixels; FILM weighted heavier than RIFE."""
    pairs = max(1, frames - 1)
    mids = max(1, recipe.multiplier - 1)
    weight = 3.0 if recipe.model_preset == "film" else 1.0
    return max(1.0, pairs * mids * width * height * weight / (1280 * 720))
