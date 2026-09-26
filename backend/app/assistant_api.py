"""Assistant API: plain words -> prompt, face refine prompt, model download and settings."""

import json
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from . import settings
from .db.models import Generation, MediaAsset, Upload, session
from .llm import config, prompt
from .llm.downloader import downloads
from .llm.registry import CHOICES, FILES
from .llm.service import AssistantBusy, AssistantService
from .media import library

router = APIRouter(prefix="/api/assistant")
TMP = settings.DATA_DIR / "assistant_tmp"


def _svc(request: Request) -> AssistantService:
    return request.app.state.assistant


def _sse(gen):
    async def body():
        async for event in gen:
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
    return StreamingResponse(body(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


def _precheck(svc: AssistantService) -> JSONResponse | None:
    try:
        svc.precheck()
    except AssistantBusy as e:
        return JSONResponse({"detail": str(e)}, status_code=409)
    return None


# ---------------------------------------------------------------- status / models / settings
@router.get("/status")
def status(request: Request):
    return _svc(request).status()


@router.get("/models")
def models():
    out = []
    for c in CHOICES.values():
        files = [downloads.status(f) for f in c.all_files()]
        out.append({"id": c.id, "label": c.label, "hint": c.hint,
                    "ready": all(f["status"] == "ready" for f in files),
                    "size": sum(FILES[f].size for f in c.all_files() if not FILES[f].ready())})
    return out


@router.post("/download")
async def download():
    s = config.load()
    downloads.start(list(CHOICES[s.model].all_files()))
    return {"ok": True}


@router.get("/settings")
def get_settings():
    return config.load()


@router.put("/settings")
async def put_settings(body: config.AssistantSettings, request: Request):
    old = config.load()
    config.save(body)
    if (old.model, old.context_size, old.kv_cache, old.device) != (body.model, body.context_size, body.kv_cache, body.device):
        await _svc(request).runner.stop()  # next request starts with the new settings
    return {"ok": True}


@router.post("/stop")
def stop(request: Request):
    _svc(request).cancel()
    return {"ok": True}


@router.post("/unload")
async def unload(request: Request):
    await _svc(request).runner.stop()
    return {"ok": True}


# ---------------------------------------------------------------- plain words -> prompt
class ComposeRef(BaseModel):
    upload_id: str
    with_audio: bool = False


class ComposeIn(BaseModel):
    text: str  # user's description; references as <Picture N>/<Video N>/<Audio N>
    refs: list[ComposeRef] = []
    duration: float = 2.0


@router.post("/compose")
def compose(body: ComposeIn, request: Request):
    svc = _svc(request)
    if not body.text.strip():
        raise HTTPException(422, "Опишите, что должно происходить в видео")
    if (busy := _precheck(svc)) is not None:
        return busy
    infos, images = [], []
    with session() as s:
        for ref in body.refs:
            up = s.get(Upload, ref.upload_id)
            if up is None:
                continue
            infos.append(prompt.RefInfo(kind=up.kind, name=up.orig_name, with_audio=ref.with_audio))
            if up.kind == "image":
                images.append(Path(up.path))
    system = prompt.compose_system(infos, body.duration)
    # the huge spec comes first; restate at the end that the action is the user's, not the photo's
    user = (f"Описание пользователя (ГЛАВНОЕ — действие видео берётся только отсюда):\n{body.text.strip()}\n\n"
            "Преобразуй его в промпт. summary и detailed_description описывают именно это действие; "
            "позу, жесты и предметы с картинок не переносить.")
    return _sse(svc.stream(system, user, images))


# ---------------------------------------------------------------- edit a finished prompt in plain words
class FaceIn(BaseModel):
    source_asset_id: int
    identity_upload_id: str
    closeup_crop: dict[str, float] | None = None


class EditIn(BaseModel):
    prompt: str  # current prompt (model text with <Picture N> tags)
    instruction: str  # what to change, in plain words
    refs: list[ComposeRef] = []
    duration: float = 2.0
    face: FaceIn | None = None  # set when editing a face refine prompt


@router.post("/edit")
def edit(body: EditIn, request: Request):
    svc = _svc(request)
    if not body.prompt.strip() or not body.instruction.strip():
        raise HTTPException(422, "Напишите, что изменить")
    if (busy := _precheck(svc)) is not None:
        return busy
    infos, images = [], []
    with session() as s:
        if body.face:
            identity = s.get(Upload, body.face.identity_upload_id)
            if identity:
                TMP.mkdir(parents=True, exist_ok=True)
                images = [Path(identity.path), _crop(Path(identity.path), body.face.closeup_crop,
                                                     TMP / f"crop_{uuid.uuid4().hex[:8]}.jpg")]
        else:
            for ref in body.refs:
                up = s.get(Upload, ref.upload_id)
                if up is None:
                    continue
                infos.append(prompt.RefInfo(kind=up.kind, name=up.orig_name, with_audio=ref.with_audio))
                if up.kind == "image":
                    images.append(Path(up.path))
    system = prompt.edit_system(infos, body.duration, face=body.face is not None)
    user = (f"Текущий промпт:\n```text\n{body.prompt.strip()}\n```\n\n"
            f"Что изменить (слова пользователя):\n{body.instruction.strip()}\n\nВерни полный исправленный промпт.")
    return _sse(svc.stream(system, user, images))


# ---------------------------------------------------------------- face refine prompt
@router.post("/face-prompt")
async def face_prompt(body: FaceIn, request: Request):
    svc = _svc(request)
    if (busy := _precheck(svc)) is not None:
        return busy
    with session() as s:
        asset = s.get(MediaAsset, body.source_asset_id)
        identity = s.get(Upload, body.identity_upload_id)
        gen = s.get(Generation, asset.generation_id) if asset and asset.generation_id else None
    if asset is None or identity is None:
        raise HTTPException(404, "клип или фото не найдены")
    source_prompt = ""
    if gen:
        source_prompt = (gen.ui_params or {}).get("prompt", "")
        if gen.kind == "face" and gen.source_asset_id:  # refining a refined clip: use the original clip's prompt
            with session() as s:
                orig = s.get(MediaAsset, gen.source_asset_id)
                og = s.get(Generation, orig.generation_id) if orig and orig.generation_id else None
            source_prompt = (og.ui_params or {}).get("prompt", source_prompt) if og else source_prompt

    TMP.mkdir(parents=True, exist_ok=True)
    stamp = uuid.uuid4().hex[:8]
    crop_path = _crop(Path(identity.path), body.closeup_crop, TMP / f"crop_{stamp}.jpg")
    frame_path = TMP / f"frame_{stamp}.jpg"
    try:
        await library.extract_frame(Path(asset.path), frame_path, (asset.duration or 2) / 2)
    except RuntimeError:
        frame_path = None
    images = [Path(identity.path), crop_path] + ([frame_path] if frame_path else [])
    # the model tends to paraphrase ("says the Russian phrase"); hand it the exact lines instead
    lines = prompt.dialogue_lines(source_prompt)
    must = ("Реплики клипа — ОБЯЗАТЕЛЬНО вставь каждую в detailed_description дословно, в том же порядке:\n"
            + "\n".join(lines) + "\n\n") if lines else "Реплик в клипе нет — <d>...</d> не пиши.\n\n"
    user = ("Исходный промпт клипа (для общего контекста; не описывай общий план):\n"
            f"{source_prompt.strip() or '(нет — клип импортирован, реплик не известно)'}\n\n"
            f"{must}"
            "Прикреплены: 1) <Picture 1> — фото персонажа; 2) <Picture 2> — крупный план лица из него; "
            f"{'3) кадр исходного клипа (НЕ референс). ' if frame_path else ''}"
            "Напиши промпт крупного плана для улучшения лица.")
    return _sse(svc.stream(prompt.face_system(), user, images))


def _crop(src: Path, crop: dict | None, dest: Path) -> Path:
    """The <Picture 2> close-up as LoadImageCrop will produce it."""
    import cv2
    import numpy as np

    img = cv2.imdecode(np.fromfile(str(src), dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None or not crop:
        return src
    h, w = img.shape[:2]
    x0, y0 = max(0, round(crop["x"] * w)), max(0, round(crop["y"] * h))
    x1, y1 = min(w, round((crop["x"] + crop["w"]) * w)), min(h, round((crop["y"] + crop["h"]) * h))
    if x1 - x0 < 8 or y1 - y0 < 8:
        return src
    ok, buf = cv2.imencode(".jpg", img[y0:y1, x0:x1], [cv2.IMWRITE_JPEG_QUALITY, 92])
    if ok:
        dest.write_bytes(buf.tobytes())
        return dest
    return src
