"""Download pinned compact H3 SoL-Refiner. Run with portable ComfyUI Python.

Existing partial downloads resume. Engine dependencies are not modified.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    from huggingface_hub import snapshot_download
    config = json.loads((ROOT / "config/sol-refiner.json").read_text(encoding="utf-8"))
    runtime = ROOT / "data/sol-refiner"
    runtime.mkdir(parents=True, exist_ok=True)
    print("Загрузка SoL-Refiner INT8 ConvRot (41,4 ГБ). Повторный запуск продолжит загрузку.", flush=True)
    snapshot_download(config["model"], revision=config["model_revision"], local_dir=runtime / "model-int8",
                      allow_patterns=[entry["path"] for entry in config["files"].values()], max_workers=2)
    for entry in config["files"].values():
        if (runtime / "model-int8" / entry["path"]).stat().st_size != entry["size"]:
            raise RuntimeError("Размер файла SoL-Refiner не совпадает с закреплённой версией")
    (runtime / "installed.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
    print("SoL-Refiner установлен.", flush=True)


if __name__ == "__main__":
    main()
