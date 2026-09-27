"""Domain operations shared by API routes: profiles, generations, uploads."""

import asyncio
import hashlib
import json
import uuid
from pathlib import Path

from fastapi import HTTPException, UploadFile
from pydantic import BaseModel

from . import settings
from .db.models import EngineProfileRow, Generation, MediaAsset, Project, StyleLora, Upload, select, session
from .jobs.estimator import estimate_seconds
from .media import library
from .workflow import enhance, face, interpolate, presets
from .workflow.params import EnhanceUIParams, EngineProfile, FaceUIParams, InterpolateUIParams, LoraSpec, ResolvedRef, UIParams


# ---------------------------------------------------------------- bootstrap
def bootstrap() -> None:
    """First run: default project and an engine profile auto-filled from the shared models dir."""
    with session() as s:
        if not s.exec(select(Project)).first():
            s.add(Project(name="Мой проект"))
        if not s.exec(select(EngineProfileRow)).first():
            prof = presets.default_profile()
            s.add(EngineProfileRow(name=prof.name, data=prof.model_dump(), is_default=True))
        s.commit()
    _migrate_realism_to_styles()


def _migrate_realism_to_styles() -> None:
    """h3-realism-people left the engine recipe: strip it from profiles and offer it as a style chip."""
    path = presets.realism_lora_path()
    with session() as s:
        for row in s.exec(select(EngineProfileRow)).all():
            data = dict(row.data or {})
            before = list(data.get("loras_final") or [])
            after = [dict(l) for l in before if not presets.is_realism_lora(l.get("path", ""))]
            if after != before:
                data["loras_final"] = after
                row.data = data
                s.add(row)
        have = any(presets.is_realism_lora(st.path) for st in s.exec(select(StyleLora)).all())
        if not have and Path(path).is_file():
            s.add(StyleLora(
                name=presets.REALISM_STYLE_NAME,
                path=path,
                default_strength=1.0,
                triggers=[presets.REALISM_TRIGGER],
            ))
        s.commit()


# ---------------------------------------------------------------- profiles
def get_profile(profile_id: int | None) -> tuple[EngineProfileRow, EngineProfile]:
    with session() as s:
        row = s.get(EngineProfileRow, profile_id) if profile_id else None
        if row is None:
            row = s.exec(select(EngineProfileRow).where(EngineProfileRow.is_default)).first() \
                or s.exec(select(EngineProfileRow)).first()
    if row is None:
        raise HTTPException(500, "нет профиля движка")
    return row, face.with_face_defaults(EngineProfile(**row.data))


def profile_problems(profile: EngineProfile) -> list[dict]:
    """Missing files, reported per field so the UI can point at them."""
    from .fs.browse import check

    fields = {"unet": profile.unet, "text_encoder": profile.text_encoder, "vae_video": profile.vae_video,
              "vae_audio": profile.vae_audio, "upscaler": profile.upscaler}
    out = [{"field": k, "path": v} for k, v in fields.items() if not check(v)["exists"]]
    for group in ("loras_main", "loras_final"):
        for i, lora in enumerate(getattr(profile, group)):
            if lora.enabled and not check(lora.path)["exists"]:
                out.append({"field": f"{group}.{i}", "path": lora.path})
    return out


# ---------------------------------------------------------------- uploads
async def save_upload(file: UploadFile) -> Upload:
    kind = library.kind_of(file.filename or "")
    if kind is None:
        raise HTTPException(415, f"Неподдерживаемый тип файла: {file.filename}")
    uid = uuid.uuid4().hex[:16]
    dest = settings.UPLOADS_DIR / f"{uid}{Path(file.filename).suffix.lower()}"
    with dest.open("wb") as f:
        while chunk := await file.read(1 << 20):
            f.write(chunk)
    meta = await library.probe(dest)
    await library.thumbnail(dest, settings.THUMBS_DIR / f"up_{uid}.jpg", kind, at=0.0)
    up = Upload(id=uid, kind=kind, orig_name=file.filename or dest.name, path=str(dest),
                duration=meta.duration, width=meta.width, height=meta.height, has_audio=meta.has_audio)
    with session() as s:
        s.add(up)
        s.commit()
    return up


