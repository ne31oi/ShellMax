"""Face refine (MiniMax_H3_FaceRefine_Best): defaults, close-up prompt, frame grid, face box."""

import json
import logging
import re
from pathlib import Path

from .. import settings
from .params import EngineProfile, FaceFullParams, FaceRecipe, FaceUIParams

log = logging.getLogger("shellmax.face")

WORKFLOW_SEED = 42  # node 17, "fixed"
YUNET_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
YUNET_PATH = settings.DATA_DIR / "models" / "yunet.onnx"

# section headers of the official 6-field Ref2VA prompt format
_SECTIONS = ("summary:", "retention_analysis:", "detailed_description:", "visual_style:",
             "overall_soundscape:", "non_diegetic_music:")


# ---------------------------------------------------------------- defaults
def strength_presets() -> list[dict]:
    return settings.defaults()["face_strength_presets"]


def with_face_defaults(profile: EngineProfile) -> EngineProfile:
    """Profiles saved before face refine existed have no model/LoRA paths for it yet."""
    face = profile.face
    if face.unet and face.lora:
        return profile
    d = settings.defaults()["face"]
    root = settings.legacy_models_dir()
    resolve = lambda rel: rel if Path(rel).is_absolute() else str((root / rel).resolve())  # noqa: E731
    patched = face.model_copy(update={
        "unet": face.unet or resolve(d["unet"]),
        "lora": face.lora or resolve(d["lora"]),
        "lora_strength": face.lora_strength if face.unet else d.get("lora_strength", 1.0),
    })
    return profile.model_copy(update={"face": patched})


# ---------------------------------------------------------------- frames
def grid_frames(n: int) -> int:
    """Largest H3 frame count (17k + 5) not above n."""
    if n < 5:
        return 0
    return n - ((n - 5) % 17)


def source_frames(duration: float | None, fps: float | None) -> tuple[int, float, int, list[str]]:
    """-> (frame_load_cap, force_rate, frames used, warnings) for VHS_LoadVideoPath."""
    warnings: list[str] = []
    fps = fps or 24.0
    force_rate = 0.0
    if abs(fps - 24.0) > 0.01:
        force_rate = 24.0  # the workflow writes 24 fps; resample so timing and audio stay in sync
        warnings.append(f"Клип {fps:.3g} fps будет приведён к 24 fps")
    total = round((duration or 0) * 24.0)
    used = grid_frames(total)
    if used == 0:
        warnings.append("Клип слишком короткий")
        return 0, force_rate, 0, warnings
    cap = 0 if used == total else used
    if cap:
        warnings.append(f"Будут обработаны первые {used} кадров из {total} (сетка H3: 17k+5)")
    return cap, force_rate, used, warnings


# ---------------------------------------------------------------- close-up prompt
def _identity_lines(source_prompt: str) -> list[str]:
    """Subject lines from the source prompt's subject_definitions block (environment lines dropped)."""
    text = source_prompt.replace("\r", "")
    m = re.search(r"subject_definitions:\s*\n(.*?)(?=\n\s*(?:" + "|".join(_SECTIONS) + r")|\Z)", text, re.S | re.I)
    if not m:
        return []
    lines = [l.strip() for l in m.group(1).split("\n")]
    return [l for l in lines if l and not l.startswith("<Environment")]


def closeup_prompt(source_prompt: str = "") -> str:
    """The workflow's close-up prompt structure with the appearance taken from the source clip.

    H3 sees the face cropped to fill the canvas, so the prompt must describe a close-up,
    not the original wide shot (note "Промпт" in the workflow).
    """
    identity = _identity_lines(source_prompt) or [
        "<Subject 1> is the exact person from <Picture 1>.",
        "<Picture 1> is the sole authoritative reference for <Subject 1>'s facial identity and appearance.",
    ]
    return "\n".join([
        "subject_definitions:",
        *identity,
        "<Picture 2> is a close-up crop of <Subject 1>'s face taken from <Picture 1>; use it for the exact eye "
        "shape, makeup, skin detail, nose and mouth.",
        "<Audio 1> is the exact sound of this shot. <Subject 1>'s mouth follows any speech in it with precise lip "
        "synchronization.",
        "",
        "summary:",
        "[reference generation + audio reference] A photorealistic, sharp close-up of the face and shoulders of "
        "<Subject 1>, exactly in sync with <Audio 1>.",
        "",
        "retention_analysis:",
        "<Subject 1>: fully_preserved - exact facial identity, facial structure, skin tone, eye shape and colour, "
        "makeup and hair are inherited from <Picture 1>.",
        "<Audio 1>: reference - exact spoken words and timing drive the lip movement.",
        "",
        "detailed_description:",
        "[Shot 1] A continuous living photorealistic close-up of <Subject 1>. The framing, head position, head size, "
        "head turn and all body and camera movement stay exactly as they already are in the footage; only the face "
        "gains real detail. The face is sharp and in focus: two natural eyes with moist catchlights (slight natural "
        "asymmetry is fine — not a perfect mirror), natural eyelids and lashes, a well-defined nose and a clearly "
        "readable mouth with natural teeth.",
        "Lips, jaw, cheeks and brows move naturally with <Audio 1> and the emotion of the speech; between phrases "
        "there are natural blinks and tiny micro-expression shifts — never a frozen mask. Facial structure and "
        "identity stay stable.",
        "Preserve facial identity, readable living eyes and mouth. No facial morphing, no duplicated features, no "
        "warping, no face blur, no plastic skin, no doll-like or mannequin face, no CGI wax skin, no frozen expression.",
        "",
        "visual_style:",
        "Real photographic footage of a living person. Natural skin microtexture with visible pores and subtle "
        "subsurface blood-tone variation (not matte CGI plastic), realistic tonal variation, individual hair strands "
        "and flyaways. Lighting matching the surrounding frame.",
        "",
        "overall_soundscape:",
        "Only the exact supplied sound from <Audio 1>.",
        "",
        "non_diegetic_music:",
        "N/A",
    ])


