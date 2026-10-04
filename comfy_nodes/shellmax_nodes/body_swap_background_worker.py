"""Reconstruct the original person's background with the installed ProPainter."""
import argparse
from pathlib import Path
import sys

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from head_swap_worker import inpaint_video


@torch.inference_mode()
def run(args):
    runtime, weights = Path(args.runtime).resolve(), Path(args.weights).resolve()
    sys.path.insert(0, str(runtime / "propainter"))
    with np.load(args.input) as arrays:
        source = torch.from_numpy(arrays["source"].copy())
        donor = torch.from_numpy(arrays["donor"].copy())
        coverage = torch.from_numpy(arrays["coverage"].copy())
        alpha = torch.from_numpy(arrays["alpha"].copy()).clamp(0, 1)
    # Erase the whole old silhouette. Keeping old body pixels as inpainting
    # context would smear its dark hair into the newly uncovered background.
    plate = inpaint_video(source, (coverage > 0.01).float(), runtime, weights, torch.device("cuda"))
    composite = donor * alpha[..., None] + plate * (1 - alpha[..., None])
    np.savez(args.output, composite=composite.numpy(), plate=plate.numpy())
    print("Body Swap background reconstruction complete", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ("input", "output", "runtime", "weights"):
        parser.add_argument("--" + name, required=True)
    run(parser.parse_args())