def _upload_family_key(up: Upload) -> str:
    """Collapse edits and re-uploads of the same file name within a kind."""
    return f"{up.kind}:{up.orig_name}"


def _collect_used_upload_ids(s) -> list[str]:
    """Upload ids referenced by generations and project timelines, newest-first."""
    ordered: list[str] = []
    seen: set[str] = set()

    def add(uid: str | None) -> None:
        if not uid or not isinstance(uid, str) or uid in seen:
            return
        seen.add(uid)
        ordered.append(uid)

    gens = list(s.exec(select(Generation).order_by(Generation.id.desc())).all())
    for g in gens:
        ui = g.ui_params or {}
        for ref in ui.get("refs") or []:
            if isinstance(ref, dict):
                add(ref.get("upload_id"))
        add(ui.get("identity_upload_id"))
        add(ui.get("closeup_upload_id"))

    for p in s.exec(select(Project)).all():
        tl = p.timeline or {}
        for track in tl.get("tracks") or []:
            if not isinstance(track, dict):
                continue
            for plan in track.get("plans") or []:
                if not isinstance(plan, dict):
                    continue
                for ref in plan.get("refs") or []:
                    if isinstance(ref, dict):
                        add(ref.get("uploadId") or ref.get("upload_id"))
    return ordered


def list_uploads(*, used_only: bool = True) -> list[Upload]:
    """Unique uploads (by original/edit family). When used_only — only those referenced in jobs/plans."""
    with session() as s:
        if used_only:
            ids = _collect_used_upload_ids(s)
            uploads = [u for uid in ids if (u := s.get(Upload, uid)) is not None]
        else:
            uploads = list(s.exec(select(Upload).order_by(Upload.created.desc())).all())

        out: list[Upload] = []
        seen_family: set[str] = set()
        for u in uploads:
            root = s.get(Upload, u.source_id) if u.source_id else u
            pick = root if root is not None else u
            key = _upload_family_key(pick)
            if key in seen_family:
                continue
            seen_family.add(key)
            out.append(pick)
        return out


class RefEdit(BaseModel):
    """What to keep of a reference: an image/video region and/or an audio/video fragment."""
    crop: dict[str, float] | None = None  # normalized {x, y, w, h}
    start: float | None = None  # seconds
    end: float | None = None


MIN_CROP_PX = 64
MIN_FRAGMENT_S = 0.5


async def edit_upload(upload_id: str, edit: RefEdit) -> Upload:
    """Derived upload with the edit applied to the ORIGINAL file; an empty edit returns the original.

    The engine graph never changes: the edited file simply replaces the original in the loader node.
    Same original + same edit -> same id, so re-applying is instant.
    """
    with session() as s:
        up = s.get(Upload, upload_id)
        if up is None:
            raise HTTPException(404, "референс не найден")
        src = s.get(Upload, up.source_id) if up.source_id else up
    if src is None:
        raise HTTPException(404, "оригинал референса не найден")

    crop = edit.crop if src.kind in ("image", "video") else None
    if crop and crop["x"] <= 0.001 and crop["y"] <= 0.001 and crop["w"] >= 0.999 and crop["h"] >= 0.999:
        crop = None  # whole frame
    start = end = None
    if src.kind in ("audio", "video") and src.duration:
        start = edit.start if edit.start and edit.start > 0.01 else None
        end = edit.end if edit.end is not None and edit.end < src.duration - 0.01 else None
    if crop is None and start is None and end is None:
        return src

    if crop and src.width and src.height:
        if crop["w"] * src.width < MIN_CROP_PX or crop["h"] * src.height < MIN_CROP_PX:
            raise HTTPException(422, f"Область слишком маленькая: нужно хотя бы {MIN_CROP_PX}×{MIN_CROP_PX} пикселей")
    if (start is not None or end is not None) and (end if end is not None else src.duration) - (start or 0) < MIN_FRAGMENT_S:
        raise HTTPException(422, "Фрагмент слишком короткий: нужно хотя бы полсекунды")

    spec = {k: v for k, v in {"crop": crop and {k: round(v, 4) for k, v in crop.items()},
                              "start": start and round(start, 3), "end": end and round(end, 3)}.items() if v is not None}
    uid = "e_" + hashlib.sha1(f"{src.id}:{json.dumps(spec, sort_keys=True)}".encode()).hexdigest()[:14]
    with session() as s:
        if (existing := s.get(Upload, uid)) and Path(existing.path).exists():
            return existing

    src_path = Path(src.path)
    try:
        if src.kind == "image":
            dest = await asyncio.to_thread(library.crop_image, src_path, settings.UPLOADS_DIR / f"{uid}.png", spec["crop"])
        else:
            ext = ".wav" if src.kind == "audio" else ".mp4"
            dest = await library.edit_media(src_path, settings.UPLOADS_DIR / f"{uid}{ext}", src.kind,
                                            crop=spec.get("crop"), start=spec.get("start"), end=spec.get("end"),
                                            width=src.width, height=src.height)
    except RuntimeError as e:
        raise HTTPException(500, f"Не удалось обрезать референс: {e}")
    meta = await library.probe(dest)
    await library.thumbnail(dest, settings.THUMBS_DIR / f"up_{uid}.jpg", src.kind, at=0.0)
    stem, suffix = Path(src.orig_name).stem, dest.suffix
    derived = Upload(id=uid, kind=src.kind, orig_name=f"{stem} (обрезано){suffix}", path=str(dest),
                     duration=meta.duration, width=meta.width, height=meta.height,
                     has_audio=meta.has_audio, source_id=src.id, edit=spec)
    with session() as s:
        s.merge(derived)
        s.commit()
    return derived


