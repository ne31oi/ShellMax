"""Adapt SAM 3's logits to the packed track format used by current core nodes."""

import torch


def run_object_mask(module, **inputs):
    from comfy_extras import nodes_sam3
    from comfy.ldm.sam3.tracker import pack_masks

    model = inputs["model"].model.diffusion_model
    original = model.forward_video
    had_override = "forward_video" in model.__dict__

    def forward_video(**kwargs):
        # SAM 3.1 can discover objects during tracking. SAM 3 needs a first-frame
        # seed, so a text-only selection is detected once before propagation.
        if kwargs.get("initial_masks") is None and not hasattr(model.tracker, "track_video_with_detection"):
            clip = inputs["clip"]
            conditioning = clip.encode_from_tokens_scheduled(clip.tokenize(inputs["text"]))
            frame = kwargs["images"][:1].movedim(1, -1)
            seed = nodes_sam3.SAM3_Detect.execute(model=inputs["model"], image=frame,
                conditioning=conditioning, threshold=inputs["threshold"],
                refine_iterations=2, individual_masks=False).result[0]
            if not seed.any():
                raise ValueError("SAM не нашёл объект на первом кадре. Укажите его зелёной точкой на подходящем кадре.")
            kwargs["initial_masks"] = seed.unsqueeze(1).to(device=kwargs["target_device"], dtype=kwargs["target_dtype"])
        result = original(**kwargs)
        if torch.is_tensor(result):
            return {"packed_masks": pack_masks(result).cpu(), "n_frames": result.shape[0], "scores": []}
        return result

    model.forward_video = forward_video
    try:
        return module.MiniMaxH3FantasticObjectMask().run(**inputs)
    finally:
        if had_override:
            model.forward_video = original
        else:
            del model.forward_video
