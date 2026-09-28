"""FaceFullParams -> ComfyUI API prompt, replicating MiniMax_H3_FaceRefine_Best.

Node ids match workflows/MiniMax_H3_FaceRefine_Best.json. Differences from the original,
all value-preserving:
  - model / text encoder / VAE / LoRA loaders take absolute paths (ShellMax*ByPath nodes);
  - node 120 (Sage attention patch) is bypassed in the original, so 121 takes the model from 108;
  - preview-only outputs are dropped: 24/25 (before|after concat - the UI has its own A/B wipe),
    27 (refined crops), 29/30 (denoise / inject reports). 26 (tracking preview) and 28
    (tracking report) stay: they arrive early and tell the user whether the face was found;
  - node 8 (optional separate vocal stem) is disabled in the original and not built.
"""

from .graph_util import link as _link
from .params import FPS, FaceFullParams

STAGE_BY_NODE = {
    "108": "load", "109": "load", "4": "load", "5": "load", "1": "load",
    "2": "track", "26": "track", "28": "track",
    "6": "encode", "7": "encode", "9": "encode", "10": "encode",
    "13": "lipsync", "31": "lipsync",
    "18": "refine",
    "19": "stitch", "22": "stitch",
    "23": "save",
}
TRACK_PREVIEW_NODE = "26"
TRACK_REPORT_NODE = "28"
FINAL_OUTPUT_NODE = "23"
SAMPLER_NODES = ("18",)


