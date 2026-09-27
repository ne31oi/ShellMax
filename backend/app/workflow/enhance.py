"""SeedVR2 post-enhance (upscale / restore) on an existing clip.

Recipe defaults match ComfyUI's built-in blueprint
«Upscale Video (SeedVR2 3B Int8)»; ShellMax flattens the subgraph and saves via VHS.
"""

from pathlib import Path

from .. import settings
from .params import EnhanceFullParams, EnhanceRecipe, EnhanceUIParams

WORKFLOW_SEED = 42  # fixed like FaceRefine / blueprint — random seed changes the restore look


def scale_presets() -> list[dict]:
    return settings.defaults()["enhance_scale_presets"]


def color_presets() -> list[dict]:
    return settings.defaults()["enhance_color_presets"]


def _resolve(rel: str) -> str:
    if Path(rel).is_absolute():
        return rel
    return str((settings.legacy_models_dir() / rel).resolve())


def default_recipe() -> EnhanceRecipe:
    """Paths from config/defaults.json, with fallbacks when preferred files are absent."""
    d = settings.defaults()["enhance"]
    unet = _resolve(d["unet"])
    if not Path(unet).is_file():
        for alt in d.get("unet_fallbacks", []):
            p = _resolve(alt)
            if Path(p).is_file():
                unet = p
                break
    vae = _resolve(d["vae"])
    if not Path(vae).is_file():
        for alt in d.get("vae_fallbacks", []):
            p = _resolve(alt)
            if Path(p).is_file():
                vae = p
                break
    return EnhanceRecipe(
        unet=unet,
        vae=vae,
        scale=float(d.get("scale", 2.0)),
        steps=int(d.get("steps", 1)),
        cfg=float(d.get("cfg", 1.0)),
        sampler=str(d.get("sampler", "euler")),
        scheduler=str(d.get("scheduler", "simple")),
        denoise=float(d.get("denoise", 1.0)),
        color_correction=str(d.get("color_correction", "lab")),
        tile_size=int(d.get("tile_size", 512)),
        overlap=int(d.get("overlap", 128)),
        temporal_size=int(d.get("temporal_size", 64)),
        temporal_overlap=int(d.get("temporal_overlap", 8)),
        chunk_overlap=int(d.get("chunk_overlap", 0)),
        crf=int(d.get("crf", 17)),
    )


def expand_enhance(ui: EnhanceUIParams, source_path: str, force_rate: float, frame_rate: float,
                   seed: int, filename_prefix: str) -> EnhanceFullParams:
    r = default_recipe()
    if ui.scale is not None:
        r = r.model_copy(update={"scale": ui.scale})
    if ui.color_correction is not None:
        r = r.model_copy(update={"color_correction": ui.color_correction})
    return EnhanceFullParams(
        source_path=source_path,
        force_rate=force_rate,
        frame_load_cap=0,  # whole clip
        frame_rate=frame_rate or 24.0,
        seed=seed,
        recipe=r,
        filename_prefix=filename_prefix,
    )


def enhance_work_units(recipe: EnhanceRecipe, frames: int, width: int, height: int) -> float:
    """Rough cost ∝ output pixels × frames (SeedVR is 1-step but heavy)."""
    scale = max(recipe.scale, 0.5)
    return max(1.0, frames * width * height * scale * scale)
