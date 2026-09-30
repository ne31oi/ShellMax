"""RefMod catalogue/imports, confined to registered model roots.

Catalogue parsing belongs to Fantastic H3; ShellMax only stores chosen members
as reusable Uploads. No tensors are loaded by the web server.
"""

import hashlib
import json
from pathlib import Path

import httpx
from fastapi import HTTPException
from sqlmodel import Session

from . import settings
from .db.models import Generation, Upload, select, session


def limits() -> dict:
    """Read configured budgets, not an invented hardware/model capacity."""
    workflows = Path(__file__).resolve().parents[2] / "workflows"
    create = json.loads((workflows / "ShellMax_RefMod_Create.api.json").read_text(encoding="utf-8"))
    totals = {}
    for kind, name in (("generate", "Standard"), ("generate_nvfp4", "NVFP4"), ("generate_nvfp4_fast", "NVFP4_Fast")):
        graph = json.loads((workflows / f"ShellMax_RefMods_{name}.api.json").read_text(encoding="utf-8"))
        totals[kind] = graph["56"]["inputs"]["max_total_tokens"] or None
    return {"create_visual_tokens": create["create_refmod"]["inputs"]["max_tokens"] or None,
            "total_tokens": totals}


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


def creation_context(store: Session) -> dict[str, dict]:
    """Recover provenance for existing members without opening their tensors."""
    result = {}
    for g in store.exec(select(Generation).where(Generation.kind == "refmod_create")).all():
        full = g.full_params or {}
        if g.status != "done" or not full.get("name"):
            continue
        sources = full.get("sources", [])
        visual = [src for src in sources if src.get("kind") != "audio"]
        result["ShellMax/" + full["name"]] = {
            "label": full.get("label", ""),
            "description": full.get("description", ""),
            "source_kind": "photo_set" if len(visual) > 1 and all(src.get("kind") == "picture" for src in visual) else (
                "image" if len(visual) == 1 and visual[0].get("kind") == "picture" else "video"),
            "source_upload_ids": (g.ui_params or {}).get("upload_ids", []),
            "mode": full.get("mode", "Compressed Reference"),
            "include_audio": (g.ui_params or {}).get("include_audio", False),
        }
    return result


def member_metadata(item: dict, channel: dict, creations: dict[str, dict]) -> dict:
    file = channel.get("file", "")
    base = file.removesuffix("_visual").removesuffix("_audio")
    created = creations.get(base, {})
    source_kind = "photo_set" if channel.get("source") == "stack" else channel.get("kind", "")
    return {
        "source_kind": "audio" if channel.get("kind") == "audio" else created.get("source_kind", source_kind),
        "description": item.get("desc") or created.get("description", ""),
        "source_upload_ids": created.get("source_upload_ids", []),
        **{key: item.get(key) or "" for key in ("concept", "appearance", "voice_description", "retained_attributes")},
    }


async def catalogue() -> dict:
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(settings.comfy_url() + "/minimax_h3/refmods")
            response.raise_for_status()
            data = response.json()
        with session() as s:
            creations = creation_context(s)
        for item in data.get("items", []):
            created = creations.get(item.get("name", ""), {})
            if created.get("label"):
                item["label"] = created["label"]
            for key in ("visual", "audio"):
                if item.get(key):
                    item[key]["context"] = member_metadata(item, item[key], creations)
            files = [item[key]["file"] for key in ("visual", "audio") if item.get(key)]
            item["deletable"] = bool(files) and all(resolve_member(file).is_relative_to(roots()[0].resolve()) for file in files)
        data["limits"] = limits()
        return data
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(503, "Библиотека RefMods недоступна — запустите движок; после установки Fantastic H3 перезапустите его") from exc


async def revision_defaults(file: str) -> dict:
    data = await catalogue()
    item = next((item for item in data["items"] if any((item.get(k) or {}).get("file") == file for k in ("visual", "audio"))), None)
    if item is None:
        raise HTTPException(404, "RefMod не найден — обновите библиотеку")
    with session() as s:
        base = item["name"]
        created = creation_context(s).get(base, {})
        ids = created.get("source_upload_ids", [])
        uploads = [s.get(Upload, uid) for uid in ids]
    available = [up for up in uploads if up and Path(up.path).is_file() and not up.refmod_file]
    return {"item": item, "uploads": available, "missing_sources": len(ids) - len(available),
            "has_sources": bool(ids), "mode": created.get("mode", "Compressed Reference"),
            "include_audio": created.get("include_audio", bool(item.get("audio"))), "limits": data["limits"]}


def _mentions(value, needles: set[str]) -> bool:
    if isinstance(value, dict):
        return any(_mentions(v, needles) for v in value.values())
    if isinstance(value, list):
        return any(_mentions(v, needles) for v in value)
    return isinstance(value, str) and value in needles


async def delete_member(file: str) -> dict:
    data = await catalogue()
    item = next((item for item in data["items"] if any((item.get(k) or {}).get("file") == file for k in ("visual", "audio"))), None)
    if item is None:
        raise HTTPException(404, "RefMod уже удалён — обновите библиотеку")
    members = [item[k]["file"] for k in ("visual", "audio") if item.get(k)]
    owned = roots()[0].resolve()
    paths = {resolve_member(member) for member in members}
    if any(not path.is_relative_to(owned) for path in paths):
        raise HTTPException(422, "Этот RefMod находится в основной установке ComfyUI: ShellMax не изменяет её файлы")
    # An item can be a pair or a bundle: deleting a card deletes its actual files.
    with session() as s:
        uploads = s.exec(select(Upload).where(Upload.refmod_file.in_(members))).all()
        needles = set(members) | {up.id for up in uploads} | {str(p) for p in paths}
        active = s.exec(select(Generation).where(Generation.status.in_(["queued", "running"]))).all()
        if any(_mentions(g.full_params, needles) or _mentions(g.ui_params, needles) for g in active):
            raise HTTPException(409, "RefMod используется задачей — дождитесь её завершения или остановите её")
        preview_name = item.get("preview")
        if preview_name:
            rel = Path(preview_name.replace("\\", "/"))
            if rel.is_absolute() or rel.drive or ".." in rel.parts:
                raise HTTPException(422, "Недопустимое имя превью RefMod")
            for extension in (".png", ".jpg", ".jpeg", ".webp"):
                candidate = (owned / (str(rel) + extension)).resolve()
                if candidate.is_relative_to(owned) and candidate.is_file():
                    paths.add(candidate)
        try:
            for path in paths:
                path.unlink()
        except OSError as exc:
            raise HTTPException(409, "Не удалось удалить файлы RefMod — обновите библиотеку и повторите; проверьте, что файл не занят другой программой") from exc
        for up in uploads:
            (settings.THUMBS_DIR / f"up_{up.id}.jpg").unlink(missing_ok=True)
            s.delete(up)
        s.commit()
    return {"files": members, "upload_ids": [up.id for up in uploads]}


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
                refmod_meta=channel.get("context") or member_metadata(item, channel, {}),
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
