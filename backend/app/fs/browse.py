"""Server-side file browsing so the UI can pick absolute model/LoRA paths
(a browser file dialog never reveals the real path)."""

import os
import string
from pathlib import Path

from .. import settings
from ..workflow.params import clean_path

MODEL_EXT = {".safetensors", ".sft", ".ckpt", ".pt", ".pth", ".bin"}

# model categories in a ComfyUI models dir -> engine profile fields they feed
CATEGORIES = {
    "diffusion_models": "unet",
    "text_encoders": "text_encoder",
    "vae": "vae",
    "loras": "lora",
    "latent_upscale_models": "upscaler",
}


def drives() -> list[str]:
    return [f"{d}:\\" for d in string.ascii_uppercase if os.path.exists(f"{d}:\\")]


def list_dir(raw: str | None) -> dict:
    """Directories + model files of a folder. Empty path -> drive list."""
    if not raw:
        return {"path": "", "parent": None, "dirs": drives(), "files": []}
    path = Path(clean_path(raw))
    if path.is_file():
        path = path.parent
    if not path.is_dir():
        raise FileNotFoundError(str(path))
    dirs, files = [], []
    try:
        entries = sorted(os.scandir(path), key=lambda e: e.name.lower())
    except PermissionError:
        entries = []
    for e in entries:
        if e.name.startswith((".", "$")):
            continue
        try:
            if e.is_dir():
                dirs.append(e.name)
            elif Path(e.name).suffix.lower() in MODEL_EXT:
                files.append({"name": e.name, "size": e.stat().st_size})
        except OSError:
            continue
    parent = str(path.parent) if path.parent != path else ""
    return {"path": str(path), "parent": parent, "dirs": dirs, "files": files}


def check(raw: str) -> dict:
    path = clean_path(raw)
    p = Path(path)
    ok = bool(path) and p.is_absolute() and p.is_file() and p.suffix.lower() in MODEL_EXT
    return {"path": path, "exists": ok, "size": p.stat().st_size if ok else None, "name": p.name}


def scan_models() -> dict[str, list[dict]]:
    """Model files in the shared models dir, grouped by category (for path autocomplete)."""
    root = settings.legacy_models_dir()
    out: dict[str, list[dict]] = {}
    for folder, field in CATEGORIES.items():
        base = root / folder
        items = []
        if base.is_dir():
            for f in base.rglob("*"):
                if f.suffix.lower() in MODEL_EXT and ".cache" not in f.parts and f.is_file():
                    items.append({"path": str(f), "name": f.stem, "rel": str(f.relative_to(base)),
                                  "size": f.stat().st_size})
        out[field] = sorted(items, key=lambda i: i["rel"].lower())
    return out
