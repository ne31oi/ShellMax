"""Resolve model paths relative to the user's legacy models dir."""

from pathlib import Path

from .. import settings


def resolve_model(rel: str) -> str:
    if Path(rel).is_absolute():
        return rel
    return str((settings.legacy_models_dir() / rel).resolve())
