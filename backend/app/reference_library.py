"""Names and reverse usage for reusable upload references."""

from fastapi import HTTPException
from pydantic import BaseModel, Field

from .db.models import ClipProject, Generation, Project, Upload, select, session

CATEGORIES = {"character", "location", "object", "style", "other"}


def generation_upload_ids(ui: dict) -> list[str]:
    """Reference identities shared by library history and reverse project usage."""
    ids = [ref.get("upload_id") for ref in ui.get("refs") or [] if isinstance(ref, dict)]
    ids.extend(ui.get(key) for key in ("identity_upload_id", "closeup_upload_id", "front_upload_id", "side_upload_id"))
    return [uid for uid in ids if isinstance(uid, str) and uid]


class ReferenceDetails(BaseModel):
    name: str = Field(max_length=100)
    category: str = "other"
    description: str = Field(default="", max_length=1000)


def root_id(upload: Upload) -> str:
    return upload.source_id or upload.id


def update_reference(uid: str, details: ReferenceDetails) -> Upload:
    if details.category not in CATEGORIES:
        raise HTTPException(422, "Выберите тип референса из списка")
    name = details.name.strip()
    if not name:
        raise HTTPException(422, "Укажите имя референса")
    with session() as s:
        upload = s.get(Upload, uid)
        if upload is None:
            raise HTTPException(404, "Референс не найден")
        root = root_id(upload)
        family = [u for u in s.exec(select(Upload)).all() if u.id == root or u.source_id == root]
        for item in family:
            item.name = name
            item.category = details.category
            item.description = details.description.strip()
            s.add(item)
        s.commit()
        return s.get(Upload, root) or upload


def reference_usage(uid: str) -> list[dict]:
    """Active project links, including edits derived from the named upload."""
    with session() as s:
        upload = s.get(Upload, uid)
        if upload is None:
            raise HTTPException(404, "Референс не найден")
        root = root_id(upload)
        family = {u.id for u in s.exec(select(Upload)).all() if u.id == root or u.source_id == root}
        projects = {p.id: p for p in s.exec(select(Project)).all()}
        result: list[dict] = []
        seen: set[tuple] = set()

        def add(project_id: int, kind: str, label: str, key: str) -> None:
            identity = (project_id, kind, key)
            if identity in seen:
                return
            seen.add(identity)
            result.append({"project_id": project_id, "project": projects.get(project_id).name if project_id in projects else "Проект",
                           "kind": kind, "label": label})

        for project in projects.values():
            for track in (project.timeline or {}).get("tracks", []):
                for plan in track.get("plans", []):
                    if any(isinstance(ref, dict) and (ref.get("uploadId") or ref.get("upload_id")) in family for ref in plan.get("refs", [])):
                        add(project.id, "plan", plan.get("name") or "План на монтаже", str(plan.get("id")))

        for clip in s.exec(select(ClipProject)).all():
            doc = clip.document or {}
            if any(ref in family for ref in doc.get("ref_ids", [])):
                add(clip.project_id, "clip", doc.get("name") or "Клип", clip.id)
            for block in doc.get("blocks", []):
                for version in block.get("versions", []):
                    for shot in version.get("shots", []):
                        if any(ref in family for ref in shot.get("ref_ids", [])):
                            add(clip.project_id, "shot", shot.get("name") or "Шот", f"{clip.id}:{block.get('id')}:{shot.get('id')}")

        for generation in s.exec(select(Generation).order_by(Generation.id.desc())).all():
            ui = generation.ui_params or {}
            if any(ref in family for ref in generation_upload_ids(ui)):
                add(generation.project_id, "generation", f"Генерация #{generation.id}", str(generation.id))
        return result
