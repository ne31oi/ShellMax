"""Match ShellMax_Fidelity_Upscale.json; substitute source/model/fps/target size/encoding.

The stock SwinIR loader is called by absolute path. Every source frame is processed
without temporal resampling, diffusion or blending; VHS retains the source soundtrack.
SwinIR restores at x2 internally; Lanczos returns x1 to the exact original size.
Width/height zero retain the old x2 behavior for previously persisted jobs.
"""
from .fidelity_upscale import FidelityFull

STAGE_BY_NODE = {"1": "load", "2": "load", "3": "upscale", "5": "upscale", "4": "save"}
FINAL_OUTPUT_NODE = "4"
SAMPLER_NODES: tuple[str, ...] = ()


def build_fidelity_prompt(p: FidelityFull) -> dict:
    return {
        "1": {"class_type": "VHS_LoadVideoPath", "inputs": {
            "video": p.source_path, "force_rate": 0, "custom_width": 0, "custom_height": 0,
            "frame_load_cap": 0, "skip_first_frames": 0, "select_every_nth": 1, "format": "None"}},
        "2": {"class_type": "ShellMaxUpscaleModelLoaderByPath", "inputs": {"model_path": p.model_path}},
        "3": {"class_type": "ImageUpscaleWithModel", "inputs": {"image": ["1", 0], "upscale_model": ["2", 0]}},
        "5": {"class_type": "ImageScale", "inputs": {
            "image": ["3", 0], "upscale_method": "lanczos", "width": p.width, "height": p.height, "crop": "disabled"}},
        "4": {"class_type": "VHS_VideoCombine", "inputs": {
            "images": ["5", 0], "audio": ["1", 2], "filename_prefix": p.filename_prefix,
            "frame_rate": p.frame_rate, "loop_count": 0, "format": "video/h264-mp4", "pix_fmt": "yuv420p",
            "crf": p.crf, "save_metadata": True, "trim_to_audio": False, "pingpong": False, "save_output": True}},
    }
