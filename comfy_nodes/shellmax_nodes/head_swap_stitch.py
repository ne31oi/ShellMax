"""Delegate head compositing, then restore foreground pixels from the source."""
import copy

import nodes
import torch


def restore_foreground(composite, original, masks, transform):
    import comfy.model_management as mm
    import torch.nn.functional as F

    result = composite.clone()
    _, height, width, _ = original.shape
    device = mm.get_torch_device()
    indices = transform.get("source") or list(range(len(masks)))
    for start in range(0, len(indices), 8):
        mm.throw_exception_if_processing_interrupted()
        selected = indices[start:start + 8]
        theta = []
        for x, y, bw, bh in transform["boxes"][start:start + 8]:
            theta.append([[width / bw, 0, (width - 2 * x) / bw - 1],
                          [0, height / bh, (height - 2 * y) / bh - 1]])
        affine = torch.tensor(theta, dtype=torch.float32, device=device)
        grid = F.affine_grid(affine, (len(selected), 1, height, width), align_corners=False)
        matte = F.grid_sample(masks[start:start + 8, None].to(device=device, dtype=torch.float32),
            grid, mode="bilinear", padding_mode="zeros", align_corners=False)[:, 0]
        # No second resampling or feather on the hand itself: copy source pixels.
        covered = (matte > 0.05).to(result.device)[..., None]
        result[selected] = torch.where(covered, original[selected], result[selected])
    return result


class ShellMaxH3HeadSwapStitch:
    @classmethod
    def INPUT_TYPES(cls):
        inputs = copy.deepcopy(nodes.NODE_CLASS_MAPPINGS["H3FaceStitch"].INPUT_TYPES())
        inputs["required"]["source_foreground"] = ("MASK",)
        return inputs

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"
    CATEGORY = "ShellMax/head swap"

    def run(self, source_foreground, **inputs):
        composite = nodes.NODE_CLASS_MAPPINGS["H3FaceStitch"]().run(**inputs)[0]
        return (restore_foreground(composite, inputs["base_images"], source_foreground, inputs["transform"]),)


NODE_CLASS_MAPPINGS = {"ShellMaxH3HeadSwapStitch": ShellMaxH3HeadSwapStitch}
