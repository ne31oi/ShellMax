"""Install the pinned DLSS5 pack and its matching native runtime in our engine.

Run with comfy/ComfyUI_windows_portable/python_embeded/python.exe -s.
Never touches the user's primary ComfyUI installation or replaces torch/CUDA.
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMMIT = "796ed5927a202ba50b5c929cd08e16b365041162"
RUNTIME_URL = "https://github.com/Merserk/dlss5-visual-enhancer/releases/download/v3.0/DLSS.5.Visual.Enhancer.v3.0.zip"


def main():
    cfg = json.loads((ROOT / "config/comfy.json").read_text(encoding="utf-8"))
    portable = ROOT / cfg["portable_dir"]
    python = portable / "python_embeded/python.exe"
    custom = portable / "ComfyUI/custom_nodes"
    pack = custom / "ComfyUI-DLSS5-Enhancer"
    if not python.is_file():
        raise SystemExit("Сначала установите движок scripts/install_comfy.ps1")
    if not pack.exists():
        subprocess.run(["git", "-c", "safe.directory=*", "clone",
            "https://github.com/Blueforcer/ComfyUI-DLSS5-Enhancer", str(pack)], check=True)
    subprocess.run(["git", "-c", "safe.directory=*", "-C", str(pack), "fetch", "origin", COMMIT], check=True)
    subprocess.run(["git", "-c", "safe.directory=*", "-C", str(pack), "checkout", COMMIT], check=True)
    # These libraries are independent of the pinned CUDA/torch stack.
    subprocess.run([str(python), "-s", "-m", "pip", "install", "numpy", "av", "imageio-ffmpeg"], check=True)
    for name in ("vhs_metadata_loader", "shellmax_dlss5"):
        shutil.copytree(ROOT / "comfy_nodes" / name, custom / name, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("__pycache__"))
    required = ("nvngx.dll", "nvngx_dlss.dll", "nvngx_dlssnr.dll", "dxgi.dll", "renodx-dlss5.addon64")
    if not all((pack / "runtime" / name).is_file() for name in required) or not all(
            (pack / "ffmpeg/bin" / name).is_file() for name in ("ffmpeg.exe", "ffprobe.exe")):
        # Upstream uses the nonexistent tag '3.0'; its actual release is 'v3.0'.
        subprocess.run([str(python), "-s", str(pack / "install_runtime.py"),
                        "--yes", "--url", RUNTIME_URL], check=True)
    print("DLSS5 и VHS Metadata установлены. Перезапустите движок ShellMax.")


if __name__ == "__main__":
    main()
