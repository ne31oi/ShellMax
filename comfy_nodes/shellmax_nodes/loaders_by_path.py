"""Model loaders that take an absolute file path instead of a name from a models folder.

Each node delegates to the stock loader implementation (core nodes / the Minimax H3
latent upscaler pack) and only overrides how the file name is resolved. Loading,
dtype handling, quantized formats and LoRA patching therefore stay identical to
the original workflow's nodes.
"""

import contextlib
import logging
import os
import sys

import folder_paths
import nodes

MODEL_EXTENSIONS = {".safetensors", ".sft", ".ckpt", ".pt", ".pth", ".bin"}


def normalize_path(raw: str) -> str:
    """Accepts what users paste: surrounding quotes/spaces (Explorer "Copy as path"), forward slashes."""
    path = (raw or "").strip().strip('"').strip("'").strip()
    if not path:
        raise ValueError("ShellMax: путь к файлу модели не указан")
    path = os.path.normpath(os.path.expandvars(os.path.expanduser(path)))
    if not os.path.isabs(path):
        raise ValueError(f"ShellMax: нужен абсолютный путь, получено: {raw!r}")
    if not os.path.isfile(path):
        raise FileNotFoundError(f"ShellMax: файл не найден: {path}")
    if os.path.splitext(path)[1].lower() not in MODEL_EXTENSIONS:
        raise ValueError(f"ShellMax: неподдерживаемый тип файла: {path}")
    return path


@contextlib.contextmanager
def absolute_paths_resolve():
    """While active, folder_paths lookups given an absolute existing path return it unchanged."""
    orig_full = folder_paths.get_full_path
    orig_raise = folder_paths.get_full_path_or_raise

    def get_full_path(folder_name, filename):
        if os.path.isabs(filename) and os.path.isfile(filename):
            return filename
        return orig_full(folder_name, filename)

    def get_full_path_or_raise(folder_name, filename):
        if os.path.isabs(filename) and os.path.isfile(filename):
            return filename
        return orig_raise(folder_name, filename)

    folder_paths.get_full_path = get_full_path
    folder_paths.get_full_path_or_raise = get_full_path_or_raise
    try:
        yield
    finally:
        folder_paths.get_full_path = orig_full
        folder_paths.get_full_path_or_raise = orig_raise


PATH_INPUT = ("STRING", {"default": "", "multiline": False, "tooltip": "Абсолютный путь к файлу"})
CATEGORY = "ShellMax/loaders"


class ShellMaxUNETLoaderByPath:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "unet_path": PATH_INPUT,
            "weight_dtype": (["default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"],),
        }}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "load"
    CATEGORY = CATEGORY

    def load(self, unet_path, weight_dtype):
        path = normalize_path(unet_path)
        with absolute_paths_resolve():
            return nodes.UNETLoader().load_unet(path, weight_dtype)


class ShellMaxCLIPLoaderByPath:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "clip_path": PATH_INPUT,
            "type": ("STRING", {"default": "minimax"}),
            "device": (["default", "cpu"],),
        }}

    RETURN_TYPES = ("CLIP",)
    FUNCTION = "load"
    CATEGORY = CATEGORY

    def load(self, clip_path, type, device):
        path = normalize_path(clip_path)
        with absolute_paths_resolve():
            return nodes.CLIPLoader().load_clip(path, type, device)


class ShellMaxVAELoaderByPath:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"vae_path": PATH_INPUT}}

    RETURN_TYPES = ("VAE",)
    FUNCTION = "load"
    CATEGORY = CATEGORY

    def load(self, vae_path):
        path = normalize_path(vae_path)
        with absolute_paths_resolve():
            return nodes.VAELoader().load_vae(path)


class ShellMaxLoraLoaderByPath:
    """Same as core LoraLoader (and each slot of rgthree's Lora Loader Stack): patches model and clip."""

    def __init__(self):
        # keep one core loader per node so its loaded-lora cache survives re-runs
        self._loader = nodes.LoraLoader()

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",),
            "clip": ("CLIP",),
            "lora_path": PATH_INPUT,
            "strength_model": ("FLOAT", {"default": 1.0, "min": -100.0, "max": 100.0, "step": 0.01}),
            "strength_clip": ("FLOAT", {"default": 1.0, "min": -100.0, "max": 100.0, "step": 0.01}),
        }}

    RETURN_TYPES = ("MODEL", "CLIP")
    FUNCTION = "load"
    CATEGORY = CATEGORY

    def load(self, model, clip, lora_path, strength_model, strength_clip):
        path = normalize_path(lora_path)
        with absolute_paths_resolve():
            return self._loader.load_lora(model, clip, path, strength_model, strength_clip)