# ---------------------------------------------------------------- generations
def create_generations(ui: UIParams, project_id: int) -> list[Generation]:
    row, profile = get_profile(ui.profile_id)
    problems = profile_problems(profile)
    if problems:
        raise HTTPException(422, {"kind": "missing_file", "problems": problems,
                                  "message": "Не найдены файлы моделей — проверьте Настройки → Движок"})

    with session() as s:
        refs = []
        for ref in ui.refs:
            up = s.get(Upload, ref.upload_id)
            if up is None:
                raise HTTPException(404, f"референс {ref.upload_id} не найден")
            refs.append(ResolvedRef(kind=up.kind, path=up.path, with_audio=ref.with_audio and up.kind == "video"))
        styles = []
        for st in ui.styles:
            lib = s.get(StyleLora, st.style_id)
            if lib is None:
                raise HTTPException(404, f"стиль {st.style_id} не найден")
            strength = st.strength if st.strength is not None else lib.default_strength
            styles.append((LoraSpec(path=lib.path, strength=strength), lib.triggers))

    created = []
    for i in range(ui.variants):
        seed = ui.seed + i if ui.seed is not None else presets.new_seed()
        full = presets.expand(ui, profile, refs, styles, seed, filename_prefix="ShellMax/gen")
        units = presets.work_units(full)
        g = Generation(project_id=project_id, ui_params=ui.model_dump(), full_params=full.model_dump(),
                       seed=seed, profile_name=row.name, work_units=units, estimate_s=estimate_seconds(units))
        with session() as s:
            s.add(g)
            s.commit()
            s.refresh(g)
            g.full_params = {**g.full_params, "filename_prefix": f"ShellMax/gen{g.id:05d}"}
            s.add(g)
            s.commit()
        created.append(g)
    return created


# ---------------------------------------------------------------- face refine
def _source_generation(asset: MediaAsset) -> Generation | None:
    if asset.generation_id is None:
        return None
    with session() as s:
        return s.get(Generation, asset.generation_id)


