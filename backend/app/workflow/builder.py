"""FullParams -> ComfyUI API prompt, replicating MiniMax_H3_Singularity_DualSampling_The_AI_Brief_EN.

Node ids match the original workflow so the graph can be diffed against
workflows/reference.api.json. Differences from the original, all value-preserving:
  - model/VAE/text-encoder/upscaler loaders take absolute paths (ShellMax*ByPath nodes
    delegating to the stock loaders);
  - rgthree "Lora Loader Stack" (118) becomes a chain of ShellMaxLoraLoaderByPath
    (model+clip, exactly what each stack slot does); nodes 127 -> 199 become a chain
    of ShellMaxLoraModelOnlyByPath;
  - easy-use "easy float" (198) is folded into the upscaler's scale value;
  - KJ Set/Get nodes do not exist in API form; references connect directly and
    contiguously (node 56 skips empty slots, so this keeps <Picture N> numbering);
  - reference videos load by path (VHS_LoadVideoPath) instead of from the input dir.
"""

from .graph_util import link as _link
from .params import FRAME_EXPRESSION, FPS, FullParams, LoraSpec

# stage names reported to the UI while a node executes
STAGE_BY_NODE = {
    "69": "load", "64": "load", "65": "load", "66": "load",
    "56": "encode",
    "108": "pass1",
    "138": "draft", "139": "draft", "135": "draft",
    "124": "upscale",
    "128": "pass2",
    "106": "final",
    "109": "decode", "110": "decode", "141": "decode",
}
DRAFT_OUTPUT_NODE = "135"
FINAL_OUTPUT_NODE = "141"
SAMPLER_NODES = ("108", "128", "106")


def _video_combine(images: list, audio: list, prefix: str, crf: int, save_output: bool) -> dict:
    return {
        "class_type": "VHS_VideoCombine",
        "inputs": {
            "images": images,
            "audio": audio,
            "frame_rate": FPS,
            "loop_count": 0,
            "filename_prefix": prefix,
            "format": "video/h264-mp4",
            "pix_fmt": "yuv420p",
            "crf": crf,
            "save_metadata": True,
            "trim_to_audio": False,
            "pingpong": False,
            "save_output": save_output,
        },
    }


def _active(loras: list[LoraSpec]) -> list[LoraSpec]:
    return [l for l in loras if l.enabled and l.path and l.strength != 0]


