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
from .light import apply_light

MAX_SEED = 2**50  # RandomNoise accepts up to 2**64-1; keep seeds short enough to read

# Former engine-recipe LoRA; now a chip «Стиль». Stays on the final chain (workflow node 199).
REALISM_STEM = "h3-realism-people-t2v-i2v-r2v"
REALISM_REL = "loras/minimax_h3/h3-realism-people-t2v-i2v-r2v.safetensors"
REALISM_TRIGGER = "r34l1sm"
REALISM_STYLE_NAME = "Realism people"


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


def realism_lora_path() -> str:
    return str((settings.legacy_models_dir() / REALISM_REL).resolve())


def new_seed() -> int:
    return random.randint(1, MAX_SEED)


def resolution_for(aspect: str, quality: str) -> dict:
    q = quality_presets()[quality]
    w, h = base_resolution(aspect, q["megapixels"])
    fw, fh = upscaled_resolution(w, h, q["scale"])
    return {"base": [w, h], "final": [fw, fh]}


def _lora_stem(path: str) -> str:
    return path.replace("\\", "/").rsplit("/", 1)[-1].rsplit(".", 1)[0]


def is_realism_lora(path: str) -> bool:
    return _lora_stem(path) == REALISM_STEM


def _all_style_triggers() -> list[str]:
    """Every trigger word registered in the style library (for scrubbing inactive slogans)."""
    try:
        from ..db.models import StyleLora, select, session
        with session() as s:
            rows = s.exec(select(StyleLora)).all()
        out: list[str] = []
        for row in rows:
            for t in row.triggers or []:
                if isinstance(t, str) and t.strip():
                    out.append(t.strip())
        return out
    except Exception:  # noqa: BLE001 — expand must not fail if DB is mid-migration
        return [REALISM_TRIGGER]


def with_lora_triggers(prompt: str, triggers: list[str]) -> str:
    """Put each missing trigger first in visual_style (created before overall_soundscape if absent)."""
    missing = [t for t in triggers if t and t.lower() not in prompt.lower()]
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


def scrub_style_triggers(prompt: str, keep: list[str], catalog: list[str]) -> str:
    """Remove LoRA trigger slogans from prose unless they are in `keep` (active style chip).

    The assistant often copies library triggers (e.g. «80s Fantasy Movie Still») into
    detailed_description; H3 then follows that look even when the LoRA chip is off.
    """
    import re

    keep_l = {t.strip().lower() for t in keep if t and t.strip()}
    victims = sorted(
        {t.strip() for t in catalog if t and t.strip() and t.strip().lower() not in keep_l},
        key=len,
        reverse=True,
    )
    out = prompt
    for t in victims:
        out = re.sub(re.escape(t), "", out, flags=re.IGNORECASE)
    # Collapse leftover “in a  style” / double spaces from removals.
    out = re.sub(r"\bin an?\s+style\b", "", out, flags=re.IGNORECASE)
    out = re.sub(r"\bin a\s+style\b", "", out, flags=re.IGNORECASE)
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r" +([.,;:])", r"\1", out)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out


# Back-compat alias: style triggers used to be dumped at the end of the prompt (ignored by H3).
with_style_triggers = with_lora_triggers


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

    style_triggers = [t for _, trig in styles for t in trig]
    # Drop slogans of styles that are not selected (assistant often weaves them into prose).
    prompt_text = scrub_style_triggers(ui.prompt, style_triggers, _all_style_triggers())
    prompt_text = with_lora_triggers(prompt_text, style_triggers)
    # Expert light geometry (P8) then look delivery (P9) into visual_style.
    prompt_text = apply_light(prompt_text, getattr(ui, "light", None))
    prompt_text = apply_look(prompt_text, getattr(ui, "look", None))

    # Realism stays on the final AV chain (as in the workflow). Other styles → main stack.
    style_main = [lora for lora, _ in styles if not is_realism_lora(lora.path)]
    style_final = [lora for lora, _ in styles if is_realism_lora(lora.path)]

    return FullParams(
        prompt=prompt_text,
        refs=refs,
        aspect=ui.aspect,
        megapixels=q["megapixels"],
        upscale=q["scale"],
        duration=ui.duration,
        seed=seed,
        unet=profile.unet,
        nvfp4_unet=profile.nvfp4_unet,
        pdmd_lora=profile.pdmd_lora,
        text_encoder=profile.text_encoder,
        vae_video=profile.vae_video,
        vae_audio=profile.vae_audio,
        upscaler=profile.upscaler,
        loras_main=[*profile.loras_main, *style_main],
        loras_final=[*profile.loras_final, *style_final],
        low_vram=profile.low_vram,
        expert=profile.expert,
        filename_prefix=filename_prefix,
    )


def work_units(full: FullParams) -> float:
    """Size of a job for time estimates: final pixels x frames."""
    w, h = base_resolution(full.aspect, full.megapixels)
    fw, fh = upscaled_resolution(w, h, full.upscale)
    return fw * fh * frame_count(full.duration)