def face_defaults(asset_id: int) -> dict:
    """Everything the face refine dialog pre-fills for a clip: whose face, the crop, a prompt, warnings."""
    with session() as s:
        asset = s.get(MediaAsset, asset_id)
    if asset is None or asset.kind != "video":
        raise HTTPException(404, "клип не найден")
    src = _source_generation(asset)
    identity: Upload | None = None
    crop = None
    prompt = face.closeup_prompt("")
    with session() as s:
        if src and src.kind == "face":  # refining a refined clip: start from what was used last time
            identity = s.get(Upload, src.ui_params.get("identity_upload_id"))
            crop = src.ui_params.get("closeup_crop")
            prompt = src.ui_params.get("prompt", prompt)
        elif src:
            first_image = next((r for r in src.ui_params.get("refs", []) if r.get("kind") == "image"), None)
            if first_image:
                identity = s.get(Upload, first_image["upload_id"])
            prompt = face.closeup_prompt(src.ui_params.get("prompt", ""))
    if identity and crop is None:
        crop = face.closeup_crop_for(face.detect_face_box(identity.path))
    _, _, frames, warnings = face.source_frames(asset.duration, asset.fps)
    return {
        "asset": asset,
        "identity": identity,
        "closeup_crop": crop,
        "prompt": prompt,
        "source_prompt": src.ui_params.get("prompt", "") if src else "",
        "frames": frames,
        "warnings": warnings,
        "presets": face.strength_presets(),
    }


def create_face_refine(ui: FaceUIParams, project_id: int) -> Generation:
    row, profile = get_profile(ui.profile_id)
    with session() as s:
        asset = s.get(MediaAsset, ui.source_asset_id)
        identity = s.get(Upload, ui.identity_upload_id)
        closeup = s.get(Upload, ui.closeup_upload_id) if ui.closeup_upload_id else identity
    if asset is None or asset.kind != "video":
        raise HTTPException(404, "клип не найден")
    if identity is None or closeup is None or identity.kind != "image" or closeup.kind != "image":
        raise HTTPException(422, "Нужна картинка с лицом персонажа")
    from .fs.browse import check
    missing = [p for p in (profile.face.unet, profile.face.lora, profile.text_encoder, profile.vae_video,
                           profile.vae_audio) if not check(p)["exists"]]
    if missing:
        raise HTTPException(422, {"kind": "missing_file", "problems": [{"field": "face", "path": p} for p in missing],
                                  "message": "Не найдены файлы моделей для улучшения лица — проверьте Настройки → Движок"})
    cap, force_rate, frames, _ = face.source_frames(asset.duration, asset.fps)
    if frames == 0:
        raise HTTPException(422, "Клип слишком короткий для улучшения лица")
    seed = ui.seed if ui.seed is not None else face.WORKFLOW_SEED
    full = face.expand_face(ui, profile, asset.path, cap, force_rate, identity.path, closeup.path, seed, "ShellMax/face")
    units = face.face_work_units(full.recipe, frames)
    g = Generation(project_id=project_id, kind="face", source_asset_id=asset.id, ui_params=ui.model_dump(),
                   full_params=full.model_dump(), seed=seed, profile_name=row.name, work_units=units,
                   estimate_s=estimate_seconds(units, "face"))
    with session() as s:
        s.add(g)
        s.commit()
        s.refresh(g)
        g.full_params = {**g.full_params, "filename_prefix": f"ShellMax/face{g.id:05d}"}
        s.add(g)
        s.commit()
    return g


def enhance_defaults(asset_id: int) -> dict:
    with session() as s:
        asset = s.get(MediaAsset, asset_id)
    if asset is None or asset.kind != "video":
        raise HTTPException(404, "клип не найден")
    frames = max(1, round((asset.duration or 0) * (asset.fps or 24)))
    recipe = enhance.default_recipe()
    return {
        "asset": asset,
        "scale": recipe.scale,
        "strength": recipe.strength,
        "color_correction": recipe.color_correction,
        "frames": frames,
        "scale_presets": enhance.scale_presets(),
        "strength_presets": enhance.strength_presets(),
        "color_presets": enhance.color_presets(),
        "unet": recipe.unet,
        "vae": recipe.vae,
    }


