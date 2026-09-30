"""Kind registry: one place for build / params / titles instead of if/elif by kind.

Adding a Generation.kind = workflow + builder + parity test + PIPELINES + stages.ts + entry here.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable

from ..db.models import Generation
from ..workflow.builder import build_prompt
from ..workflow.builder_enhance import build_enhance_prompt
from ..workflow.builder_face import build_face_prompt
from ..workflow.builder_interpolate import build_interpolate_prompt
from ..workflow.builder_nvfp4 import build_nvfp4_prompt
from ..workflow.builder_nvfp4_fast import build_nvfp4_fast_prompt
from ..workflow.params import EnhanceFullParams, FaceFullParams, FullParams, InterpolateFullParams
from .pipelines import PIPELINES, Pipeline
from ..workflow import builder_refmods, builder_refmod_create, builder_mask_edit
from ..workflow.fantastic import RefModCreateUI, RefModCreateFull, MaskEditUI, MaskEditFull
from ..fantastic_jobs import expand_refmod_create, expand_mask_edit
from ..refmods import collect_output as collect_refmod_output
from ..mask_tracking import expand_mask_track, collect_output as collect_mask_output
from ..workflow.fantastic import MaskTrackUI, MaskTrackFull
from ..workflow.builder_mask_track import build_mask_track_prompt

UploadKind = str | None  # "refs" | "face" | None


@dataclass(frozen=True)
class KindHandler:
    kind: str
    params_cls: type
    build: Callable[[Any], dict]
    upload: UploadKind = None  # upload refs into engine input before build
    free_before: bool = False  # free VRAM (SeedVR2 needs a clean slate)
    title: Callable[[Generation, bool, str | None], str] | None = None
    ui_cls: type | None = None
    expand: Callable[[Any, int], Generation] | None = None
    collect_artifact: Callable[[Generation, dict], dict | None] | None = None


def asset_title(prompt: str, gen_id: int) -> str:
    """Short human name for a clip: the summary of a structured prompt, else its first meaningful line."""
    raw = prompt.splitlines()
    heads = [i for i, l in enumerate(raw) if l.strip().lower() == "summary:"]
    if heads:  # official 6-field format: the summary describes the shot, subject lines only define refs
        raw = raw[heads[0] + 1:]
    clean = lambda l: re.sub(r"\s+", " ", re.sub(r"\[[^\]]*\]|<[^>]+>", "", l)).strip(" :.-,")  # noqa: E731
    lines = [clean(l) for l in raw]
    text = next((l for l in lines if len(l) > 3 and not l.lower().startswith("subject_definitions")), "")
    if heads:
        text = re.sub(r"^(a|an|the)\s+", "", text, flags=re.I)
        text = text[:1].upper() + text[1:]
    return (text[:48] + "…") if len(text) > 48 else (text or f"Генерация {gen_id}")


def _generate_title(g: Generation, is_draft: bool, source_name: str | None) -> str:
    return asset_title((g.ui_params or {}).get("prompt", ""), g.id)


def _face_title(g: Generation, is_draft: bool, source_name: str | None) -> str:
    base = source_name or f"Клип {g.source_asset_id}"
    return f"{base} · {'трекинг' if is_draft else 'лицо'}"


def _enhance_title(g: Generation, is_draft: bool, source_name: str | None) -> str:
    base = source_name or f"Клип {g.source_asset_id}"
    return f"{base} · детализация"


def _interpolate_title(g: Generation, is_draft: bool, source_name: str | None) -> str:
    base = source_name or f"Клип {g.source_asset_id}"
    mult = (g.ui_params or {}).get("multiplier") or (g.full_params or {}).get("recipe", {}).get("multiplier") or 2
    return f"{base} · ×{mult}"


HANDLERS: dict[str, KindHandler] = {
    "mask_track": KindHandler("mask_track", MaskTrackFull, build_mask_track_prompt, upload="media", free_before=True,
                              ui_cls=MaskTrackUI, expand=expand_mask_track, collect_artifact=collect_mask_output),
    "generate_refmods": KindHandler("generate_refmods", FullParams, builder_refmods.build_refmod_prompt,
                                    upload="refs", title=_generate_title),
    "generate_nvfp4_refmods": KindHandler("generate_nvfp4_refmods", FullParams, builder_refmods.build_nvfp4_refmod_prompt,
                                          upload="refs", title=_generate_title),
    "generate_nvfp4_fast_refmods": KindHandler("generate_nvfp4_fast_refmods", FullParams, builder_refmods.build_fast_refmod_prompt,
                                               upload="refs", title=_generate_title),
    "refmod_create": KindHandler("refmod_create", RefModCreateFull, builder_refmod_create.build_create_refmod_prompt,
                                 upload="media", ui_cls=RefModCreateUI, expand=expand_refmod_create,
                                 collect_artifact=collect_refmod_output),
    "mask_edit": KindHandler("mask_edit", MaskEditFull, builder_mask_edit.build_mask_edit_prompt,
                             upload="media", ui_cls=MaskEditUI, expand=expand_mask_edit,
                             title=lambda g, draft, name: f"{name or 'Клип'} · маска"),
    "generate": KindHandler("generate", FullParams, build_prompt, upload="refs", title=_generate_title),
    "generate_nvfp4": KindHandler("generate_nvfp4", FullParams, build_nvfp4_prompt, upload="refs", title=_generate_title),
    "generate_nvfp4_fast": KindHandler(
        "generate_nvfp4_fast", FullParams, build_nvfp4_fast_prompt, upload="refs", title=_generate_title),
    "face": KindHandler("face", FaceFullParams, build_face_prompt, upload="face", title=_face_title),
    "enhance": KindHandler(
        "enhance", EnhanceFullParams, build_enhance_prompt, free_before=True, title=_enhance_title),
    "interpolate": KindHandler(
        "interpolate", InterpolateFullParams, build_interpolate_prompt, title=_interpolate_title),
}


def get_handler(kind: str) -> KindHandler:
    return HANDLERS.get(kind) or HANDLERS["generate"]


def pipeline_for(kind: str) -> Pipeline:
    return PIPELINES.get(kind, PIPELINES["generate"])


def asset_title_for(g: Generation, is_draft: bool, source_name: str | None = None) -> str:
    h = get_handler(g.kind)
    if h.title:
        return h.title(g, is_draft, source_name)
    return asset_title((g.ui_params or {}).get("prompt", ""), g.id)