# ---------------------------------------------------------------- face box for the <Picture 2> close-up crop
def _yunet_path() -> Path | None:
    if YUNET_PATH.exists():
        return YUNET_PATH
    try:
        import httpx

        YUNET_PATH.parent.mkdir(parents=True, exist_ok=True)
        r = httpx.get(YUNET_URL, follow_redirects=True, timeout=30)
        r.raise_for_status()
        YUNET_PATH.write_bytes(r.content)
        return YUNET_PATH
    except Exception as e:  # noqa: BLE001 - offline: fall back to haar
        log.warning("YuNet face detector unavailable: %s", e)
        return None


def detect_face_box(image_path: str) -> dict | None:
    """Largest face as normalized box, or None. YuNet (robust to head turns), haar as fallback."""
    import cv2
    import numpy as np

    data = np.fromfile(image_path, dtype=np.uint8)  # cv2.imread fails on non-ASCII Windows paths
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        return None
    h, w = img.shape[:2]
    faces: list[tuple[float, float, float, float]] = []
    model = _yunet_path()
    if model:
        det = cv2.FaceDetectorYN.create(str(model), "", (w, h), 0.6)
        _, found = det.detect(img)
        if found is not None:
            faces = [(float(f[0]), float(f[1]), float(f[2]), float(f[3])) for f in found]
    if not faces:
        cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        faces = [tuple(map(float, f)) for f in cascade.detectMultiScale(gray, 1.1, 5, minSize=(max(24, min(w, h) // 12),) * 2)]
    if not faces:
        return None
    x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])
    return {"x": x / w, "y": y / h, "w": fw / w, "h": fh / h}


def closeup_crop_for(face: dict | None) -> dict:
    """Face box -> close-up crop like the workflow's (face + hairline, 1.5x wide, shifted up)."""
    if not face:
        return {"x": 0.25, "y": 0.05, "w": 0.5, "h": 0.5}  # typical portrait framing
    cx = face["x"] + face["w"] / 2
    w, h = face["w"] * 1.5, face["h"] * 1.15
    x, y = cx - w / 2, face["y"] - face["h"] * 0.15
    x, y = max(0.0, x), max(0.0, y)
    w, h = min(w, 1 - x), min(h, 1 - y)
    return {k: round(v, 4) for k, v in {"x": x, "y": y, "w": w, "h": h}.items()}


# ---------------------------------------------------------------- expand
def expand_face(ui: FaceUIParams, profile: EngineProfile, source_path: str, frame_cap: int, force_rate: float,
                identity_path: str, closeup_path: str, seed: int, filename_prefix: str) -> FaceFullParams:
    profile = with_face_defaults(profile)
    return FaceFullParams(
        source_path=source_path, frame_load_cap=frame_cap, force_rate=force_rate,
        identity_path=identity_path, closeup_path=closeup_path,
        closeup_crop=json.dumps(ui.closeup_crop) if ui.closeup_crop else "",
        prompt=ui.prompt, denoise=ui.denoise, seed=seed,
        text_encoder=profile.text_encoder, vae_video=profile.vae_video, vae_audio=profile.vae_audio,
        recipe=profile.face.model_copy(update={"select": ui.select}) if ui.select else profile.face,
        filename_prefix=filename_prefix,
    )


def face_work_units(recipe: FaceRecipe, frames: int) -> float:
    return recipe.canvas * recipe.canvas * max(frames, 1)
