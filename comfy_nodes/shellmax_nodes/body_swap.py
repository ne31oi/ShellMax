"""Validated source fragments and original hand restoration for Body Swap."""
import torch

import nodes


def restore_hands(images, source, hands):
    if images.shape != source.shape or hands.shape != source.shape[:3]:
        raise ValueError("Body Swap: маска кистей не совпадает с кадрами исходника")
    alpha = hands.to(source).clamp(0, 1)[..., None]
    return images.to(source) * (1 - alpha) + source * alpha


class ShellMaxBodySwapSource:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"video": ("STRING",), "start": ("FLOAT", {"default": 0, "min": 0}),
            "frames": ("INT", {"default": 39, "min": 5, "max": 175}), "has_audio": ("BOOLEAN", {"default": True})}}

    RETURN_TYPES = ("IMAGE", "INT", "AUDIO")
    FUNCTION = "load"
    CATEGORY = "ShellMax/body swap"

    def load(self, video, start, frames, has_audio):
        if frames < 5 or frames > 175 or (frames - 5) % 17:
            raise ValueError("Body Swap: число кадров должно быть на сетке 17k+5 до 175 кадров")
        images, _, audio, _ = nodes.NODE_CLASS_MAPPINGS["VHS_LoadVideoFFmpegPath"]().load_video(
            video=video, start_time=start, force_rate=24, frame_load_cap=frames,
            custom_width=0, custom_height=0, format="None")
        if len(images) != frames:
            raise ValueError("Body Swap: исходник короче выбранного фрагмента — уменьшите его конец")
        duration = frames / 24
        if has_audio:
            rate = audio["sample_rate"]
            waveform = audio["waveform"]
            samples = round(duration * rate)
            waveform = torch.nn.functional.pad(waveform[..., :samples], (0, max(0, samples - waveform.shape[-1])))
        else:
            rate = 48000
            waveform = torch.zeros((1, 2, round(duration * rate)))
        return images, frames, {"waveform": waveform, "sample_rate": rate}


class ShellMaxBodySwapRestoreHands:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",), "source": ("IMAGE",), "hands": ("MASK",)}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "restore"
    CATEGORY = "ShellMax/body swap"

    def restore(self, images, source, hands):
        return (restore_hands(images, source, hands),)


NODE_CLASS_MAPPINGS = {"ShellMaxBodySwapSource": ShellMaxBodySwapSource,
                       "ShellMaxBodySwapRestoreHands": ShellMaxBodySwapRestoreHands}
