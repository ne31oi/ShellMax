"""Download and verify the pinned PDMD v6 adapter into ShellMax's owned data folder."""

import hashlib
import json
import os
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    from huggingface_hub import hf_hub_download

    item = json.loads((ROOT / "config/pdmd-models.json").read_text(encoding="utf-8"))
    recipe = json.loads((ROOT / "config/defaults.json").read_text(encoding="utf-8"))["pdmd"]
    dest = ROOT / recipe["lora"]
    if dest.is_file():
        with dest.open("rb") as stream:
            if dest.stat().st_size == item["size"] and hashlib.file_digest(stream, "sha256").hexdigest() == item["sha256"]:
                print(f"PDMD уже установлен: {dest}", flush=True)
                return
        raise RuntimeError("Установленный PDMD не прошёл проверку SHA-256; проверьте файл перед заменой.")
    print(f"Загрузка PDMD 4 v6 ({item['size'] / 1e9:.2f} ГБ)", flush=True)
    downloaded = Path(hf_hub_download(item["repo"], item["file"], revision=item["revision"],
                                    local_dir=ROOT / "data/downloads/pdmd"))
    with downloaded.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if downloaded.stat().st_size != item["size"] or digest != item["sha256"]:
        raise RuntimeError("PDMD: размер или SHA-256 скачанного файла не совпадает с закреплённой версией.")
    dest.parent.mkdir(parents=True, exist_ok=True)
    downloaded.replace(dest)
    print(f"PDMD установлен: {dest}. Профиль появится после перезапуска ShellMax.", flush=True)


if __name__ == "__main__":
    main()
