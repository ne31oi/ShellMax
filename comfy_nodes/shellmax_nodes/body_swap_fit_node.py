"""Fit the replacement to source head geometry, illumination and vacated background."""
import json
from pathlib import Path

import torch

from .body_swap_fit import align_head, local_background, scene_relight


class ShellMaxBodySwapFitComposite:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"source": ("IMAGE",), "donor": ("IMAGE",),
            "source_alpha": ("MASK",), "alpha": ("MASK",), "detector_path": ("STRING",),
            "background_radius": ("INT", {"default": 5, "min": 1, "max": 16}),
            "background_margin": ("INT", {"default": 4, "min": 0, "max": 16})}}

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("composite", "fitted_alpha")
    FUNCTION = "fit"
    CATEGORY = "ShellMax/body swap"

    @classmethod
    def IS_CHANGED(cls, **inputs):
        return Path(__file__).with_name("body_swap_fit.py").stat().st_mtime_ns

    def fit(self, source, donor, source_alpha, alpha, detector_path, background_radius, background_margin):
        import comfy.model_management as mm
        from comfy.utils import ProgressBar

        if source.shape != donor.shape or alpha.shape != source_alpha.shape or alpha.shape != source.shape[:3]:
            raise ValueError("Body Swap: размеры кадров и масок не совпадают")
        if not Path(detector_path).is_file():
            raise ValueError("Не установлен трекер размера головы — запустите scripts/install_body_swap.py")
        original,replacement,old,new=(t.detach().cpu().numpy() for t in (source,donor,source_alpha,alpha))
        mm.throw_exception_if_processing_interrupted()
        aligned,matte,faces,scales=align_head(original,replacement,new,detector_path,mm.throw_exception_if_processing_interrupted)
        relit,gains=scene_relight(original,aligned,faces,old,matte)
        progress=ProgressBar(len(original))
        completed=0
        def advance():
            nonlocal completed
            completed+=1
            progress.update_absolute(completed)
        plate=local_background(original,old,matte,background_radius,background_margin,
                               check=mm.throw_exception_if_processing_interrupted,progress=advance)
        composite=relit*matte[:,:,:,None]+plate*(1-matte[:,:,:,None])
        print("[ShellMax Body Swap fit] "+json.dumps({"head_scale_mean":float(scales.mean()),
            "head_scale_range":[float(scales.min()),float(scales.max())],
            "face_rgb_gain_bands":gains.mean(0).tolist(),"background":"source-pixel vacancy extension"}))
        return torch.from_numpy(composite.astype("float32")),torch.from_numpy(matte.astype("float32"))


NODE_CLASS_MAPPINGS={"ShellMaxBodySwapFitComposite":ShellMaxBodySwapFitComposite}
