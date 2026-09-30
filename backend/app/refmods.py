"""RefMod catalogue/imports, confined to registered model roots.

Catalogue parsing belongs to Fantastic H3; ShellMax only stores chosen members
as reusable Uploads. No tensors are loaded by the web server.
"""

import hashlib
from pathlib import Path

import httpx
from fastapi import HTTPException

from . import settings
from .db.models import Generation, Upload, select, session


def roots() -> list[Path]:
    return [settings.portable_dir() / "ComfyUI" / "models" / "refmods",
            settings.legacy_models_dir() / "refmods"]


def resolve_member(name: str) -> Path:
    stem = name.split("#", 1)[0]
    rel = Path(stem.replace("\\", "/"))
    if rel.is_absolute() or rel.drive or any(p in ("..", ".") for p in rel.parts) or not stem:
        raise HTTPException(422, "Недопустимое имя RefMod")
    for root in roots():
        path = (root / (stem + ".safetensors")).resolve()
        if path.is_relative_to(root.resolve()) and path.is_file():
            return path
    raise HTTPException(422, "RefMod не найден — откройте библиотеку и выберите его заново")


async def catalogue() -> dict:
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(settings.comfy_url() + "/minimax_h3/refmods")
            response.raise_for_status()
            data = response.json()
        with session() as s:
            labels = {g.full_params["name"]: g.full_params.get("label", "")
                      for g in s.exec(select(Generation).where(Generation.kind == "refmod_create")).all() if g.full_params}
        for item in data.get("items", []):
            stem = item.get("name", "").split("/")[-1]
            if labels.get(stem):
                item["label"] = labels[stem]
        return data
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(503, "Библиотека RefMods недоступна — запустите движок; после установки Fantastic H3 перезапустите его") from exc


async def preview(name: str) -> bytes:
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(settings.comfy_url() + "/minimax_h3/refmods/preview", params={"name": name})
        response.raise_for_status()
        return response.content


async def use_member(file: str) -> Upload:
    data = await catalogue()
    found = next(((item, item[key]) for item in data.get("items", []) for key in ("visual", "audio")
                  if (item.get(key) or {}).get("file") == file), None)
    if found is None:
        raise HTTPException(404, "RefMod не найден — обновите библиотеку")
    item, channel = found
    path = resolve_member(file)
    uid = "rm_" + hashlib.sha256(file.encode()).hexdigest()[:20]
    thumb = settings.THUMBS_DIR / f"up_{uid}.jpg"
    if item.get("preview"):
        temporary = thumb.with_suffix(".preview.png")
        try:
            from .media import library
            temporary.write_bytes(await preview(item["preview"]))
            await library.thumbnail(temporary, thumb, "image")
        except (httpx.HTTPError, OSError, ValueError):
            pass
        finally:
            temporary.unlink(missing_ok=True)
    up = Upload(id=uid, kind=channel["kind"], orig_name=f"{item['label']} · RefMod", name=item["label"],
                path=str(path), description=item.get("desc", ""), refmod_file=file,
                refmod_tokens=channel.get("tokens"), duration=channel.get("seconds"),
                width=channel.get("w", 0) * 16 or None, height=channel.get("h", 0) * 16 or None,
                category="character" if item.get("concept") == "identity" else "other")
    with session() as s:
        existing = s.get(Upload, uid)
        if existing:
            up.created = existing.created
        s.merge(up)
        s.commit()
    return up


def collect_output(g, output: dict) -> dict | None:
    files = output.get("refmod_saved")
    if not isinstance(files, list) or not any(str(p).endswith(".safetensors") for p in files):
        return None
    # The job uses a unique name; never trust arbitrary filenames from output.
    prefix = "ShellMax/" + g.full_params["name"]
    members = []
    for file in files:
        file = str(file).replace("\\", "/")
        if file.endswith(".safetensors") and file[:-12] in (prefix, prefix + "_visual", prefix + "_audio"):
            name = file[:-12]
            resolve_member(name)
            members.append(name)
    return {"refmods": members} if members else None
