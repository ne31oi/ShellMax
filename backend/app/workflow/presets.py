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
from .quality import quality_presets  # noqa: F401 — re-exported for callers / tests
from .look import apply_look

MAX_SEED = 2**50  # RandomNoise accepts up to 2**64-1; keep seeds short enough to read


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


# Trigger words of the engine's technical LoRAs, by file name. The workflow's prompt (node 84) carries
# "visual_style: r34l1sm." because node 199 loads h3-realism-people; a prompt written here must too.
LORA_TRIGGERS = {"h3-realism-people-t2v-i2v-r2v": "r34l1sm"}


def lora_triggers(profile: EngineProfile) -> list[str]:
    out = []
    for lora in [*profile.loras_main, *profile.loras_final]:
        stem = lora.path.replace("\\", "/").rsplit("/", 1)[-1].rsplit(".", 1)[0]
        if lora.enabled and lora.strength and (t := LORA_TRIGGERS.get(stem)) and t not in out:
            out.append(t)
    return out


def with_lora_triggers(prompt: str, triggers: list[str]) -> str:
    """Put each missing trigger first in visual_style (created before overall_soundscape if absent)."""
    missing = [t for t in triggers if t.lower() not in prompt.lower()]
    if not missing:
        return prompt
    words = " ".join(f"{t}." for t in missing)
    lines = prompt.splitlines()
    heads = {l.strip().lower(): i for i, l in reversed(list(enumerate(lines)))}
    if (i := heads.get("visual_style:")) is not None:
        at = i + 2 if i + 1 < len(lines) and not lines[i + 1].strip() else i + 1
        lines[at:at] = [words, ""] if at == i + 2 else [words]
    elif (i := heads.get("overall_soundscape:")) is not None:
        lines[i:i] = ["visual_style:", "", words, ""]
    else:
        return prompt.rstrip() + "\n\n" + words
    return "\n".join(lines)


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
    prompt_text = with_lora_triggers(with_style_triggers(ui.prompt, triggers), lora_triggers(profile))
    prompt_text = apply_look(prompt_text, getattr(ui, "look", None))
    return FullParams(
        prompt=prompt_text,
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
