"""Continue a shot with a fixed motion/audio prefix and the selected DualSampling recipe."""

import math
from typing import Literal

from fastapi import HTTPException
from pydantic import Field

from .. import settings
from .params import FullParams, UIParams, FPS


class ContinuationUI(UIParams):
    source_asset_id: int
    variants: Literal[1] = 1
    context_frames: Literal[5, 22, 39] = Field(default_factory=lambda: settings.defaults()["continuation"]["context_frames"])


class ContinuationFull(FullParams):
    source_path: str
    source_skip: int = Field(ge=0)
    context_frames: int
    added_frames: int
    source_audio: bool
    base_pipeline: str


def frame_plan(duration: float, source_duration: float, context: int = 22) -> tuple[int, int, int]:
    # ffprobe rounds seconds to six decimals: 56/24 becomes 2.333333.
    # Recover that exact frame boundary without accepting a genuinely partial frame.
    available = math.floor(source_duration * FPS + 1e-4)
    if available < 5:
        raise HTTPException(422, "Для продолжения нужен клип хотя бы из 5 кадров")
    context = min(context, max(5, ((available - 5) // 17) * 17 + 5))
    added = max(17, math.ceil(duration * FPS / 17) * 17)
    if context + added > 3600:
        raise HTTPException(422, "Сократите продолжение: вместе с контекстом H3 поддерживает до 3600 кадров")
    return context, added, available - context


def defaults(asset_id: int, project_id: int) -> dict:
    from ..asset_sources import source_asset
    from ..db.models import EngineProfileRow, Generation, session
    asset = source_asset(asset_id, project_id)
    recipe = settings.defaults()["continuation"]
    context, _, _ = frame_plan(recipe["duration"], asset.duration or 0, recipe["context_frames"])
    with session() as s:
        source = s.get(Generation, asset.generation_id) if asset.generation_id else None
    # Keep reference labels stable, including after a post-process of a generated clip.
    visited = set()
    while source and "refs" not in source.ui_params and source.source_asset_id and source.id not in visited:
        visited.add(source.id)
        parent = source_asset(source.source_asset_id, project_id)
        with session() as s:
            source = s.get(Generation, parent.generation_id) if parent.generation_id else None
    saved = source.ui_params if source else {}
    with session() as s:
        profile_id = saved.get("profile_id")
        source_profile = s.get(EngineProfileRow, profile_id) if profile_id else None
    from .params import ASPECT_RATIOS
    ratio = (asset.width or 16) / (asset.height or 9)
    aspect = min(ASPECT_RATIOS, key=lambda key: abs(math.log(ratio / (ASPECT_RATIOS[key][0] / ASPECT_RATIOS[key][1]))))
    return {"asset": asset, "context_frames": context,
            "params": {**UIParams(prompt="").model_dump(),
                       **{key: saved[key] for key in ("refs", "styles", "quality", "look", "light") if key in saved},
                       "duration": recipe["duration"], "aspect": aspect,
                       "profile_id": source_profile.id if source_profile else None,
                       "source_asset_id": asset_id, "context_frames": context}}


def expand(ui: ContinuationUI, project_id: int):
    from ..asset_sources import source_asset
    from ..db.models import Generation
    from ..services import generation_inputs
    from ..jobs.estimator import estimate_seconds
    from . import presets
    asset = source_asset(ui.source_asset_id, project_id)
    if not ui.prompt.strip():
        raise HTTPException(422, "Опишите, как продолжить действие")
    context, added, skip = frame_plan(ui.duration, asset.duration or 0, ui.context_frames)
    row, profile, refs, styles = generation_inputs(ui)
    seed = ui.seed if ui.seed is not None else presets.new_seed()
    target = ui.model_copy(update={"duration": (context + added) / FPS})
    full = presets.expand(target, profile, refs, styles, seed, "ShellMax/continue")
    full = ContinuationFull(**full.model_dump(), source_path=asset.path, source_skip=skip,
                            context_frames=context, added_frames=added,
                            source_audio=bool(asset.has_audio), base_pipeline=profile.pipeline)
    units = presets.work_units(full)
    return Generation(project_id=project_id, kind="continue_video", source_asset_id=asset.id,
                      ui_params=ui.model_dump(), full_params=full.model_dump(), seed=seed,
                      profile_name=row.name, work_units=units, estimate_s=estimate_seconds(units, "continue_video"))
