"""Install pinned Head Swap dependencies into ShellMax's own model folders.

Run with the portable engine's Python. Existing external models remain read-only.
Hugging Face downloads resume on repeat; final files are verified before use.
"""
import hashlib
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("HF_XET_HIGH_PERFORMANCE", "1")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def main():
    from huggingface_hub import hf_hub_download
    from app import settings
    from app.workflow.head_swap import model_paths

    manifest = json.loads((ROOT / "config/head-swap-models.json").read_text(encoding="utf-8"))
    paths = model_paths()
    for key, item in manifest.items():
        existing = paths[key]
        if existing.is_file() and existing.stat().st_size == item["size"]:
            print(f"Уже установлен: {existing.name}", flush=True)
            continue
        dest = settings.portable_dir() / "ComfyUI/models" / settings.defaults()["head_swap"]["models"][key]
        print(f"Загрузка {dest.name} ({item['size'] / 1e9:.2f} ГБ)", flush=True)
        # Managed files live beside the HF cache, never in the external installation.
        cache_dir = ROOT / "comfy/downloads/head-swap"
        downloaded = Path(hf_hub_download(item["repo"], item["file"], revision=item["revision"], local_dir=cache_dir))
        with downloaded.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if downloaded.stat().st_size != item["size"] or digest != item["sha256"]:
            raise RuntimeError(f"Контрольная сумма не совпадает: {dest.name}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        downloaded.replace(dest)
        print(f"Установлен: {dest.name}", flush=True)
    print("Head Swap установлен.", flush=True)


if __name__ == "__main__":
    main()
