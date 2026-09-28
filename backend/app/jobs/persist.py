"""Persist generated media and push live generation updates to the UI."""

import logging
from pathlib import Path

from .. import settings
from ..db.models import Generation, MediaAsset, session
from ..hub import hub
from ..media import library

log = logging.getLogger("shellmax.jobs")


async def register_asset(path: Path, generation_id: int | None, source: str, project_id: int | None = None,
                         name: str | None = None) -> int:
    kind = library.kind_of(path.name) or "video"
    meta = await library.probe(path)
    thumb = await library.thumbnail(path, settings.THUMBS_DIR / f"{path.stem}.jpg", kind)
    with session() as s:
        if project_id is None and generation_id is not None:
            project_id = s.get(Generation, generation_id).project_id
        asset = MediaAsset(project_id=project_id or 1, kind=kind, name=name or path.stem, path=str(path),
                           duration=meta.duration, width=meta.width, height=meta.height, fps=meta.fps,
                           has_audio=meta.has_audio, source=source, generation_id=generation_id,
                           thumb=str(thumb) if thumb else None)
        s.add(asset)
        s.commit()
        s.refresh(asset)
        await hub.broadcast({"type": "asset", "asset": asset.model_dump()})
        return asset.id


async def push_generation(g: Generation, step: dict | None = None) -> None:
    """`step` is live-only (not stored): progress of the node running right now."""
    await hub.broadcast({"type": "generation", "generation": {**g.model_dump(), "step": step}})
    # Keep storyboard plan status in sync when this gen belongs to a plan.
    if (g.info or {}).get("plan_id"):
        try:
            from ..plans import sync_plan_from_generation
            sync_plan_from_generation(g)
        except Exception:  # noqa: BLE001
            log.exception("plan sync failed for gen %s", g.id)
