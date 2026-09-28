"""EnhanceFullParams -> ComfyUI API prompt for SeedVR2 upscale/restore.

Flat graph adapted from ComfyUI blueprint «Upscale Video (SeedVR2 3B Int8)»
(workflows/ShellMax_SeedVR2_Enhance.json is the golden API graph).

Value-preserving differences from the blueprint subgraph:
  - ImageScaleBy instead of ResizeImageMaskNode (same lanczos ×scale);
  - temporal chunking OFF (blueprint switch default); chunk seams with overlap 0
    made short AI clips look worse than the source;
  - ShellMax*ByPath loaders with absolute paths;
  - VHS_LoadVideoPath + VHS_VideoCombine instead of LoadVideo/CreateVideo/SaveVideo
    so outputs match the rest of ShellMax (gifs/videos on the combine node);
  - post color match defaults to lab (blueprint widget is none; lab keeps MiniMax look);
  - ImageBlend after post-process: pure SeedVR (blend_factor=1) overcooks sharp MiniMax
    clips; default strength ~0.55 mixes restored detail with the source for realism.
"""

from .graph_util import link as _link
from .params import EnhanceFullParams

STAGE_BY_NODE = {
    "1": "load", "4": "load", "5": "load",
    "2": "resize", "3": "resize",
    "6": "encode",
    "8": "sample", "9": "sample",
    "11": "decode", "12": "decode", "14": "decode",
    "13": "save",
}
FINAL_OUTPUT_NODE = "13"
SAMPLER_NODES = ("9",)


def build_enhance_prompt(p: EnhanceFullParams) -> dict:
    r = p.recipe
    g: dict[str, dict] = {}

    g["1"] = {"class_type": "VHS_LoadVideoPath",
              "inputs": {"video": p.source_path, "force_rate": p.force_rate, "custom_width": 0, "custom_height": 0,
                         "frame_load_cap": p.frame_load_cap, "skip_first_frames": 0, "select_every_nth": 1,
                         "format": "None"}}
    g["2"] = {"class_type": "ImageScaleBy",
              "inputs": {"image": _link("1"), "upscale_method": "lanczos", "scale_by": r.scale}}
    g["3"] = {"class_type": "SeedVR2Preprocess", "inputs": {"resized_images": _link("2")}}
    g["4"] = {"class_type": "ShellMaxVAELoaderByPath", "inputs": {"vae_path": r.vae}}
    g["5"] = {"class_type": "ShellMaxUNETLoaderByPath",
              "inputs": {"unet_path": r.unet, "weight_dtype": "default"}}
    g["6"] = {"class_type": "VAEEncodeTiled",
              "inputs": {"pixels": _link("3"), "vae": _link("4"), "tile_size": r.tile_size,
                         "overlap": r.overlap, "temporal_size": r.temporal_size,
                         "temporal_overlap": r.temporal_overlap}}
    # Direct path (blueprint default): no TemporalChunk / TemporalMerge.
    g["8"] = {"class_type": "SeedVR2Conditioning",
              "inputs": {"model": _link("5"), "vae_conditioning": _link("6")}}
    g["9"] = {"class_type": "KSampler",
              "inputs": {"model": _link("5"), "seed": p.seed, "steps": r.steps, "cfg": r.cfg,
                         "sampler_name": r.sampler, "scheduler": r.scheduler, "denoise": r.denoise,
                         "positive": _link("8", 0), "negative": _link("8", 1),
                         "latent_image": _link("6")}}
    g["11"] = {"class_type": "VAEDecodeTiled",
               "inputs": {"samples": _link("9"), "vae": _link("4"), "tile_size": r.tile_size,
                          "overlap": r.overlap, "temporal_size": r.temporal_size,
                          "temporal_overlap": r.temporal_overlap}}
    g["12"] = {"class_type": "SeedVR2PostProcessing",
               "inputs": {"images": _link("11"), "original_resized_images": _link("2"),
                          "color_correction_method": r.color_correction}}
    # image1=source, image2=SeedVR; blend_factor = how much SeedVR (0=source, 1=full).
    g["14"] = {"class_type": "ImageBlend",
               "inputs": {"image1": _link("2"), "image2": _link("12"),
                          "blend_factor": float(r.strength), "blend_mode": "normal"}}
    g["13"] = {"class_type": "VHS_VideoCombine",
               "inputs": {"images": _link("14"), "audio": _link("1", 2),
                          "filename_prefix": p.filename_prefix, "frame_rate": p.frame_rate,
                          "loop_count": 0, "format": "video/h264-mp4", "pix_fmt": "yuv420p",
                          "crf": r.crf, "save_metadata": True, "trim_to_audio": False,
                          "pingpong": False, "save_output": True}}
    return g
