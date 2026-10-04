"""Replace per-frame background smearing with a temporally reconstructed clean plate."""
from pathlib import Path
import sys
import tempfile

import folder_paths
import numpy as np
import torch

from .head_swap_masks import grow_mask
from .worker_process import run_worker


class ShellMaxH3HeadSwapTemporal:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"contours": ("H3HEADCONTOURS",), "weights_dir": ("STRING",),
            "edge_grow": ("INT", {"default": 24, "min": 0, "max": 64})}}

    RETURN_TYPES = ("MASK", "IMAGE", "STRING", "MASK", "MASK", "IMAGE")
    RETURN_NAMES = ("paste_masks", "composite_crops", "report", "source_foreground", "head_alpha", "clean_plate")
    FUNCTION = "mask"
    CATEGORY = "ShellMax/head swap"

    @classmethod
    def IS_CHANGED(cls, **inputs):
        return Path(__file__).with_name("head_swap_worker.py").stat().st_mtime_ns

    def mask(self, contours, weights_dir, edge_grow):
        import comfy.model_management as mm
        from comfy.utils import ProgressBar

        with np.load(contours["path"]) as arrays:
            source = torch.from_numpy(arrays["source"].copy()).float() / 255
            donor = torch.from_numpy(arrays["donor"].copy()).float() / 255
            old, new, foreground = (torch.from_numpy(arrays[key].copy()).float() for key in ("old", "new", "foreground"))
            allowed = torch.from_numpy(arrays["allowed"].copy())
            person = torch.from_numpy(arrays["person"].copy()).float()
        runtime = Path(folder_paths.base_path).parents[1] / "head_swap_runtime"
        weights = Path(weights_dir)
        for name in ("matanyone2.pth", "ProPainter.pth", "raft-things.pth", "recurrent_flow_completion.pth"):
            if not (weights / name).is_file():
                raise ValueError(f"Не установлена обработка края головы: отсутствует {name}")
        mm.unload_all_models()
        mm.soft_empty_cache()
        count = len(old)
        # The worker has its own module namespace: ProPainter's generic `model` cannot shadow ComfyUI.
        with tempfile.TemporaryDirectory(prefix="shellmax-head-", dir=folder_paths.get_temp_directory()) as directory:
            root = Path(directory)
            outputs = []
            alphas, plates, old_alphas = [], [], []
            for start, end in contours["transform"].get("segments") or [(0, count)]:
                first = next((i for i in range(start, end) if allowed[i] and old[i].any() and new[i].any()), None)
                if first is None:
                    outputs.append(source[start:end])
                    alphas.append(torch.zeros_like(old[start:end]))
                    plates.append(source[start:end])
                    old_alphas.append(old[start:end])
                    continue
                # The selected person must be visible when the temporal matte is seeded.
                # Process forwards and backwards independently when the selection starts mid-shot.
                results = []
                for indices in (list(range(first, end)), list(range(first, start - 1, -1)) if first > start else []):
                    if not indices:
                        continue
                    source_file, result_file = root / "input.npz", root / "output.npz"
                    np.savez(source_file, source=source[indices].cpu().numpy(),
                        donor=donor[indices].cpu().numpy(), old=old[indices].numpy(), new=new[indices].numpy(),
                        foreground=foreground[indices].numpy(), person=person[indices].numpy())
                    command = [sys.executable, "-s", str(Path(__file__).with_name("head_swap_worker.py")),
                        "--input", str(source_file), "--output", str(result_file),
                        "--runtime", str(runtime), "--weights", str(weights)]
                    progress = ProgressBar(len(indices))
                    run_worker(command, root / "worker.log", "Обработка края головы не завершилась")
                    progress.update_absolute(len(indices))
                    with np.load(result_file) as arrays:
                        results.append(tuple(torch.from_numpy(arrays[key].copy())
                                             for key in ("composite", "alpha", "plate", "old_alpha")))
                forward = results[0]
                if len(results) == 2:
                    backward = results[1]
                    combined = tuple(torch.cat((b.flip(0)[:-1], f)) for b, f in zip(backward, forward))
                else:
                    combined = forward
                outputs.append(combined[0])
                alphas.append(combined[1])
                plates.append(combined[2])
                old_alphas.append(combined[3])
        composite, alpha, plate = torch.cat(outputs), torch.cat(alphas), torch.cat(plates)
        usable = old.flatten(1).any(1) & new.flatten(1).any(1) & allowed
        repaired = grow_mask((torch.cat(old_alphas) > 0.001).float(), 12)
        masks = grow_mask(torch.maximum(repaired, (alpha > 0.001).float()), max(edge_grow, 6))
        masks *= usable[:, None, None]
        # The crop already contains its own alpha composite; blend only the clean-plate outer boundary.
        report = contours["report"] + "\nTemporal head composite: MatAnyone 2 hair alpha + ProPainter clean plate; original foreground."
        return masks, composite, report, foreground, alpha, plate


NODE_CLASS_MAPPINGS = {"ShellMaxH3HeadSwapTemporal": ShellMaxH3HeadSwapTemporal}
