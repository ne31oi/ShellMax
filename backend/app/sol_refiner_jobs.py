"""Validate source clips and preserve their provenance for SoL comparisons."""
from fastapi import HTTPException

from .db.models import Generation, MediaAsset, session
from .workflow import sol_refiner
from .workflow.presets import new_seed
from .asset_sources import source_asset


def inherited_prompt(asset: MediaAsset) -> str:
    """Reuse a refiner caption, never H3 instructions whose image refs are absent."""
    visited = set()
    with session() as s:
        while asset.generation_id and asset.generation_id not in visited:
            visited.add(asset.generation_id)
            gen = s.get(Generation, asset.generation_id)
            if gen is None:
                break
            prompt = (gen.ui_params or {}).get("prompt", "").strip()
            if prompt and gen.kind == "sol_refine":
                return prompt
            asset = s.get(MediaAsset, gen.source_asset_id) if gen.source_asset_id else None
            if asset is None:
                break
    return ""


def defaults(asset_id: int) -> dict:
    asset = source_asset(asset_id)
    width, height = sol_refiner.output_size(asset.width or 1920, asset.height or 1080)
    return {"asset": asset, "prompt": inherited_prompt(asset), "ready": sol_refiner.ready(),
            "frames": max(1, round((asset.duration or 0) * (asset.fps or 24))),
            "width": width, "height": height}


def expand(ui: sol_refiner.SoLRefinerUI, project_id: int) -> Generation:
    asset = source_asset(ui.source_asset_id, project_id)
    if not ui.prompt.strip():
        raise HTTPException(422, "Добавьте описание клипа")
    if not sol_refiner.ready():
        raise HTTPException(422, "SoL-Refiner ещё не установлен. Запустите scripts/install_sol_refiner.py Python движка.")
    seed = ui.seed if ui.seed is not None else new_seed()
    width, height = sol_refiner.output_size(asset.width or 1920, asset.height or 1080)
    full = sol_refiner.SoLRefinerFull(source_path=asset.path, prompt=ui.prompt.strip(),
                                    runtime_dir=str(sol_refiner.runtime_dir()), width=width, height=height,
                                    seed=seed, decoder_seed=sol_refiner.config()["decoder_seed"])
    units = width * height / 1e6 * max(1, round((asset.duration or 0) * (asset.fps or 24)))
    return Generation(project_id=project_id, kind="sol_refine", source_asset_id=asset.id,
                      ui_params=ui.model_dump(), full_params=full.model_dump(), seed=seed,
                      profile_name="SoL-Refiner · H3", work_units=units)
