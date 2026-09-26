"""UIParams + engine profile + quality preset + styles -> FullParams."""

import random
from pathlib import Path

from .. import settings
from .params import (
    ASPECT_RATIOS,
    EngineProfile,
    FullParams,
    LoraSpec,
    ResolvedRef,
    UIParams,
    base_resolution,
    frame_count,
    upscaled_resolution,
)

MAX_SEED = 2**50  # RandomNoise accepts up to 2**64-1; keep seeds short enough to read


def quality_presets() -> dict[str, dict]:
    return settings.defaults()["quality_presets"]


def default_profile() -> EngineProfile:
    """Engine profile from config/defaults.json with paths resolved against the legacy models dir."""
    eng = dict(settings.defaults()["engine"])
    root = settings.legacy_models_dir()

    def resolve(rel: str) -> str:
        return str((root / rel).resolve()) if not Path(rel).is_absolute() else rel

    for key in ("unet", "text_encoder", "vae_video", "vae_audio", "upscaler"):
        eng[key] = resolve(eng[key])
    for key in ("loras_main", "loras_final"):
        eng[key] = [{**l, "path": resolve(l["path"])} for l in eng[key]]
    return EngineProfile(**eng)


def new_seed() -> int:
    return random.randint(1, MAX_SEED)


def resolution_for(aspect: str, quality: str) -> dict:
    q = quality_presets()[quality]
    w, h = base_resolution(aspect, q["megapixels"])
    fw, fh = upscaled_resolution(w, h, q["scale"])
    return {"base": [w, h], "final": [fw, fh]}


def with_style_triggers(prompt: str, triggers: list[str]) -> str:
    missing = [t for t in triggers if t and t.lower() not in prompt.lower()]
    if not missing:
        return prompt
    return prompt.rstrip() + "\n\n" + ", ".join(missing)


def expand(
    ui: UIParams,
    profile: EngineProfile,
    refs: list[ResolvedRef],
    styles: list[tuple[LoraSpec, list[str]]],
    seed: int,
    filename_prefix: str,
) -> FullParams:
    """styles: (lora, trigger words) for each selected style, already resolved from the library."""
    if ui.aspect not in ASPECT_RATIOS:
        raise ValueError(f"unknown aspect {ui.aspect!r}")
    presets = quality_presets()
    if ui.quality not in presets:
        raise ValueError(f"unknown quality preset {ui.quality!r}")
    q = presets[ui.quality]

    triggers = [t for _, trig in styles for t in trig]
    return FullParams(
        prompt=with_style_triggers(ui.prompt, triggers),
        refs=refs,
        aspect=ui.aspect,
        megapixels=q["megapixels"],
        upscale=q["scale"],
        duration=ui.duration,
        seed=seed,
        unet=profile.unet,
        text_encoder=profile.text_encoder,
        vae_video=profile.vae_video,
        vae_audio=profile.vae_audio,
        upscaler=profile.upscaler,
        loras_main=[*profile.loras_main, *(lora for lora, _ in styles)],
        loras_final=list(profile.loras_final),
        low_vram=profile.low_vram,
        expert=profile.expert,
        filename_prefix=filename_prefix,
    )


def work_units(full: FullParams) -> float:
    """Size of a job for time estimates: final pixels x frames."""
    w, h = base_resolution(full.aspect, full.megapixels)
    fw, fh = upscaled_resolution(w, h, full.upscale)
    return fw * fh * frame_count(full.duration)
