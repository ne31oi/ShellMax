"""InterpolateFullParams -> ComfyUI API prompt for native RIFE / FILM frame interpolation.

Graph: workflows/ShellMax_Interpolate.json (golden).
"""

from .params import InterpolateFullParams

STAGE_BY_NODE = {
    "1": "load", "2": "load",
    "3": "interpolate",
    "4": "save",
}
FINAL_OUTPUT_NODE = "4"
SAMPLER_NODES: tuple[str, ...] = ()


def _link(node_id: str, slot: int = 0) -> list:
    return [node_id, slot]


def build_interpolate_prompt(p: InterpolateFullParams) -> dict:
    r = p.recipe
    return {
        "1": {"class_type": "VHS_LoadVideoPath",
              "inputs": {"video": p.source_path, "force_rate": 0, "custom_width": 0, "custom_height": 0,
                         "frame_load_cap": p.frame_load_cap, "skip_first_frames": 0, "select_every_nth": 1,
                         "format": "None"}},
        "2": {"class_type": "ShellMaxFrameInterpLoaderByPath",
              "inputs": {"model_path": r.model}},
        "3": {"class_type": "FrameInterpolate",
              "inputs": {"interp_model": _link("2"), "images": _link("1"), "multiplier": r.multiplier}},
        "4": {"class_type": "VHS_VideoCombine",
              "inputs": {"images": _link("3"), "audio": _link("1", 2),
                         "filename_prefix": p.filename_prefix, "frame_rate": p.frame_rate,
                         "loop_count": 0, "format": "video/h264-mp4", "pix_fmt": "yuv420p",
                         "crf": r.crf, "save_metadata": True, "trim_to_audio": False,
                         "pingpong": False, "save_output": True}},
    }