class ShellMaxLoraModelOnlyByPath:
    def __init__(self):
        self._loader = nodes.LoraLoaderModelOnly()

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",),
            "lora_path": PATH_INPUT,
            "strength_model": ("FLOAT", {"default": 1.0, "min": -100.0, "max": 100.0, "step": 0.01}),
        }}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "load"
    CATEGORY = CATEGORY

    def load(self, model, lora_path, strength_model):
        path = normalize_path(lora_path)
        with absolute_paths_resolve():
            return self._loader.load_lora_model_only(model, path, strength_model)


def _upscaler_module():
    cls = nodes.NODE_CLASS_MAPPINGS.get("MinimaxH3LatentUpscaler3D")
    if cls is None:
        raise RuntimeError("ShellMax: не установлен пакет Comfyui_Minimax_h3_latent_Upscaler")
    return cls, sys.modules[cls.__module__]


class ShellMaxLatentUpscalerByPath:
    """MinimaxH3LatentUpscaler3D in 'scale by multiplier' mode with the model given by path.

    The upstream node only looks in the first latent_upscale_models folder, so the
    module's models-dir lookup is pointed at the file's folder for the call.
    """

    _last_path = None

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "latent": ("LATENT",),
            "model_path": PATH_INPUT,
            "scale": ("FLOAT", {"default": 1.5, "min": 1.0, "max": 4.0, "step": 0.05}),
            "align": ("INT", {"default": 32, "min": 1, "max": 512}),
            "device": (["cuda", "cpu"],),
            "precision": (["fp32", "fp16", "bf16"], {"default": "fp16"}),
        }}

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "upscale"
    CATEGORY = CATEGORY

    def upscale(self, latent, model_path, scale, align, device, precision):
        path = normalize_path(model_path)
        upscaler_cls, module = _upscaler_module()

        # upstream caches models by file name only; drop it when a different file is used
        cache = getattr(module, "MODEL_CACHE", None)
        if cache is not None and ShellMaxLatentUpscalerByPath._last_path not in (None, path):
            cache.clear()
        ShellMaxLatentUpscalerByPath._last_path = path

        orig_dir = module.get_models_dir
        module.get_models_dir = lambda: os.path.dirname(path)
        try:
            mode = {"mode": "scale by multiplier", "scale": scale}
            out = upscaler_cls.execute(latent, os.path.basename(path), mode, align, device, precision)
        finally:
            module.get_models_dir = orig_dir
        result = out.result if hasattr(out, "result") else out
        return (result[0],)


class ShellMaxFrameInterpLoaderByPath:
    """FrameInterpolationModelLoader with an absolute model path (RIFE / FILM)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model_path": PATH_INPUT}}

    RETURN_TYPES = ("INTERP_MODEL",)
    FUNCTION = "load"
    CATEGORY = CATEGORY

    def load(self, model_path):
        import torch
        import comfy.model_patcher
        import comfy.utils
        from comfy import model_management
        from comfy_extras.nodes_frame_interpolation import FrameInterpolationModelLoader

        path = normalize_path(model_path)
        sd = comfy.utils.load_torch_file(path, safe_load=True)
        model = FrameInterpolationModelLoader._detect_and_load(sd)
        dtype = torch.float16 if model_management.should_use_fp16(model_management.get_torch_device()) else torch.float32
        model.eval().to(dtype)
        patcher = comfy.model_patcher.CoreModelPatcher(
            model,
            load_device=model_management.get_torch_device(),
            offload_device=model_management.unet_offload_device(),
        )
        return (patcher,)


NODE_CLASS_MAPPINGS = {
    "ShellMaxUNETLoaderByPath": ShellMaxUNETLoaderByPath,
    "ShellMaxCLIPLoaderByPath": ShellMaxCLIPLoaderByPath,
    "ShellMaxVAELoaderByPath": ShellMaxVAELoaderByPath,
    "ShellMaxLoraLoaderByPath": ShellMaxLoraLoaderByPath,
    "ShellMaxLoraModelOnlyByPath": ShellMaxLoraModelOnlyByPath,
    "ShellMaxLatentUpscalerByPath": ShellMaxLatentUpscalerByPath,
    "ShellMaxFrameInterpLoaderByPath": ShellMaxFrameInterpLoaderByPath,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ShellMaxUNETLoaderByPath": "ShellMax Load Diffusion Model (path)",
    "ShellMaxCLIPLoaderByPath": "ShellMax Load Text Encoder (path)",
    "ShellMaxVAELoaderByPath": "ShellMax Load VAE (path)",
    "ShellMaxLoraLoaderByPath": "ShellMax Load LoRA (path)",
    "ShellMaxLoraModelOnlyByPath": "ShellMax Load LoRA Model Only (path)",
    "ShellMaxLatentUpscalerByPath": "ShellMax Minimax H3 Latent Upscaler (path)",
    "ShellMaxFrameInterpLoaderByPath": "ShellMax Load Frame Interpolation Model (path)",
}

logging.info("ShellMax: path loaders registered")
