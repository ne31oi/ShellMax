"""Adapt the installed face tracker to an explicit source head and its paste region."""
import json
import sys
from pathlib import Path

import folder_paths
import nodes
import torch

from .head_swap_geometry import head_region, region_in_canvas, required_crop_factor, select_face


class ShellMaxH3HeadSwapTrack:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",), "target": ("STRING", {"multiline": False}),
            "detector": ("STRING", {"default": "bbox\\face_yolov8m.pt"}),
            "confidence": ("FLOAT", {"default": 0.35, "min": 0.05, "max": 0.95}),
            "identity_threshold": ("FLOAT", {"default": 0.28, "min": 0.0, "max": 1.0}),
            "canvas": ("INT", {"default": 0, "min": 0, "max": 1344, "step": 32}),
            "crop_factor": ("FLOAT", {"default": 3.0, "min": 1.2, "max": 8.0}),
            "smooth_window": ("INT", {"default": 5, "min": 1}),
            "size_smooth_window": ("INT", {"default": 9, "min": 1}),
        }}

    RETURN_TYPES = ("IMAGE", "H3FACEXFORM", "IMAGE", "STRING", "INT", "INT", "INT", "MASK")
    RETURN_NAMES = ("crops", "transform", "preview", "report", "width", "height", "length", "head_masks")
    FUNCTION = "track"
    CATEGORY = "ShellMax/head swap"

    def track(self, images, target, detector, confidence, identity_threshold, canvas, crop_factor, smooth_window, size_smooth_window):
        selection = json.loads(target)
        frame = int(selection["frame_index"])
        count, height, width, _ = images.shape
        if not 0 <= frame < count:
            raise ValueError("Кадр выбора головы находится за пределами видео")
        box = selection["box"]
        region = box["x"] * width, box["y"] * height, box["w"] * width, box["h"] * height
        cls = nodes.NODE_CLASS_MAPPINGS["H3FaceTrackCrop"]
        module = sys.modules[cls.__module__]
        model = module._load_detector(detector)
        result = model.predict(module._to_bgr_u8(images[frame]), conf=confidence, verbose=False)[0]
        face = select_face(result.boxes.xyxy.tolist(), region)
        factor = required_crop_factor(region, face, crop_factor)

        # InsightFace otherwise silently downloads buffalo_l. Reuse only installed weights.
        identity_dir = Path(folder_paths.models_dir) / "insightface/models/buffalo_l"
        if not all((identity_dir / name).is_file() for name in ("det_10g.onnx", "w600k_r50.onnx")):
            raise ValueError("Для выбора человека нужен уже установленный buffalo_l — проверьте установку движка")
        embedder = module._make_embedder("insightface", None)
        source_identity = module._ident_crop(images[frame:frame + 1], face)
        anchor = embedder.embed_reference(source_identity, model, confidence)
        if anchor is None:
            raise ValueError("Не удалось распознать выбранное лицо — выберите более чёткий кадр с видимым лицом")
        tracked = cls().run(images=images, detector=detector, confidence=confidence,
            crop_factor=factor, canvas_width=canvas or 512, canvas_height=canvas or 512,
            canvas_mode="manual" if canvas else "auto_capped_768",
            smooth_window=smooth_window, size_smooth_window=size_smooth_window,
            smooth_method="gaussian", size_mode="per_frame", select="closest_to_xy",
            X=round((face[0] + face[2]) / 2), Y=round((face[1] + face[3]) / 2), frame_index=frame,
            select_index=0, identity_track=True, identity_model="insightface", identity_threshold=identity_threshold,
            identity_reference=source_identity, fallback_detector="none",
            cut_detection="auto (pyscenedetect)", absent_shots="off")
        crops, transform, preview, report, cw, ch, length = tracked
        relative = head_region(region, face)
        yy = torch.arange(ch, device=crops.device).view(ch, 1) + 0.5
        xx = torch.arange(cw, device=crops.device).view(1, cw) + 0.5
        masks = []
        import comfy.model_management as mm
        accepted = 0
        for i, (rect, detected) in enumerate(zip(transform["face_rect"], transform["detected"])):
            mm.throw_exception_if_processing_interrupted()
            # Check every crop against the selected ORIGINAL identity, including after cuts.
            # A continuity tracker alone can follow a neighbour when the subject disappears.
            candidate = embedder.embed_reference(crops[i:i + 1], model, confidence) if detected else None
            same_person = candidate is not None and float(candidate @ anchor) >= identity_threshold
            x, y, w, h = region_in_canvas(relative, rect)
            mask = (xx >= x) & (xx < x + w) & (yy >= y) & (yy < y + h)
            masks.append(mask.to(crops.dtype) if same_person else torch.zeros((ch, cw), device=crops.device, dtype=crops.dtype))
            accepted += int(same_person)
        if not accepted:
            raise ValueError("Трекер не удержал выбранного человека — выберите другой кадр и уточните рамку головы")
        # Unresolved frames get zero masks instead of guessing a different person's head.
        masks = torch.stack(masks)
        report = f"Head Swap source selection: frame {frame}, box {box}; identity accepted {accepted}/{length}\n" + report
        return crops, transform, preview, report, cw, ch, length, masks


NODE_CLASS_MAPPINGS = {"ShellMaxH3HeadSwapTrack": ShellMaxH3HeadSwapTrack}
