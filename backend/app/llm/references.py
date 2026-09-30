"""Assistant reference context: H3 labels and viewable photos have separate roles."""

from pathlib import Path
from typing import Protocol, Sequence

from sqlmodel import Session

from .. import settings
from ..db.models import Upload
from ..refmods import creation_context
from .prompt import RefInfo


class ReferenceSelection(Protocol):
    upload_id: str
    with_audio: bool


def load_references(store: Session, refs: Sequence[ReferenceSelection], *,
                    include_images: bool = True) -> tuple[list[RefInfo], list[Path]]:
    uploads = [(ref, store.get(Upload, ref.upload_id)) for ref in refs]
    uploads = sorted([(ref, up) for ref, up in uploads if up is not None], key=lambda pair: bool(pair[1].refmod_file))
    creations = creation_context(store) if any(up.refmod_file and not up.refmod_meta for _, up in uploads) else {}
    infos, images = [], []
    for ref, up in uploads:
        meta = up.refmod_meta or {}
        if up.refmod_file and not meta:
            base = up.refmod_file.removesuffix("_visual").removesuffix("_audio")
            meta = creations.get(base, {})
        candidates = []
        if not up.refmod_file and up.kind == "image":
            candidates = [(Path(up.path), up.orig_name)]
        elif up.refmod_file and up.kind != "audio":
            # Saved source IDs refer to the exact cropped/trimmed uploads used to create this member.
            for uid in meta.get("source_upload_ids", []):
                source = store.get(Upload, uid)
                if source and source.kind == "image" and not source.refmod_file:
                    candidates.append((Path(source.path), source.orig_name))
            if not any(path.is_file() for path, _ in candidates):
                candidates = [(settings.THUMBS_DIR / f"up_{up.id}.jpg", "превью RefMod")]
        available = [(path, name) for path, name in candidates if include_images and path.is_file()]
        infos.append(RefInfo(
            kind=up.kind, name=up.orig_name, with_audio=ref.with_audio and not up.refmod_file,
            refmod=bool(up.refmod_file), image_available=bool(available),
            source_kind="audio" if up.kind == "audio" else meta.get("source_kind", up.kind),
            description=up.description or meta.get("description", ""),
            appearance=meta.get("appearance", ""), voice_description=meta.get("voice_description", ""),
            retained_attributes=meta.get("retained_attributes", ""),
            attached_images=[name for _, name in available],
        ))
        images.extend(path for path, _ in available)
    return infos, images
