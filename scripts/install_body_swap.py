"""Install the pinned Body Swap weights into the owned engine; external files stay read-only."""
import hashlib
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

os.environ.setdefault("HF_XET_HIGH_PERFORMANCE", "1")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def install_weight(key, item, existing):
    from huggingface_hub import hf_hub_download
    from app import settings
    if existing.is_file() and existing.stat().st_size == item["size"]:
        print(f"Уже установлен: {existing.name}", flush=True)
        return
    dest = settings.portable_dir() / "ComfyUI/models" / settings.defaults()["body_swap"]["models"][key]
    print(f"Загрузка {dest.name} ({item['size'] / 1e9:.2f} ГБ)", flush=True)
    downloaded = Path(hf_hub_download(item["repo"], item["file"], revision=item["revision"],
        local_dir=ROOT / "comfy/downloads/body-swap-http"))
    with downloaded.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if downloaded.stat().st_size != item["size"] or digest != item["sha256"]:
        raise RuntimeError(f"Контрольная сумма не совпадает: {dest.name}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    downloaded.replace(dest)
    print(f"Установлен: {dest.name}", flush=True)


def main():
    from app import settings
    from app.workflow.body_swap import manifest, model_paths

    paths = model_paths()
    # Separate files can download concurrently; each destination is published only after SHA-256 verification.
    with ThreadPoolExecutor(max_workers=2) as pool:
        tasks = [pool.submit(install_weight, key, item, paths[key]) for key, item in manifest().items()]
        for task in tasks:
            task.result()
    # ControlNet Aux resolves its two pose files under repo-named subdirectories.
    config = settings.portable_dir() / "ComfyUI/custom_nodes/comfyui-controlnet-aux/config.yaml"
    config.parent.mkdir(parents=True, exist_ok=True)
    folder = (settings.portable_dir() / "ComfyUI/models/annotators").as_posix()
    config.write_text(f'annotator_ckpts_path: "{folder}"\nUSE_SYMLINKS: False\ncustom_temp_path: null\n'
                     'EP_list: [CUDAExecutionProvider, CPUExecutionProvider]\n', encoding="utf-8")
    # Both swap modes share the same verified temporal background runtime.
    sys.path.insert(0, str(ROOT / "scripts"))
    from install_head_swap_composite import install
    install()
    from app.workflow.face import _yunet_path
    if _yunet_path() is None:
        raise RuntimeError("Не установлен YuNet для привязки размера головы к исходнику")
    print("Body Swap установлен. Перезапустите движок в Настройках → Система.", flush=True)


if __name__ == "__main__":
    main()