def build_face_prompt(p: FaceFullParams) -> dict:
    r = p.recipe
    g: dict[str, dict] = {}

    # ---------------------------------------------------------------- model chain (108 -> 121 -> 122 -> 12)
    g["108"] = {"class_type": "ShellMaxUNETLoaderByPath", "inputs": {"unet_path": r.unet, "weight_dtype": "default"}}
    g["121"] = {"class_type": "ModelAttentionBackend",
                "inputs": {"model": _link("108"), "attention": "comfy kitchen attention"}}
    g["122"] = {"class_type": "MiniMaxChunkFeedForward",
                "inputs": {"model": _link("121"), "chunks": 2, "seq_threshold": 4096}}
    g["12"] = {"class_type": "ShellMaxLoraModelOnlyByPath",
               "inputs": {"model": _link("122"), "lora_path": r.lora, "strength_model": r.lora_strength}}
    g["109"] = {"class_type": "ShellMaxCLIPLoaderByPath",
                "inputs": {"clip_path": p.text_encoder, "type": "minimax", "device": "default"}}
    g["4"] = {"class_type": "ShellMaxVAELoaderByPath", "inputs": {"vae_path": p.vae_video}}
    g["5"] = {"class_type": "ShellMaxVAELoaderByPath", "inputs": {"vae_path": p.vae_audio}}

    # ---------------------------------------------------------------- source clip + face tracking
    g["1"] = {"class_type": "VHS_LoadVideoPath",
              "inputs": {"video": p.source_path, "force_rate": p.force_rate, "custom_width": 0, "custom_height": 0,
                         "frame_load_cap": p.frame_load_cap, "skip_first_frames": 0, "select_every_nth": 1,
                         "format": "None"}}
    g["2"] = {"class_type": "H3FaceTrackCrop",
              "inputs": {"images": _link("1", 0), "detector": "bbox\\face_yolov8m.pt", "confidence": 0.35,
                         "crop_factor": r.crop_factor, "canvas_width": r.canvas, "canvas_height": r.canvas,
                         "canvas_mode": "manual", "smooth_window": r.smooth_window,
                         "size_smooth_window": r.size_smooth_window, "smooth_method": "gaussian",
                         "size_mode": "per_frame", "identity_track": True, "identity_threshold": 0.28,
                         "select": r.select, "fallback_detector": "segm\\person_yolov8m-seg.pt",
                         "fallback_head_frac": 0.5, "select_index": 0, "identity_model": "insightface",
                         "cut_detection": "auto (pyscenedetect)", "cut_threshold": 3.0, "absent_shots": "off",
                         "frame_index": 0}}

    # ---------------------------------------------------------------- references + H3 conditioning
    g["6"] = {"class_type": "LoadImage", "inputs": {"image": p.identity_image}}
    g["7"] = {"class_type": "LoadImageCrop",
              "inputs": {"image": p.closeup_image, "crop": p.closeup_crop, "max_megapixels": 0.0}}
    g["9"] = {"class_type": "MiniMaxH3ReferenceToVideo",
              "inputs": {"clip": _link("109"), "vae": _link("4"), "audio_vae": _link("5"), "prompt": p.prompt,
                         "width": _link("2", 4), "height": _link("2", 5), "length": _link("2", 6),
                         "ref_image_size": r.ref_image_size,
                         "ref_images.ref_image_0": _link("6", 0), "ref_images.ref_image_1": _link("7", 0),
                         "ref_audios.ref_audio_0": _link("1", 2)}}
    g["10"] = {"class_type": "H3InjectVideoLatent",
               "inputs": {"av_latent": _link("9", 1), "images": _link("2", 0), "vae": _link("4")}}

    # ---------------------------------------------------------------- audio lock (lip sync) + per-frame denoise
    g["13"] = {"class_type": "MiniMaxH3NativeAudioLock",
               "inputs": {"model": _link("12"), "av_latent": _link("10", 0), "audio_vae": _link("5"),
                          "audio": _link("1", 2)}}
    g["31"] = {"class_type": "H3PerFrameDenoise",
               "inputs": {"model": _link("13", 0), "av_latent": _link("13", 1), "transform": _link("2", 1),
                          "denoise_multiplier_small_face": 1.0, "denoise_multiplier_large_face": 0.35,
                          "scale_mode": "absolute_px", "face_px_small": r.face_px_small,
                          "face_px_large": r.face_px_large, "gamma": 1.0, "smooth_frames": 9}}

    # ---------------------------------------------------------------- sampling
    g["14"] = {"class_type": "BasicGuider", "inputs": {"model": _link("31", 2), "conditioning": _link("9", 0)}}
    g["15"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": r.sampler}}
    g["16"] = {"class_type": "BasicScheduler",
               "inputs": {"model": _link("31", 2), "scheduler": r.scheduler, "steps": r.steps, "denoise": p.denoise}}
    g["17"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": p.seed}}
    g["18"] = {"class_type": "SamplerCustomAdvanced",
               "inputs": {"noise": _link("17"), "guider": _link("14"), "sampler": _link("15"),
                          "sigmas": _link("16"), "latent_image": _link("31", 0)}}
    g["19"] = {"class_type": "VAEDecode", "inputs": {"samples": _link("18", 0), "vae": _link("4")}}

    # ---------------------------------------------------------------- stitch back + outputs
    g["22"] = {"class_type": "H3FaceStitch",
               "inputs": {"base_images": _link("1", 0), "refined_crops": _link("19"), "transform": _link("2", 1),
                          "paste_region": "face_only", "mask_dilation": r.mask_dilation, "feather": r.feather,
                          "colour_match": r.colour_match, "blend": r.blend, "undetected_frames": "fade_out",
                          "feather_scales_with_crop": False}}
    combine = {"frame_rate": FPS, "loop_count": 0, "format": "video/h264-mp4", "pix_fmt": "yuv420p",
               "save_metadata": True, "trim_to_audio": False, "pingpong": False}
    g["23"] = {"class_type": "VHS_VideoCombine",
               "inputs": {"images": _link("22"), "audio": _link("1", 2), "filename_prefix": p.filename_prefix,
                          "crf": r.crf, "save_output": True, **combine}}
    g["26"] = {"class_type": "VHS_VideoCombine",
               "inputs": {"images": _link("2", 2), "filename_prefix": p.filename_prefix + "_track",
                          "crf": 20, "save_output": False, **combine}}
    g["28"] = {"class_type": "PreviewAny", "inputs": {"source": _link("2", 3)}}
    return g
