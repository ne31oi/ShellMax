"""Generation parameters.

UIParams   - the handful of decisions the user makes per generation (what the UI sends).
EngineProfile - the one-time "recipe": model paths, technical LoRAs, VRAM mode, expert values.
FullParams - everything the graph needs; UIParams + profile + quality preset expanded.
Both UIParams and FullParams are stored with every generation (edit & retry / exact replay).
"""

from typing import Literal

from pydantic import BaseModel, Field, field_validator

SCHEMA_VERSION = 1
FPS = 24

# workflow node 75 ("Frame Count Calculator"), verbatim
FRAME_EXPRESSION = "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17"

ASPECT_RATIOS: dict[str, tuple[int, int]] = {
    "1:1 (Square)": (1, 1),
    "2:3 (Portrait Photo)": (2, 3),
    "3:2 (Photo)": (3, 2),
    "3:4 (Portrait Standard)": (3, 4),
    "4:3 (Standard)": (4, 3),
    "9:16 (Portrait Widescreen)": (9, 16),
    "16:9 (Widescreen)": (16, 9),
    "21:9 (Ultrawide)": (21, 9),
}

MAX_REFS = {"image": 9, "video": 3, "audio": 3}


def clean_path(raw: str) -> str:
    """Paths pasted from Explorer's "Copy as path" come quoted."""
    return (raw or "").strip().strip('"').strip("'").strip()


class LoraSpec(BaseModel):
    path: str
    strength: float = 1.0
    enabled: bool = True

    @field_validator("path")
    @classmethod
    def _clean(cls, v: str) -> str:
        return clean_path(v)


class ExpertParams(BaseModel):
    """Workflow internals. Changing any of these departs from the original workflow."""

    steps: int = 6
    scheduler: str = "simple"
    sampler: str = "seeds_2"
    extend_steps: int = 2
    split_step: int = 2
    ref_image_size: Literal["match", "max"] = "match"
    sparse_tau: float = 1.3
    sparse_start: float = 0.2
    sparse_end: float = 0.9
    low_vram_heads: int = 4
    chunk_ff_chunks: int = 2
    chunk_ff_seq_threshold: int = 4096
    video_force_rate: float = 0
    crf: int = 19


class FaceRecipe(BaseModel):
    """MiniMax_H3_FaceRefine_Best internals. Model/LoRA paths are filled from config/defaults.json."""

    unet: str = ""
    lora: str = ""
    lora_strength: float = 1.0
    steps: int = 8  # must match the 8-step turbo LoRA
    sampler: str = "euler"
    scheduler: str = "simple"
    ref_image_size: Literal["match", "max"] = "max"
    # H3FaceTrackCrop (node 2)
    crop_factor: float = 2.2
    canvas: int = 768
    smooth_window: int = 21
    size_smooth_window: int = 51
    select: str = "largest_face"
    # H3PerFrameDenoise (node 31)
    face_px_small: int = 60
    face_px_large: int = 200
    # H3FaceStitch (node 22)
    mask_dilation: int = 24
    feather: int = 24
    colour_match: float = 1.0
    blend: float = 1.0
    crf: int = 16

    @field_validator("unet", "lora")
    @classmethod
    def _clean(cls, v: str) -> str:
        return clean_path(v)


class EngineProfile(BaseModel):
    name: str = "Singularity v1.3"
    unet: str
    text_encoder: str
    vae_video: str
    vae_audio: str
    upscaler: str
    loras_main: list[LoraSpec] = Field(default_factory=list)
    loras_final: list[LoraSpec] = Field(default_factory=list)
    low_vram: bool = False
    expert: ExpertParams = Field(default_factory=ExpertParams)
    face: FaceRecipe = Field(default_factory=FaceRecipe)

    @field_validator("unet", "text_encoder", "vae_video", "vae_audio", "upscaler")
    @classmethod
    def _clean(cls, v: str) -> str:
        return clean_path(v)


class RefSpec(BaseModel):
    kind: Literal["image", "video", "audio"]
    upload_id: str  # file in data/uploads
    with_audio: bool = False  # video refs only: feed the clip's soundtrack as well


class StyleSpec(BaseModel):
    style_id: int
    strength: float | None = None  # None -> style's default strength