def build_prompt(p: FullParams) -> dict:
    x = p.expert
    g: dict[str, dict] = {}

    # ---------------------------------------------------------------- model chain
    g["69"] = {"class_type": "ShellMaxUNETLoaderByPath",
               "inputs": {"unet_path": p.unet, "weight_dtype": "default"}}
    g["70"] = {"class_type": "MiniMaxH3MemoryEfficientSageAttentionPatch",
               "inputs": {"model": _link("69")}}
    g["119"] = {"class_type": "ModelAttentionBackend",
                "inputs": {"model": _link("70"), "attention": "comfy kitchen attention"}}
    g["121"] = {"class_type": "BlockSparseAttention",
                "inputs": {"model": _link("119"),
                           "selection": "sol-attn",
                           "selection.tau": x.sparse_tau,
                           "start_percent": x.sparse_start,
                           "end_percent": x.sparse_end,
                           "dense_blocks": "",
                           "min_tokens": 12288,
                           "extra_tokens": 256,
                           "sink_conditioning": "exact_kv_and_rows",
                           "verbose": False}}
    model_src = _link("121")
    if p.low_vram:  # node 142 is bypassed in the original workflow
        g["142"] = {"class_type": "MiniMaxLowVRAMAttention",
                    "inputs": {"model": model_src, "head_chunks": x.low_vram_heads}}
        model_src = _link("142")
    g["143"] = {"class_type": "MiniMaxChunkFeedForward",
                "inputs": {"model": model_src, "chunks": x.chunk_ff_chunks,
                           "seq_threshold": x.chunk_ff_seq_threshold}}

    g["64"] = {"class_type": "ShellMaxCLIPLoaderByPath",
               "inputs": {"clip_path": p.text_encoder, "type": "minimax", "device": "default"}}
    g["65"] = {"class_type": "ShellMaxVAELoaderByPath", "inputs": {"vae_path": p.vae_video}}
    g["66"] = {"class_type": "ShellMaxVAELoaderByPath", "inputs": {"vae_path": p.vae_audio}}

    # 118: main LoRA stack (model + clip) -> used by both samplers of pass 1/2 and as base of 127
    model_main, clip_main = _link("143"), _link("64")
    for i, lora in enumerate(_active(p.loras_main)):
        nid = f"118_{i}"
        g[nid] = {"class_type": "ShellMaxLoraLoaderByPath",
                  "inputs": {"model": model_main, "clip": clip_main, "lora_path": lora.path,
                             "strength_model": lora.strength, "strength_clip": lora.strength}}
        model_main, clip_main = _link(nid, 0), _link(nid, 1)

    # 127 -> 199: model-only LoRAs used only by the final AV pass
    model_final = model_main
    for i, lora in enumerate(_active(p.loras_final)):
        nid = f"127_{i}"
        g[nid] = {"class_type": "ShellMaxLoraModelOnlyByPath",
                  "inputs": {"model": model_final, "lora_path": lora.path,
                             "strength_model": lora.strength}}
        model_final = _link(nid)

    # ---------------------------------------------------------------- conditioning
    g["84"] = {"class_type": "PrimitiveStringMultiline", "inputs": {"value": p.prompt}}
    g["74"] = {"class_type": "PrimitiveFloat", "inputs": {"value": float(p.duration)}}
    g["75"] = {"class_type": "ComfyMathExpression",
               "inputs": {"expression": FRAME_EXPRESSION, "values.a": _link("74")}}
    g["200"] = {"class_type": "ResolutionSelector",
                "inputs": {"aspect_ratio": p.aspect, "megapixels": p.megapixels, "multiple": 32}}

    ref_inputs: dict[str, list] = {}
    counters = {"image": 0, "video": 0, "audio": 0}
    for ref in p.refs:
        i = counters[ref.kind]
        counters[ref.kind] += 1
        if ref.kind == "image":
            nid = f"ref_image_{i}"
            g[nid] = {"class_type": "LoadImage", "inputs": {"image": ref.comfy_name}}
            ref_inputs[f"ref_images.ref_image_{i}"] = _link(nid)
        elif ref.kind == "video":
            nid = f"ref_video_{i}"
            g[nid] = {"class_type": "VHS_LoadVideoPath",
                      "inputs": {"video": ref.path, "force_rate": x.video_force_rate,
                                 "custom_width": 0, "custom_height": 0, "frame_load_cap": 0,
                                 "skip_first_frames": 0, "select_every_nth": 1,
                                 "format": "AnimateDiff"}}
            ref_inputs[f"ref_videos.ref_video_{i}"] = _link(nid, 0)
            if ref.with_audio:
                ref_inputs[f"ref_video_audios.ref_video_audio_{i}"] = _link(nid, 2)
        else:
            nid = f"ref_audio_{i}"
            g[nid] = {"class_type": "LoadAudio", "inputs": {"audio": ref.comfy_name}}
            ref_inputs[f"ref_audios.ref_audio_{i}"] = _link(nid)

    g["56"] = {"class_type": "MiniMaxH3ReferenceToVideo",
               "inputs": {"clip": clip_main, "vae": _link("65"), "audio_vae": _link("66"),
                          "prompt": _link("84"), "width": _link("200", 0), "height": _link("200", 1),
                          "length": _link("75", 1), "ref_image_size": x.ref_image_size,
                          **ref_inputs}}

    # ---------------------------------------------------------------- sampling
    g["57"] = {"class_type": "BasicGuider", "inputs": {"model": model_main, "conditioning": _link("56", 0)}}
    g["126"] = {"class_type": "BasicGuider", "inputs": {"model": model_final, "conditioning": _link("56", 0)}}
    g["63"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": p.seed}}
    g["114"] = {"class_type": "DisableNoise", "inputs": {}}
    g["58"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": x.sampler}}
    g["71"] = {"class_type": "BasicScheduler",
               "inputs": {"model": model_main, "scheduler": x.scheduler, "steps": x.steps, "denoise": 1}}
    g["94"] = {"class_type": "ExtendIntermediateSigmas",
               "inputs": {"sigmas": _link("71"), "steps": x.extend_steps,
                          "start_at_sigma": 1.0000000000000002, "end_at_sigma": 0, "spacing": "linear"}}
    g["99"] = {"class_type": "SplitSigmas", "inputs": {"sigmas": _link("94"), "step": x.split_step}}
    g["100"] = {"class_type": "SplitSigmas", "inputs": {"sigmas": _link("99", 1), "step": 0}}

    # pass 1
    g["108"] = {"class_type": "SamplerCustomAdvanced",
                "inputs": {"noise": _link("63"), "guider": _link("57"), "sampler": _link("58"),
                           "sigmas": _link("99", 0), "latent_image": _link("56", 1)}}
    g["102"] = {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": _link("108", 0)}}
    g["104"] = {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": _link("108", 1)}}

    # latent upscale + pass 2
    g["124"] = {"class_type": "ShellMaxLatentUpscalerByPath",
                "inputs": {"latent": _link("104", 0), "model_path": p.upscaler, "scale": p.upscale,
                           "align": 32, "device": "cuda", "precision": "fp16"}}
    g["128"] = {"class_type": "SamplerCustomAdvanced",
                "inputs": {"noise": _link("63"), "guider": _link("57"), "sampler": _link("58"),
                           "sigmas": _link("100", 0), "latent_image": _link("124")}}
    g["105"] = {"class_type": "LTXVConcatAVLatent",
                "inputs": {"video_latent": _link("128", 0), "audio_latent": _link("102", 1)}}

    # final AV pass
    g["106"] = {"class_type": "SamplerCustomAdvanced",
                "inputs": {"noise": _link("114"), "guider": _link("126"), "sampler": _link("58"),
                           "sigmas": _link("99", 1), "latent_image": _link("105")}}

    # ---------------------------------------------------------------- decode / output
    g["138"] = {"class_type": "VAEDecode", "inputs": {"samples": _link("108", 1), "vae": _link("65")}}
    g["139"] = {"class_type": "VAEDecodeAudio", "inputs": {"samples": _link("108", 0), "vae": _link("66")}}
    g["135"] = _video_combine(_link("138"), _link("139"), p.filename_prefix + "_draft", x.crf, False)

    g["109"] = {"class_type": "VAEDecode", "inputs": {"samples": _link("106", 1), "vae": _link("65")}}
    g["110"] = {"class_type": "VAEDecodeAudio", "inputs": {"samples": _link("106", 1), "vae": _link("66")}}
    g["141"] = _video_combine(_link("109"), _link("110"), p.filename_prefix, x.crf, True)
    return g
