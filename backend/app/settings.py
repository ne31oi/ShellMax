"""Project paths and static configuration (config/*.json)."""

import json
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFIG_DIR = ROOT / "config"
DATA_DIR = ROOT / "data"
MEDIA_DIR = DATA_DIR / "media"
UPLOADS_DIR = DATA_DIR / "uploads"
THUMBS_DIR = DATA_DIR / "thumbs"
DB_PATH = DATA_DIR / "shellmax.sqlite"
FRONTEND_DIST = ROOT / "frontend" / "dist"

API_HOST = "127.0.0.1"
API_PORT = 8710


def ensure_dirs() -> None:
    for d in (DATA_DIR, MEDIA_DIR, UPLOADS_DIR, THUMBS_DIR):
        d.mkdir(parents=True, exist_ok=True)


@lru_cache
def comfy_config() -> dict:
    return json.loads((CONFIG_DIR / "comfy.json").read_text(encoding="utf-8"))


@lru_cache
def defaults() -> dict:
    return json.loads((CONFIG_DIR / "defaults.json").read_text(encoding="utf-8"))


def portable_dir() -> Path:
    return ROOT / comfy_config()["portable_dir"]


def comfy_url() -> str:
    cfg = comfy_config()
    return f"http://{cfg['host']}:{cfg['port']}"


def legacy_models_dir() -> Path:
    return Path(comfy_config()["legacy_models_dir"])
