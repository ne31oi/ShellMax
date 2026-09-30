"""Domain expansion for new artifact and masked-edit jobs."""

import math
import uuid

from fastapi import HTTPException

from .db.models import Generation, MediaAsset, Upload, session
from .refmods import resolve_member
from .mask_tracking import validate_auto_layers
from .workflow import presets
from .workflow.fantastic import MaskEditFull, MaskEditUI, MediaSource, RefModCreateFull, RefModCreateUI
from .workflow.params import ResolvedRef, UIParams


def _uploads(ids: list[str]) -> list[Upload]:
    with session() as s:
        rows = [s.get(Upload, uid) for uid in ids]
    if any(row is None for row in rows):
        raise HTTPException(404, "Референс не найден — выберите его заново")
    return rows


def _profile(profile_id):
    from .services import get_profile, profile_problems
    row, profile = get_profile(profile_id)
    problems = profile_problems(profile)
    if problems:
        raise HTTPException(422, {"kind": "missing_file", "problems": problems,
                                  "message": "Не найдены модели — проверьте Настройки → Движок"})
    return row, profile


def expand_refmod_create(ui: RefModCreateUI, project_id: int) -> Generation:
    row, profile = _profile(ui.profile_id)
    uploads = _uploads(ui.upload_ids)
    if any(up.refmod_file for up in uploads):
        raise HTTPException(422, "Для создания RefMod выберите исходные картинки, видео или аудио")
    sources = [MediaSource(path=up.path, kind={"image": "picture", "video": "video", "audio": "audio"}[up.kind],
                           has_audio=up.has_audio, audio_mode="paired" if ui.include_audio else "off") for up in uploads]
    if not ui.include_audio and all(s.kind == "audio" for s in sources):
        raise HTTPException(422, "Включите звук, чтобы создать голосовой RefMod")
    if not ui.include_audio:
        sources = [s for s in sources if s.kind != "audio"]
    full = RefModCreateFull(sources=sources, name="ref_" + uuid.uuid4().hex[:16], label=ui.name.strip(), mode=ui.mode,
                           description=ui.description or ui.name.strip(), vae_video=profile.vae_video, vae_audio=profile.vae_audio)
    return Generation(project_id=project_id, kind="refmod_create", ui_params=ui.model_dump(), full_params=full.model_dump(),
                      seed=0, profile_name=row.name)


def expand_mask_edit(ui: MaskEditUI, project_id: int) -> Generation:
    row, profile = _profile(ui.profile_id)
    with session() as s:
        asset = s.get(MediaAsset, ui.source_asset_id)
    if asset is None or asset.kind != "video":
        raise HTTPException(404, "Клип не найден")
    duration = float(asset.duration or 0)
    end = ui.end if ui.end is not None else duration
    if ui.start >= end or end > duration + 0.05:
        raise HTTPException(422, "Выберите фрагмент в пределах клипа")
    frames = math.floor((end - ui.start) * 24 + 1e-5)
    frames = (frames - 5) // 17 * 17 + 5 if frames >= 5 else 0
    if frames < 5:
        raise HTTPException(422, "Фрагмент слишком короткий: нужно хотя бы 5 кадров")
    if any(key.t < ui.start - 0.001 or key.t > end + 0.001 for layer in ui.layers for key in getattr(layer, "keys", [])):
        raise HTTPException(422, "Ключевые кадры маски должны попадать в выбранный фрагмент")
    validate_auto_layers(asset.id, ui.layers)
    uploads = _uploads(ui.reference_upload_ids)
    refs = []
    for up in uploads:
        if up.refmod_file:
            resolve_member(up.refmod_file)
        refs.append(ResolvedRef(kind=up.kind, path=up.path, refmod_file=up.refmod_file or ""))
    seed = ui.seed if ui.seed is not None else presets.new_seed()
    aspect = min(presets.ASPECT_RATIOS, key=lambda key: abs(presets.ASPECT_RATIOS[key][0] / presets.ASPECT_RATIOS[key][1]
                                                         - (asset.width or 1280) / (asset.height or 720)))
    base = presets.expand(UIParams(prompt=ui.prompt, aspect=aspect, duration=frames / 24, quality=ui.quality),
                          profile, refs, [], seed, "ShellMax/mask")
    full = MaskEditFull(base=base, pipeline=profile.pipeline,
                        sources=[MediaSource(path=asset.path, kind="video", has_audio=asset.has_audio),
                                 *[MediaSource(path=up.path, kind={"image": "picture", "video": "video", "audio": "audio"}[up.kind])
                                   for up in uploads if not up.refmod_file]],
                        layers=ui.layers, start=ui.start, end=ui.start + frames / 24,
                        strength=ui.strength, invert=ui.invert, grow=ui.grow, feather=ui.feather,
                        crop_to_mask=ui.crop_to_mask, keep_audio=ui.keep_audio, frames=frames, seed=seed)
    return Generation(project_id=project_id, kind="mask_edit", source_asset_id=asset.id, ui_params=ui.model_dump(),
                      full_params=full.model_dump(), seed=seed, profile_name=row.name,
                      work_units=presets.work_units(base))
