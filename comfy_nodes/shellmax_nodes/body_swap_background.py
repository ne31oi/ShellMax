"""Paste only the new silhouette over a temporally reconstructed clean plate."""
from pathlib import Path
import sys
import tempfile

import folder_paths
import numpy as np
import torch

from .worker_process import run_worker


class ShellMaxBodySwapBackground:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"source": ("IMAGE",), "donor": ("IMAGE",),
            "coverage": ("MASK",), "alpha": ("MASK",), "weights_dir": ("STRING",)}}

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("composite", "clean_plate")
    FUNCTION = "run"
    CATEGORY = "ShellMax/body swap"

    @classmethod
    def IS_CHANGED(cls, **inputs):
        return tuple(Path(__file__).with_name(name).stat().st_mtime_ns
                     for name in ("body_swap_background_worker.py", "head_swap_worker.py"))

    def run(self, source, donor, coverage, alpha, weights_dir):
        import comfy.model_management as mm
        from comfy.utils import ProgressBar

        if source.shape != donor.shape or coverage.shape != alpha.shape or coverage.shape != source.shape[:3]:
            raise ValueError("Body Swap: размеры кадров и масок не совпадают")
        if not alpha.flatten(1).any(1).all():
            raise ValueError("Не удалось выделить нового персонажа на всех кадрах")
        weights = Path(weights_dir)
        for name in ("ProPainter.pth", "raft-things.pth", "recurrent_flow_completion.pth"):
            if not (weights / name).is_file():
                raise ValueError(f"Не установлено восстановление фона: отсутствует {name}")
        runtime = Path(folder_paths.base_path).parents[1] / "head_swap_runtime"
        mm.unload_all_models()
        mm.soft_empty_cache()
        progress = ProgressBar(len(source))
        with tempfile.TemporaryDirectory(prefix="shellmax-body-", dir=folder_paths.get_temp_directory()) as directory:
            root = Path(directory)
            source_file, result_file = root / "input.npz", root / "output.npz"
            np.savez(source_file, source=source.cpu().numpy(), donor=donor.cpu().numpy(),
                     coverage=coverage.cpu().numpy(), alpha=alpha.cpu().numpy())
            command = [sys.executable, "-s", str(Path(__file__).with_name("body_swap_background_worker.py")),
                "--input", str(source_file), "--output", str(result_file),
                "--runtime", str(runtime), "--weights", str(weights)]
            run_worker(command, root / "worker.log", "Восстановление фона не завершилось")
            with np.load(result_file) as arrays:
                composite, plate = (torch.from_numpy(arrays[key].copy()) for key in ("composite", "plate"))
        progress.update_absolute(len(source))
        return composite, plate


NODE_CLASS_MAPPINGS = {"ShellMaxBodySwapBackground": ShellMaxBodySwapBackground}
