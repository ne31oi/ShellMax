"""Versioned pose-guided replacement with separate costume and identity references."""
import json
import math
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from .. import settings
from .fantastic import MediaSource
from .model_paths import resolve_models
from .head_swap import composite_dir, missing_composite
from .face import YUNET_PATH

FPS = 24
MAX_FRAMES = 175  # Last 17k+5 point inside the author's 180-frame cap.
BodySwapVariant = Literal["ref2va", "singularity"]
KINDS = {"ref2va": "body_swap", "singularity": "body_swap_singularity"}


class BodySwapUI(BaseModel):
    variant: BodySwapVariant = "ref2va"
    source_asset_id: int
    front_upload_id: str
    side_upload_id: str
    start: float = Field(default=0, ge=0, allow_inf_nan=False)
    end: float = Field(gt=0, allow_inf_nan=False)
    subject: str = Field(default="person", min_length=1, max_length=160)
    description: str = Field(default="", max_length=4000)
    seed: int | None = Field(default=None, ge=0, le=0xffffffffffffffff)

    @model_validator(mode="after")
    def valid_fragment(self):
        if self.end <= self.start:
            raise ValueError("Конец фрагмента должен быть позже начала")
        if not self.subject.strip():
            raise ValueError("Укажите, какого персонажа заменить")
        return self


class BodySwapFull(BaseModel):
    recipe_version: Literal[1, 2, 3, 4, 5, 6] = 1
    variant: BodySwapVariant = "ref2va"
    source_path: str
    sources: list[MediaSource] = Field(min_length=2, max_length=2)
    models: dict[str, str]
    start: float
    end: float
    frames: int = Field(ge=5, le=MAX_FRAMES)
    subject: str
    prompt: str
    seed: int
    has_audio: bool
    composite_weights_dir: str = ""  # Historical recipes do not use the background worker.
    face_detector_path: str = ""  # Added with source head/lighting registration in recipe 6.
    filename_prefix: str = "ShellMax/body_swap"


def fragment_frames(duration: float) -> int:
    count = math.floor(duration * FPS + 1e-6)
    return 0 if count < 5 else min(MAX_FRAMES, 5 + (count - 5) // 17 * 17)


def manifest() -> dict:
    return json.loads((settings.CONFIG_DIR / "body-swap-models.json").read_text(encoding="utf-8"))


def model_paths(variant: BodySwapVariant = "ref2va"):
    recipe = settings.defaults()["body_swap"]
    models = dict(recipe["models"])
    if variant == "singularity":
        models["unet"] = recipe["singularity_unet"]
    return resolve_models(models)


def missing_models(variant: BodySwapVariant = "ref2va") -> list[str]:
    pinned = manifest()
    return [path.name for key, path in model_paths(variant).items()
            if not path.is_file() or (key in pinned and not (key == "unet" and variant == "singularity")
                                     and path.stat().st_size != pinned[key]["size"])] + missing_composite() + ([] if YUNET_PATH.is_file() else ["yunet.onnx"])


def replacement_prompt(description: str, duration: float = 0, has_audio: bool = False) -> str:
    sound = "Preserve the source sound and dialogue timing." if has_audio else "Silence."
    timing = f" The shot lasts {duration:.3f} seconds." if duration else ""
    return ('id="shellmax_full_character_swap"\n\n'
        "subject_definitions:\n"
        "<Subject 1>: one living, photorealistic person with the facial identity, hair, skin and distinctive facial "
        "details from <Picture 2>, wearing the exact costume and body proportions from <Picture 1>. "
        "The costume reference supplies clothing; the portrait supplies the visible face and hair. "
        "<Environment>: the existing source scene, with its original framing, perspective, exposure and light direction.\n\n"
        "summary:\n"
        "<Subject 1> replaces the entire source performer and repeats their pose and continuous performance "
        "from the first to the last frame, dressed in the reference costume." + timing + "\n\n"
        "retention_analysis:\n"
        "<Picture 1> -> <Subject 1>: attribute_transfer, costume and body proportions only. "
        "<Picture 2> -> <Subject 1>: partially_preserved, facial identity, hair and facial details; lighting adapts to the scene.\n\n"
        "detailed_description:\n"
        "[Shot 1] <Subject 1> occupies the source performer's position at the same scale and camera angle. "
        "Follow the supplied body pose sequence frame by frame, retaining shoulder, elbow, wrist and hand placement "
        "and performance timing. Regenerate the entire person, including hands, with connected arms and coherent skin tone. "
        "Keep the face and hair from <Picture 2> consistent throughout the shot. "
        "The costume has realistic texture, seams, folds and volume over a living body, responding to each gesture. "
        "Match the source light direction, exposure, color cast and shadow placement on skin and clothing. "
        "The reference studio backgrounds and lighting do not enter the scene. "
        "The camera follows its original movement and framing; preserve the existing background and occlusions. "
        "End at the source's final pose with the same new identity and costume. " + description.strip() + "\n\n"
        "overall_soundscape:\n" + sound + "\n\nnon_diegetic_music:\nN/A.\n")
