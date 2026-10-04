"""Install the approved temporal compositor without changing the H3/PyTorch stack."""
import hashlib
import io
import json
from pathlib import Path
import urllib.request
import zipfile
import subprocess

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "comfy/head_swap_runtime"
WEIGHTS = ROOT / "comfy/ComfyUI_windows_portable/ComfyUI/models/head_swap_composite"


def response(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "ShellMax-head-swap"}), timeout=120)


def install():
    manifest = json.loads((ROOT / "config/head-swap-composite.json").read_text())
    RUNTIME.mkdir(parents=True, exist_ok=True)
    WEIGHTS.mkdir(parents=True, exist_ok=True)
    for name, spec in manifest["sources"].items():
        destination = RUNTIME / name
        marker = destination / "shellmax_revision.json"
        if marker.exists() and json.loads(marker.read_text()) == spec:
            continue
        print(f"Source {name}: {spec['commit']}", flush=True)
        with response(f"https://codeload.github.com/{spec['repo']}/zip/{spec['commit']}") as stream:
            archive = zipfile.ZipFile(io.BytesIO(stream.read()))
        for member in archive.infolist():
            parts = Path(member.filename).parts[1:]
            if not parts or parts[0] in {"assets", "inputs", ".github"} or member.is_dir():
                continue
            target = destination.joinpath(*parts).resolve()
            if not target.is_relative_to(destination.resolve()):
                raise ValueError("Unsafe archive path")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(member))
        marker.write_text(json.dumps(spec))
    hashes = {}
    for spec in manifest["weights"]:
        target = WEIGHTS / spec["name"]
        if not target.exists() or target.stat().st_size != spec["size"]:
            print(f"Download {target.name}: {spec['size'] / 1e6:.1f} MB", flush=True)
            partial = target.with_suffix(target.suffix + ".partial")
            with response(spec["url"]) as stream, partial.open("wb") as out:
                while chunk := stream.read(1024 * 1024):
                    out.write(chunk)
            if partial.stat().st_size != spec["size"]:
                raise ValueError(f"Unexpected size: {partial.name}")
            partial.replace(target)
        with target.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if digest != spec["sha256"]:
            raise ValueError(f"Checksum mismatch: {target.name}")
        hashes[target.name] = digest
        print(f"Verified {target.name}: {digest}", flush=True)
    (RUNTIME / "verified_weights.json").write_text(json.dumps(hashes, indent=2))
    # Use the existing portable runtime; never let a package resolver replace Torch/CUDA.
    python = ROOT / "comfy/ComfyUI_windows_portable/python_embeded/python.exe"
    packages = ["hydra-core==1.3.2", "addict==2.4.0"]
    subprocess.run([str(python), "-s", "-m", "pip", "install", *packages], check=True)
    print("Temporal Head Swap compositor installed.", flush=True)


if __name__ == "__main__":
    install()
