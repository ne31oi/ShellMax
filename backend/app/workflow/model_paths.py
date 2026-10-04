"""Resolve configured weights without copying the user's external models."""
from pathlib import Path

from .. import settings


def resolve_models(models: dict[str, str]) -> dict[str, Path]:
    roots = (settings.portable_dir() / "ComfyUI/models", settings.legacy_models_dir())
    result = {}
    for key, relative in models.items():
        candidates = [root / relative for root in roots]
        path = next((p for p in candidates if p.is_file()), None)
        if path is None:
            path = next((p for root in roots for p in root.rglob(Path(relative).name) if p.is_file()), None)
        result[key] = path or candidates[0]
    return result
