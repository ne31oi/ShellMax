"""Cache head contours independently of the temporal compositor's repair passes."""
import copy
import hashlib
from pathlib import Path

import folder_paths
import numpy as np
import torch

from .head_swap_masks import ShellMaxH3HeadSwapMasks


class ShellMaxH3HeadSwapContours(ShellMaxH3HeadSwapMasks):
    detect_generated_foreground = False

    @classmethod
    def INPUT_TYPES(cls):
        inputs = copy.deepcopy(super().INPUT_TYPES())
        inputs["required"].pop("edge_grow")
        return inputs

    RETURN_TYPES = ("H3HEADCONTOURS",)
    RETURN_NAMES = ("contours",)
    FUNCTION = "contours"

    def contours(self, **inputs):
        digest = hashlib.sha256(("contours-v1" + inputs["tracking_report"] + str(inputs["threshold"])).encode())
        # Quantized pixels are sufficient for a key; no filename can alias a different result.
        for key in ("source_crops", "refined_crops", "selection_masks", "full_frame_result"):
            if key in inputs and inputs[key] is not None:
                for frame in inputs[key]:
                    digest.update((frame.cpu().clamp(0, 1).numpy() * 255).astype(np.uint8).tobytes())
        # Comfy clears its temp directory on startup; these contours must survive a
        # compositor update so an already generated head can be repaired cheaply.
        directory = Path(folder_paths.base_path).parents[1] / "head_swap_runtime/cache"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / (digest.hexdigest() + ".npz")
        if path.exists():
            with np.load(path) as cached:
                arrays = {key: cached[key].copy() for key in cached.files}
        else:
            old, new, foreground, _, donor, allowed = self.segment(**inputs)
            usable = old.flatten(1).any(1) & new.flatten(1).any(1) & allowed
            if not usable.any():
                raise ValueError("SAM не выделил обе головы — выберите кадр с хорошо видимым лицом и волосами")
            arrays = dict(source=(inputs["source_crops"].cpu().clamp(0, 1).numpy() * 255).round().astype(np.uint8),
                donor=(donor.cpu().clamp(0, 1).numpy() * 255).round().astype(np.uint8),
                old=old.numpy().astype(np.uint8), new=new.numpy().astype(np.uint8),
                foreground=foreground.numpy().astype(np.uint8), allowed=allowed.numpy())
        if "person" not in arrays:
            from comfy_extras import nodes_sam3 as sam

            # Preserve the replacement neck/collar where the old long hair covered it.
            # A head-only matte leaves that region to a background painter, which invents fur.
            person = np.zeros_like(arrays["new"])
            conditioning = inputs["clip"].encode_from_tokens_scheduled(inputs["clip"].tokenize("person"))
            count = len(person)
            for start, end in inputs["transform"].get("segments") or [(0, count)]:
                first = next((i for i in range(start, end) if arrays["allowed"][i]
                              and arrays["old"][i].any() and arrays["new"][i].any()), None)
                if first is None:
                    continue
                image = torch.from_numpy(arrays["donor"][first:first + 1]).float() / 255
                found = sam.SAM3_Detect.execute(model=inputs["model"], image=image,
                    conditioning=conditioning, threshold=inputs["threshold"], refine_iterations=2,
                    individual_masks=True).result[0].cpu()
                if not len(found):
                    raise ValueError("Не распознаны шея и одежда нового человека — выберите более ясный кадр")
                overlap = (found * torch.from_numpy(arrays["new"][first])).flatten(1).sum(1)
                person[first] = found[int(overlap.argmax())].numpy().astype(np.uint8)
            arrays["person"] = person
            temporary = path.with_suffix(".partial")
            with temporary.open("wb") as stream:
                np.savez_compressed(stream, **arrays)
            temporary.replace(path)
            retained = path.stat().st_size
            for cached in sorted((p for p in directory.glob("*.npz") if p != path),
                                 key=lambda p: p.stat().st_mtime, reverse=True):
                retained += cached.stat().st_size
                if retained > 2_000_000_000:
                    cached.unlink()
        return ({"path": str(path), "transform": inputs["transform"], "report": inputs["tracking_report"]},)


NODE_CLASS_MAPPINGS = {"ShellMaxH3HeadSwapContours": ShellMaxH3HeadSwapContours}
