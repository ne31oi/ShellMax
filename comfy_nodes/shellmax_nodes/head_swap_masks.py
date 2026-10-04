"""Head silhouettes on both sides of a swap; never paste the context rectangle."""
import importlib
import sys

import nodes
import torch


def grow_mask(mask, radius):
    if not radius:
        return mask
    # A square dilation is separable; avoid quadratic work for fine hair margins.
    size = 2 * radius + 1
    result = torch.nn.functional.max_pool2d(mask[:, None], (1, size), 1, (0, radius))
    return torch.nn.functional.max_pool2d(result, (size, 1), 1, (radius, 0))[:, 0]


def paste_mask(source, replacement, protect, allowed, edge_grow=24):
    usable = source.flatten(1).any(dim=1) & replacement.flatten(1).any(dim=1) & allowed
    # Cover the soft edge of the old silhouette before subtracting foreground arms.
    union = grow_mask(torch.maximum(source, replacement), edge_grow)
    return union * (1 - protect.clamp(0, 1)) * usable[:, None, None]


def blend_head_background(source, refined, masks):
    """Match the pasted head and vacated hair to the original surrounding pixels."""
    import cv2
    import numpy as np
    import comfy.model_management as mm

    result = source.clone()
    for i, matte in enumerate(masks):
        mm.throw_exception_if_processing_interrupted()
        mask = (matte.numpy() * 255).astype(np.uint8)
        mask[[0, -1], :] = 0
        mask[:, [0, -1]] = 0
        x, y, w, h = cv2.boundingRect(mask)
        if w < 3 or h < 3:
            continue
        donor = (refined[i].detach().cpu().clamp(0, 1).numpy() * 255).astype(np.uint8)
        base = (source[i].detach().cpu().clamp(0, 1).numpy() * 255).astype(np.uint8)
        blended = cv2.seamlessClone(donor, base, mask, (x + w // 2, y + h // 2), cv2.NORMAL_CLONE)
        result[i] = torch.from_numpy(blended).to(device=result.device, dtype=result.dtype) / 255
    return result


def erase_generated_foreground(refined, source_protect, generated_protect, heads, edge_grow):
    """Remove a displaced generated limb only where it would enter the head paste."""
    import cv2
    import numpy as np
    import comfy.model_management as mm

    ghosts = grow_mask(generated_protect, 2) * (1 - grow_mask(source_protect, 2)) * grow_mask(heads, edge_grow)
    result = refined.clone()
    for i, ghost in enumerate(ghosts):
        mm.throw_exception_if_processing_interrupted()
        if not ghost.any():
            continue
        frame = (refined[i].detach().cpu().clamp(0, 1).numpy() * 255).astype(np.uint8)
        mask = (ghost.numpy() * 255).astype(np.uint8)
        repaired = cv2.inpaint(frame, mask, 3, cv2.INPAINT_TELEA)
        result[i] = torch.from_numpy(repaired).to(device=result.device, dtype=result.dtype) / 255
    return result


def clean_replacement_mask(masks):
    import cv2
    import numpy as np

    result = masks.clone()
    for i, matte in enumerate(masks):
        count, labels, stats, _ = cv2.connectedComponentsWithStats(matte.numpy().astype(np.uint8), 8)
        if count > 1:
            main = 1 + stats[1:, cv2.CC_STAT_AREA].argmax()
            result[i] = torch.from_numpy((labels == main).astype(np.float32))
    return result


def repair_vacated_background(refined, original_masks, replacement_masks, protect, person_masks, edge_grow):
    """Neither the old hair nor its faint generated echo belongs outside the new head."""
    import cv2
    import numpy as np
    import comfy.model_management as mm

    context = grow_mask(torch.maximum(original_masks, replacement_masks), edge_grow)
    # Keep clothing, neck and the new head out of background reconstruction.
    subject = grow_mask(torch.maximum(person_masks, replacement_masks), 6)
    vacancy = context * (1 - subject) * (1 - grow_mask(protect, 1))
    result = refined.clone()
    for i, matte in enumerate(vacancy):
        mm.throw_exception_if_processing_interrupted()
        if not matte.any():
            continue
        frame = (refined[i].detach().cpu().clamp(0, 1).numpy() * 255).astype(np.uint8)
        mask = (matte.numpy() * 255).astype(np.uint8)
        repaired = cv2.inpaint(frame, mask, 7, cv2.INPAINT_TELEA)
        patch = torch.from_numpy(repaired).to(device=result.device, dtype=result.dtype) / 255
        result[i] = torch.where(matte.to(result.device)[..., None] > 0, patch, refined[i])
    return result


class ShellMaxH3HeadSwapMasks:
    detect_generated_foreground = True
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "source_crops": ("IMAGE",), "refined_crops": ("IMAGE",),
            "transform": ("H3FACEXFORM",), "selection_masks": ("MASK",),
            "model": ("MODEL",), "clip": ("CLIP",),
            "tracking_report": ("STRING", {"forceInput": True}),
            "threshold": ("FLOAT", {"default": 0.3, "min": 0.05, "max": 0.95}),
            "edge_grow": ("INT", {"default": 24, "min": 0, "max": 64}),
        }, "optional": {"full_frame_result": ("IMAGE",)}}

    RETURN_TYPES = ("MASK", "IMAGE", "STRING", "MASK")
    RETURN_NAMES = ("head_masks", "refined_crops", "report", "source_foreground")
    FUNCTION = "mask"
    CATEGORY = "ShellMax/head swap"

    def segment(self, source_crops, refined_crops, transform, selection_masks, model, clip,
             tracking_report, threshold, edge_grow=24, full_frame_result=None):
        from comfy_extras import nodes_sam3 as sam
        import comfy.model_management as mm

        # Reuse the same SAM 3 compatibility adapter as the existing object-mask jobs.
        package = sys.modules[nodes.NODE_CLASS_MAPPINGS["ShellMaxH3ObjectMask"].__module__].__package__
        compat = importlib.import_module(package + ".sam_compat")
        count, height, width, _ = source_crops.shape
        if full_frame_result is not None:
            # Re-composite an existing result without spending another H3 sampling pass.
            module = sys.modules[nodes.NODE_CLASS_MAPPINGS["H3FaceTrackCrop"].__module__]
            refined_crops = torch.cat([module._affine_crop(full_frame_result[i:i + 1], box, width, height)
                for i, box in zip(transform["source"], transform["boxes"])])
        if refined_crops.shape != source_crops.shape or len(selection_masks) != count:
            raise ValueError("Head Swap: кадры результата и исходной головы не совпадают")

        allowed = selection_masks.flatten(1).any(dim=1).cpu()
        head_cond = clip.encode_from_tokens_scheduled(clip.tokenize("head"))
        hair_cond = clip.encode_from_tokens_scheduled(clip.tokenize("hair"))
        source_masks = torch.zeros((count, height, width))
        new_masks = torch.zeros_like(source_masks)

        def seed(images, frame):
            found = sam.SAM3_Detect.execute(model=model, image=images[frame:frame + 1],
                conditioning=head_cond, threshold=threshold, refine_iterations=2, individual_masks=True).result[0].cpu()
            x, y, w, h = transform["face_rect"][frame]
            x0, y0 = max(0, int(x)), max(0, int(y))
            x1, y1 = min(width, int(x + w)), min(height, int(y + h))
            if not len(found) or x1 <= x0 or y1 <= y0:
                return None
            # A text prompt may find a neighbour too; only the tracked face chooses the head.
            scores = found[:, y0:y1, x0:x1].mean(dim=(1, 2))
            best = int(scores.argmax())
            if scores[best] < 0.35:
                return None
            selected = found[best:best + 1]
            hair = sam.SAM3_Detect.execute(model=model, image=images[frame:frame + 1],
                conditioning=hair_cond, threshold=threshold, refine_iterations=2, individual_masks=True).result[0].cpu()
            if len(hair):
                # Only hair connected to the selected head can enlarge its silhouette.
                touching = (hair * selected).flatten(1).sum(1) > 0.1 * hair.flatten(1).sum(1)
                if touching.any():
                    selected = torch.maximum(selected, hair[touching].amax(0, keepdim=True))
            return selected

        def track(images, initial):
            with compat.sam_video_compat(model):
                data = sam.SAM3_VideoTrack.execute(images=images, model=model, initial_mask=initial,
                    max_objects=1).result[0]
                return sam.SAM3_TrackToMask.execute(track_data=data, object_indices="").result[0].cpu()

        for start, end in transform.get("segments") or [(0, count)]:
            mm.throw_exception_if_processing_interrupted()
            first = next((i for i in range(start, end) if allowed[i]), None)
            if first is None:
                continue
            original, replacement = seed(source_crops, first), seed(refined_crops, first)
            # No rectangular fallback: it is precisely what caused the reported seam.
            if original is None or replacement is None:
                continue
            for images, initial, result in ((source_crops, original, source_masks), (refined_crops, replacement, new_masks)):
                result[first:end] = track(images[first:end], initial)
                if first > start:
                    result[start:first] = track(images[start:first + 1].flip(0), initial).flip(0)[:-1]

        # The union erases the OLD hair silhouette and keeps the NEW one intact.
        # SAM's source arm/hand masks keep foreground occluders in front of that union.
        new_masks = clean_replacement_mask(new_masks)
        heads = torch.maximum(source_masks, new_masks)
        protect = torch.zeros_like(heads)
        generated_protect = torch.zeros_like(heads)
        for text in ("hand", "arm"):
            cond = clip.encode_from_tokens_scheduled(clip.tokenize(text))
            streams = [(source_crops, protect)]
            if self.detect_generated_foreground:
                streams.append((refined_crops, generated_protect))
            for images, result in streams:
                for start in range(0, count, 8):
                    mm.throw_exception_if_processing_interrupted()
                    result[start:start + 8] = torch.maximum(result[start:start + 8],
                        sam.SAM3_Detect.execute(model=model, image=images[start:start + 8],
                            conditioning=cond, threshold=threshold, refine_iterations=1, individual_masks=False).result[0].cpu())
        return source_masks, new_masks, protect, generated_protect, refined_crops, allowed

    def mask(self, source_crops, refined_crops, transform, selection_masks, model, clip,
             tracking_report, threshold, edge_grow=24, full_frame_result=None):
        from comfy_extras import nodes_sam3 as sam
        import comfy.model_management as mm

        source_masks, new_masks, protect, generated_protect, refined_crops, allowed = self.segment(
            source_crops, refined_crops, transform, selection_masks, model, clip,
            tracking_report, threshold, edge_grow, full_frame_result)
        count = len(source_masks)
        heads = torch.maximum(source_masks, new_masks)
        refined_crops = erase_generated_foreground(refined_crops, protect, generated_protect, heads, edge_grow)
        person_masks = torch.zeros_like(heads)
        person_cond = clip.encode_from_tokens_scheduled(clip.tokenize("person"))
        for start in range(0, count, 8):
            mm.throw_exception_if_processing_interrupted()
            person_masks[start:start + 8] = sam.SAM3_Detect.execute(model=model,
                image=refined_crops[start:start + 8], conditioning=person_cond,
                threshold=threshold, refine_iterations=1, individual_masks=False).result[0].cpu()
        refined_crops = repair_vacated_background(refined_crops, source_masks, new_masks, protect, person_masks, edge_grow)
        masks = paste_mask(source_masks, new_masks, protect, allowed, edge_grow)
        refined_crops = blend_head_background(source_crops, refined_crops, masks)
        hit = int(masks.flatten(1).any(dim=1).sum())
        if not hit:
            raise ValueError("SAM не выделил обе головы — выберите кадр с хорошо видимым лицом и волосами")
        report = tracking_report + f"\nHead silhouettes: {hit}/{count}; old/new union, displaced generated limbs removed, source hands restored after feather; local background blend; no rectangle fallback."
        print("[ShellMax Head Swap] " + report.splitlines()[-1])
        return masks, refined_crops, report, protect


NODE_CLASS_MAPPINGS = {"ShellMaxH3HeadSwapMasks": ShellMaxH3HeadSwapMasks}
