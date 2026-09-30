"""One Euler step through native ComfyUI using the checkpoint's own components.

Video-only LTXAV disables audio cross attention. Ordinary LTX 2.5 weights cannot
replace this checkpoint's diffusion VAE, connectors or Gemma encoder.
"""
import math
from .progress import stage_progress


def refine(paths, frames, fps, prompt, width, height, seed, bar):
    import torch
    import comfy.model_management as mm
    import comfy.utils
    import comfy.sd
    import comfy.sample
    import comfy.samplers
    import node_helpers
    from comfy_extras.nodes_lt_upsampler import LTXVLatentUpsampler
    from safetensors import safe_open

    def report(value):
        mm.throw_exception_if_processing_interrupted()
        bar.update_absolute(value, 100)

    report(1)
    clip = comfy.sd.load_clip([str(paths["text_encoder"])], clip_type=comfy.sd.CLIPType.LTXV)
    report(10)
    positive = clip.encode_from_tokens_scheduled(clip.tokenize(prompt))
    mm.unload_all_models()
    del clip
    report(20)
    state, metadata = comfy.utils.load_torch_file(str(paths["vae"]), safe_load=True, return_metadata=True)
    vae = comfy.sd.VAE(sd=state, metadata=metadata)
    del state
    canvas_w, canvas_h = math.ceil(width / 64) * 64, math.ceil(height / 64) * 64
    pixels = torch.nn.functional.interpolate(frames.movedim(-1, 1), size=(canvas_h // 2, canvas_w // 2),
                                             mode="bilinear", align_corners=False, antialias=True).movedim(1, -1)
    with stage_progress(comfy.utils, bar, 20, 35):
        latent = {"samples": vae.encode(pixels)}
    del pixels
    report(35)
    with safe_open(str(paths["upsampler"]), framework="pt", device="cpu") as checkpoint:
        up_metadata = checkpoint.metadata()
        up_state = {key: checkpoint.get_tensor(key) for key in checkpoint.keys()}
    import json
    import comfy.ops
    import comfy.model_patcher
    from comfy.ldm.lightricks.latent_upsampler import LatentUpsampler
    up = LatentUpsampler.from_config(json.loads(up_metadata["config"]), operations=comfy.ops.disable_weight_init)
    up = up.to(dtype=mm.vae_dtype(allowed_dtypes=[torch.bfloat16, torch.float32]))
    mm.archive_model_dtypes(up)
    upsampler = comfy.model_patcher.CoreModelPatcher(up, load_device=mm.get_torch_device(), offload_device=mm.unet_offload_device())
    up.load_state_dict(up_state, assign=upsampler.is_dynamic())
    del up_state
    latent = LTXVLatentUpsampler.execute(latent, upsampler, vae)[0]["samples"]
    mm.unload_all_models()
    del upsampler, up
    report(45)
    model = comfy.sd.load_diffusion_model(str(paths["transformer"]))
    positive = node_helpers.conditioning_set_values(positive, {"frame_rate": float(fps)})
    noise = torch.randn(latent.shape, generator=torch.Generator("cpu").manual_seed(seed), dtype=latent.dtype)
    report(50)
    result = comfy.sample.sample_custom(model, noise, 1.0, comfy.samplers.sampler_object("euler"),
                                       torch.tensor([0.9093750119, 0.0]), positive, positive, latent, seed=seed)
    mm.unload_all_models()
    del model
    report(75)
    with stage_progress(comfy.utils, bar, 75, 95):
        result = vae.decode_tiled(result, tile_x=16, tile_y=16, overlap=4, tile_t=5, overlap_t=1)
    if result.ndim == 5:
        result = result[0]
    top, left = (canvas_h - height) // 2, (canvas_w - width) // 2
    report(95)
    return result[:, top:top + height, left:left + width]
