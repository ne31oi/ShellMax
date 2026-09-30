"""One-step H3 SoL-Refiner using ComfyUI's native INT8 ConvRot loaders."""
import json
import time
from pathlib import Path


class ShellMaxSoLRefinerByPath:
    RETURN_TYPES = ()
    FUNCTION = "run"
    CATEGORY = "ShellMax"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "source_path": ("STRING",), "prompt": ("STRING", {"multiline": True}), "runtime_dir": ("STRING",),
            "width": ("INT", {"default": 1920, "min": 2, "step": 2}),
            "height": ("INT", {"default": 1080, "min": 2, "step": 2}),
            "seed": ("INT", {"default": 0, "min": 0, "max": 2**63 - 1}),
            "decoder_seed": ("INT", {"default": 0, "min": 0, "max": 0}),
            "filename_prefix": ("STRING", {"default": "ShellMax/sol_refine"}),
        }}

    def run(self, source_path, prompt, runtime_dir, width, height, seed, decoder_seed, filename_prefix):
        import comfy.model_management as mm
        import comfy.utils
        import folder_paths
        from .native import refine
        from .media import read_video, save_video

        runtime = Path(runtime_dir)
        try:
            manifest = json.loads((runtime / "installed.json").read_text(encoding="utf-8"))
            paths = {key: runtime / "model-int8" / entry["path"] for key, entry in manifest["files"].items()}
            if any(paths[key].stat().st_size != entry["size"] for key, entry in manifest["files"].items()):
                raise ValueError("Wrong model size")
        except (OSError, ValueError, KeyError) as exc:
            raise RuntimeError("SoL-Refiner не установлен — запустите scripts/install_sol_refiner.py") from exc
        if decoder_seed != 0:
            raise ValueError("SoL-Refiner: штатный декодер ComfyUI использует сид 0")
        root = Path(folder_paths.get_output_directory()).resolve()
        prefix = Path(filename_prefix)
        if prefix.is_absolute() or ".." in prefix.parts:
            raise ValueError("Недопустимый путь результата SoL-Refiner")
        output = root / prefix.parent / (prefix.name + "_" + str(time.time_ns()) + ".mp4")
        output.parent.mkdir(parents=True, exist_ok=True)
        mm.unload_all_models()
        mm.soft_empty_cache()
        bar = comfy.utils.ProgressBar(100)
        frames, fps, count = read_video(source_path)
        try:
            result = refine(paths, frames, fps, prompt, width, height, seed, bar)
            mm.throw_exception_if_processing_interrupted()
            save_video(result[:count], fps, source_path, output)
        except BaseException:
            output.unlink(missing_ok=True)
            raise
        finally:
            mm.unload_all_models()
            mm.soft_empty_cache()
        bar.update_absolute(100, 100)
        return {"ui": {"videos": [{"filename": output.name,
                                    "subfolder": output.parent.relative_to(root).as_posix(), "type": "output"}]}}


NODE_CLASS_MAPPINGS = {"ShellMaxSoLRefinerByPath": ShellMaxSoLRefinerByPath}
NODE_DISPLAY_NAME_MAPPINGS = {"ShellMaxSoLRefinerByPath": "ShellMax · SoL-Refiner INT8 (H3)"}
