"""Install the pinned official classical SwinIR x2 checkpoint."""
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]


def verified(path: Path, cfg: dict) -> bool:
    if not path.is_file() or path.stat().st_size != cfg["size"]:
        return False
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest() == cfg["sha256"]


def main() -> None:
    cfg = json.loads((ROOT / "config/fidelity-upscale.json").read_text(encoding="utf-8"))
    path = ROOT / cfg["model"]
    if verified(path, cfg):
        print("SwinIR x2 is ready (67.3 MB).")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(".part")
    with urlopen(cfg["url"], timeout=60) as source, partial.open("wb") as target:
        while block := source.read(1024 * 1024):
            target.write(block)
    if not verified(partial, cfg):
        raise RuntimeError("SwinIR checksum mismatch; rerun the installer.")
    partial.replace(path)
    print("SwinIR x2 is ready (67.3 MB).")


if __name__ == "__main__":
    main()
