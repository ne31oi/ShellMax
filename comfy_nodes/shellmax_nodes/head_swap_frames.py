"""Pad to H3's grids without resampling; restore exact source geometry and frame count."""
import torch
import torch.nn.functional as F


class ShellMaxH3HeadSwapPad:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",)}}

    RETURN_TYPES = ("IMAGE", "INT", "INT", "INT")
    RETURN_NAMES = ("images", "width", "height", "length")
    FUNCTION = "pad"
    CATEGORY = "ShellMax/head swap"

    def pad(self, images):
        count, height, width, _ = images.shape
        if count < 1 or count > 3592:
            raise ValueError("Head Swap: нужно от 1 до 3592 кадров")
        target = max(5, count)
        target += (5 - target % 17) % 17
        if width % 32 or height % 32:
            images = F.pad(images.movedim(-1, 1), (0, (-width) % 32, 0, (-height) % 32), mode="replicate").movedim(1, -1)
        if target > count:
            images = torch.cat((images, images[-1:].expand(target - count, -1, -1, -1)))
        return images, images.shape[2], images.shape[1], target


class ShellMaxH3HeadSwapRestore:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",), "source": ("IMAGE",)}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "restore"
    CATEGORY = "ShellMax/head swap"

    def restore(self, images, source):
        count, height, width, _ = source.shape
        if images.shape[0] < count or images.shape[1] < height or images.shape[2] < width:
            raise ValueError("Head Swap: результат короче или меньше исходного видео")
        return (images[:count, :height, :width],)


NODE_CLASS_MAPPINGS = {"ShellMaxH3HeadSwapPad": ShellMaxH3HeadSwapPad,
                       "ShellMaxH3HeadSwapRestore": ShellMaxH3HeadSwapRestore}