class UIParams(BaseModel):
    prompt: str
    refs: list[RefSpec] = Field(default_factory=list)
    aspect: str = "16:9 (Widescreen)"
    duration: float = Field(2.0, ge=0.2, le=150)
    quality: str = "standard"
    styles: list[StyleSpec] = Field(default_factory=list)
    seed: int | None = None  # None -> random
    variants: int = Field(1, ge=1, le=8)
    profile_id: int | None = None

    @field_validator("aspect")
    @classmethod
    def _known_aspect(cls, v: str) -> str:
        if v not in ASPECT_RATIOS:
            raise ValueError(f"unknown aspect ratio {v!r}")
        return v

    @field_validator("refs")
    @classmethod
    def _ref_limits(cls, refs: list[RefSpec]) -> list[RefSpec]:
        for kind, limit in MAX_REFS.items():
            if sum(r.kind == kind for r in refs) > limit:
                raise ValueError(f"too many {kind} references (max {limit})")
        return refs


class ResolvedRef(BaseModel):
    kind: Literal["image", "video", "audio"]
    comfy_name: str = ""  # name in ComfyUI's input dir (images/audio, after upload)
    path: str = ""  # absolute path (videos are loaded by path)
    with_audio: bool = False


class FullParams(BaseModel):
    schema_version: int = SCHEMA_VERSION
    prompt: str
    refs: list[ResolvedRef] = Field(default_factory=list)
    aspect: str
    megapixels: float
    upscale: float
    duration: float
    seed: int
    unet: str
    text_encoder: str
    vae_video: str
    vae_audio: str
    upscaler: str
    loras_main: list[LoraSpec]
    loras_final: list[LoraSpec]
    low_vram: bool
    expert: ExpertParams
    filename_prefix: str = "ShellMax/gen"


class FaceUIParams(BaseModel):
    """Face refine decisions: which clip, whose face, the close-up crop, prompt and strength."""

    source_asset_id: int
    identity_upload_id: str  # <Picture 1>
    closeup_upload_id: str | None = None  # <Picture 2>; None -> same image as identity
    closeup_crop: dict[str, float] | None = None  # normalized {x, y, w, h}; None -> whole image
    prompt: str
    denoise: float = Field(0.35, ge=0.05, le=0.9)
    select: str | None = None  # which face when several are in frame; None -> recipe (largest_face)
    seed: int | None = None  # None -> workflow's 42
    profile_id: int | None = None


class FaceFullParams(BaseModel):
    schema_version: int = SCHEMA_VERSION
    source_path: str
    frame_load_cap: int = 0  # 0 = whole clip (already on the 17k+5 grid)
    force_rate: float = 0
    identity_image: str = ""  # ComfyUI input name (filled right before submit)
    closeup_image: str = ""
    identity_path: str = ""
    closeup_path: str = ""
    closeup_crop: str = ""  # LoadImageCrop JSON
    prompt: str
    denoise: float
    seed: int
    text_encoder: str
    vae_video: str
    vae_audio: str
    recipe: FaceRecipe
    filename_prefix: str = "ShellMax/face"


# ------------------------------------------------------------------ derived values


def frame_count(duration: float) -> int:
    """Same result as the workflow's ComfyMathExpression (node 75)."""
    n = max(5, round(duration * FPS))
    return n + (5 - n % 17) % 17


def base_resolution(aspect: str, megapixels: float, multiple: int = 32) -> tuple[int, int]:
    """Port of comfy_extras/nodes_resolution.py ResolutionSelector.execute."""
    import math

    w_ratio, h_ratio = ASPECT_RATIOS[aspect]
    scale = math.sqrt(megapixels * 1024 * 1024 / (w_ratio * h_ratio))
    return round(w_ratio * scale / multiple) * multiple, round(h_ratio * scale / multiple) * multiple


def upscaled_resolution(width: int, height: int, scale: float, align: int = 32) -> tuple[int, int]:
    """Port of MinimaxH3LatentUpscaler3D 'scale by multiplier' sizing (VAE downsample 16)."""
    down = 16
    w_in, h_in = width // down, height // down
    out = []
    for n in (w_in, h_in):
        aligned = round(n * down * scale / align) * align
        out.append(max(1, int(round(aligned / down) * down // down)) * down)
    return out[0], out[1]
