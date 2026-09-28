"""Export the normalized timeline and register the resulting media."""

import uuid
from fastapi import HTTPException
from sqlmodel import select
from .. import settings
from ..db.models import MediaAsset, Project, session
from ..timeline_schema import parse_timeline
from .timeline_render import export_timeline


async def export_project_timeline(project_id: int, timeline_raw: dict, *, check=None, progress=None) -> MediaAsset:
    from ..jobs.persist import register_asset

    doc = parse_timeline(timeline_raw)
    with session() as s:
        project = s.get(Project, project_id)
        if project is None:
            raise HTTPException(404, "Проект не найден")
        rows = s.exec(select(MediaAsset).where(MediaAsset.project_id == project_id)).all()
        assets_by_id = {a.id: a for a in rows}

    dest = settings.MEDIA_DIR / f"montage_{uuid.uuid4().hex[:8]}.mp4"
    await export_timeline(doc, assets_by_id, dest, project.width, project.height, project.fps, check=check, progress=progress)
    aid = await register_asset(dest, generation_id=None, source="exported", project_id=project_id, name="Монтаж")
    with session() as s:
        asset = s.get(MediaAsset, aid)
        assert asset is not None
        return asset
