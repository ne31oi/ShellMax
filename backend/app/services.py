"""Domain operations shared by API routes: profiles, generations, uploads."""

import uuid
from pathlib import Path

from fastapi import HTTPException, UploadFile

from . import settings
from .db.models import EngineProfileRow, Generation, Project, StyleLora, Upload, select, session
from .jobs.estimator import estimate_seconds
from .media import library
from .workflow import presets
from .workflow.params import EngineProfile, LoraSpec, ResolvedRef, UIParams


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


# ---------------------------------------------------------------- profiles
def get_profile(profile_id: int | None) -> tuple[EngineProfileRow, EngineProfile]:
    with session() as s:
        row = s.get(EngineProfileRow, profile_id) if profile_id else None
        if row is None:
            row = s.exec(select(EngineProfileRow).where(EngineProfileRow.is_default)).first() \
                or s.exec(select(EngineProfileRow)).first()
    if row is None:
        raise HTTPException(500, "нет профиля движка")
    return row, EngineProfile(**row.data)


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