def create_enhance(ui: EnhanceUIParams, project_id: int) -> Generation:
    with session() as s:
        asset = s.get(MediaAsset, ui.source_asset_id)
    if asset is None or asset.kind != "video":
        raise HTTPException(404, "клип не найден")
    recipe = enhance.default_recipe()
    from .fs.browse import check
    missing = [p for p in (recipe.unet, recipe.vae) if not check(p)["exists"]]
    if missing:
        raise HTTPException(422, {
            "kind": "missing_file",
            "problems": [{"field": "enhance", "path": p} for p in missing],
            "message": "Не найдены модели SeedVR2 — скачайте seedvr2_* и seedvr2_ema_vae "
                       "(или ema_vae_fp16) в папку моделей, затем перезапустите установщик",
        })
    force_rate = 0.0
    frame_rate = float(asset.fps or 24)
    # Resample non-24 clips to 24 so SeedVR's 4n+1 padding stays predictable; keep output at 24.
    if asset.fps and abs(asset.fps - 24) > 0.05:
        force_rate = 24.0
        frame_rate = 24.0
    frames = max(1, round((asset.duration or 1) * frame_rate))
    seed = ui.seed if ui.seed is not None else enhance.WORKFLOW_SEED
    full = enhance.expand_enhance(ui, asset.path, force_rate, frame_rate, seed, "ShellMax/enhance")
    units = enhance.enhance_work_units(
        full.recipe, frames, int(asset.width or 1280), int(asset.height or 720))
    g = Generation(project_id=project_id, kind="enhance", source_asset_id=asset.id,
                   ui_params=ui.model_dump(), full_params=full.model_dump(), seed=seed,
                   profile_name="SeedVR2", work_units=units,
                   estimate_s=estimate_seconds(units, "enhance"))
    with session() as s:
        s.add(g)
        s.commit()
        s.refresh(g)
        g.full_params = {**g.full_params, "filename_prefix": f"ShellMax/enhance{g.id:05d}"}
        s.add(g)
        s.commit()
    return g


def interpolate_defaults(asset_id: int) -> dict:
    with session() as s:
        asset = s.get(MediaAsset, asset_id)
    if asset is None or asset.kind != "video":
        raise HTTPException(404, "клип не найден")
    frames = max(1, round((asset.duration or 0) * (asset.fps or 24)))
    recipe = interpolate.default_recipe()
    return {
        "asset": asset,
        "model": recipe.model_preset,
        "multiplier": recipe.multiplier,
        "frames": frames,
        "source_fps": float(asset.fps or 24),
        "model_presets": interpolate.model_presets(),
        "multiplier_presets": interpolate.multiplier_presets(),
        "model_path": recipe.model,
    }


def create_interpolate(ui: InterpolateUIParams, project_id: int) -> Generation:
    with session() as s:
        asset = s.get(MediaAsset, ui.source_asset_id)
    if asset is None or asset.kind != "video":
        raise HTTPException(404, "клип не найден")
    preset = ui.model if ui.model in ("rife", "film") else "rife"
    recipe = interpolate.default_recipe(preset)
    from .fs.browse import check
    if not check(recipe.model)["exists"]:
        raise HTTPException(422, {
            "kind": "missing_file",
            "problems": [{"field": "interpolate", "path": recipe.model}],
            "message": "Не найдена модель интерполяции — скачайте rife_v4.26 или film_net_fp16 "
                       "в frame_interpolation/ (или положите rife49.pth в rife/), затем перезапустите установщик",
        })
    frame_rate = float(asset.fps or 24)
    frames = max(1, round((asset.duration or 1) * frame_rate))
    full = interpolate.expand_interpolate(ui, asset.path, frame_rate, "ShellMax/interpolate")
    units = interpolate.interpolate_work_units(
        full.recipe, frames, int(asset.width or 1280), int(asset.height or 720))
    label = "FILM" if full.recipe.model_preset == "film" else "RIFE"
    g = Generation(project_id=project_id, kind="interpolate", source_asset_id=asset.id,
                   ui_params=ui.model_dump(), full_params=full.model_dump(), seed=0,
                   profile_name=label, work_units=units,
                   estimate_s=estimate_seconds(units, "interpolate"))
    with session() as s:
        s.add(g)
        s.commit()
        s.refresh(g)
        g.full_params = {**g.full_params, "filename_prefix": f"ShellMax/interp{g.id:05d}"}
        s.add(g)
        s.commit()
    return g
