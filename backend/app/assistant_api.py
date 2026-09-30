"""Assistant API: plain words -> prompt, face refine prompt, model download and settings."""

import json
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel

from . import settings
from .db.models import AssistantChat, ClipProject, Generation, MediaAsset, Upload, select, session, utcnow
from .llm import config, prompt
from .llm.downloader import downloads
from .llm.registry import CHOICES, FILES
from .llm.service import AssistantBusy, AssistantService
from .media import library
from .workflow.camera import user_camera_directive
from .workflow.cinematography import resolve_cinematic_technique_ids
from .workflow.light import user_light_directive

router = APIRouter(prefix="/api/assistant")
TMP = settings.DATA_DIR / "assistant_tmp"


def _expert_directives(camera: str, light: str, techniques: list[str]) -> str:
    """Legacy helper kept for chat; compose/edit use prompt.plain_selects_block instead."""
    from .workflow.cinematography import user_cinematic_technique_directive
    parts = [user_camera_directive(camera), user_light_directive(light),
             user_cinematic_technique_directive(techniques)]
    return "\n\n".join(p for p in parts if p)


def _svc(request: Request) -> AssistantService:
    return request.app.state.assistant


def _sse(gen, *, scrub_style_slogans: bool = False):
    async def body():
        async for event in gen:
            if scrub_style_slogans and event.get("done") and event.get("prompt"):
                from .workflow import presets
                catalog = presets._all_style_triggers()
                cleaned = presets.scrub_style_triggers(event["prompt"], keep=[], catalog=catalog)
                event = {**event, "prompt": cleaned}
                if isinstance(event.get("text"), str):
                    event["text"] = presets.scrub_style_triggers(event["text"], keep=[], catalog=catalog)
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
    look: str = "cinema"
    camera: str = "auto"
    light: str = "auto"
    cinematic_technique: str = "auto"
    cinematic_techniques: list[str] = []


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
    techniques = resolve_cinematic_technique_ids(body.cinematic_techniques, body.cinematic_technique,
                                                  body.camera, body.light)
    # Keep vision for identity when the user talks about appearance/refs; otherwise text+selects only.
    if not prompt.use_reference_images_for_edit(body.text, techniques):
        images = []
    system = prompt.compose_system(infos, body.duration)
    user = prompt.compose_user_message(
        body.text,
        look=body.look,
        camera=body.camera,
        light=body.light,
        cinematic_techniques=techniques,
    )
    return _sse(
        _checked_prompt_edit(svc, system, user, images, "", body.text.strip(), techniques, infos),
        scrub_style_slogans=True,
    )


# ---------------------------------------------------------------- edit a finished prompt in plain words
class FaceIn(BaseModel):
    source_asset_id: int
    identity_upload_id: str
    closeup_crop: dict[str, float] | None = None


class EditIn(BaseModel):
    prompt: str  # current prompt (model text with <Picture N> tags)
    instruction: str = ""  # what to change, in plain words (optional if expert camera/light set)
    refs: list[ComposeRef] = []
    duration: float = 2.0
    look: str = "cinema"
    camera: str = "auto"
    light: str = "auto"
    cinematic_technique: str = "auto"
    cinematic_techniques: list[str] = []
    face: FaceIn | None = None  # set when editing a face refine prompt


# How many focused LLM repair passes after the first draft (refs/completion only).
_MAX_PROMPT_REPAIRS = 2


def _prompt_edit_issues(source: str, instruction: str, candidate: str,
                        cinematic_technique: str | list[str], technique_ids: list[str],
                        refs: list[prompt.RefInfo] | None, finish_reason: str | None) -> list[str]:
    """Only structural checks — technique content is left to the MD spec + plain selects."""
    del source, instruction, cinematic_technique, technique_ids
    issues = prompt.reference_tag_issues(refs, candidate)
    issues.extend(prompt.prompt_completion_issues(candidate, finish_reason))
    return issues


def _repair_message(source: str, instruction: str, user: str, technique_ids: list[str],
                    candidate: str, issues: list[str]) -> str:
    del technique_ids
    repair_context = f"Исходная просьба пользователя: {instruction}\n" if source else user
    return (
        f"{repair_context}\n\nТекущий черновик, в котором нужно исправить ошибки:\n```text\n{candidate}\n```\n\n"
        f"Проверка запроса не пройдена: {', '.join(issues)}\n"
        "Исправь перечисленные несоответствия. Верни все обязательные метки "
        "<Picture N>/<Video N>/<Audio N> для прикреплённых референсов. "
        "Закончи все разделы и закрой все теги референсов. "
        "Верни полный промпт в требуемом формате."
    )


async def _checked_prompt_edit(svc, system: str, user: str, images: list[Path],
                               source: str, instruction: str,
                               cinematic_technique: str | list[str] = "auto",
                               refs: list[prompt.RefInfo] | None = None):
    """One draft (+ short repair only for missing refs / truncated output). Always yield a prompt."""
    technique_ids = ([cinematic_technique] if isinstance(cinematic_technique, str)
                     else list(cinematic_technique))

    done = None
    async for event in svc.stream(system, user, images):
        if "done" in event:
            done = event
        elif event.get("stage"):
            yield {"stage": "writing" if event["stage"] != "loading" else "loading"}

    if done is None or done.get("cancelled"):
        if done is not None:
            yield done
        return

    candidate = done.get("prompt", "") or ""
    issues = _prompt_edit_issues(source, instruction, candidate, cinematic_technique, technique_ids,
                                 refs, done.get("finish_reason"))

    for _ in range(_MAX_PROMPT_REPAIRS):
        if not issues:
            break
        yield {"stage": "repairing"}
        repair = _repair_message(source, instruction, user, technique_ids, candidate, issues)
        next_done = None
        async for event in svc.stream(system, repair, images):
            if "done" in event:
                next_done = event
            elif event.get("stage"):
                yield {"stage": "repairing"}
        if next_done is None or next_done.get("cancelled"):
            if next_done is not None:
                yield next_done
            return
        done = next_done
        candidate = done.get("prompt", "") or candidate
        issues = _prompt_edit_issues(source, instruction, candidate, cinematic_technique, technique_ids,
                                     refs, done.get("finish_reason"))

    if issues:
        # Mechanical ref-tag fix only — no technique marker injection.
        candidate = prompt.enforce_reference_tags(refs, candidate)

    yield {
        "done": True,
        "prompt": candidate,
        "text": done.get("text") or candidate,
        "cancelled": False,
        "finish_reason": done.get("finish_reason"),
    }


@router.post("/edit")
def edit(body: EditIn, request: Request):
    svc = _svc(request)
    if not body.prompt.strip():
        raise HTTPException(422, "Нет промпта для правки")
    techniques = resolve_cinematic_technique_ids(body.cinematic_techniques, body.cinematic_technique,
                                                  body.camera, body.light)
    expert_ok = body.face is None and (body.camera != "auto" or body.light != "auto" or bool(techniques))
    if not body.instruction.strip() and not expert_ok:
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
    if body.face is None and not prompt.use_reference_images_for_edit(body.instruction, techniques):
        images = []
    system = prompt.edit_system(infos, body.duration, face=body.face is not None)
    instruction = body.instruction.strip()
    if not instruction and body.face is None:
        instruction = (
            "Apply the selected options below to the prompt; keep the rest of the scene and structure."
        )
    if body.face is not None:
        user = (f"Текущий промпт:\n```text\n{body.prompt.strip()}\n```\n\n"
                f"Что изменить:\n{instruction}\n\nВерни полный исправленный промпт.")
    else:
        user = prompt.edit_user_message(
            body.prompt,
            instruction,
            look=body.look,
            camera=body.camera,
            light=body.light,
            cinematic_techniques=techniques,
        )

    return _sse(_checked_prompt_edit(svc, system, user, images, body.prompt, instruction,
                                    techniques, infos),
                scrub_style_slogans=True)


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


# ---------------------------------------------------------------- ideas chat
ATTACH_DIR = settings.DATA_DIR / "chat_attachments"  # chat-only files: never generation references
MAX_CHATS = 20
HISTORY_LIMIT = 60  # studio pre-cap; the service trims further by tokens


def _chat_title(text: str) -> str:
    line = " ".join(text.split())
    return (line[:40] + "…") if len(line) > 40 else (line or "Новый чат")


@router.get("/chats")
def list_chats():
    with session() as s:
        rows = s.exec(select(AssistantChat).order_by(AssistantChat.updated.desc())).all()
    return [{"id": c.id, "title": c.title, "updated": c.updated, "count": len(c.messages or [])} for c in rows]


@router.post("/chats")
def create_chat():
    chat = AssistantChat(id=uuid.uuid4().hex[:12])
    with session() as s:
        s.add(chat)
        # keep the most recent MAX_CHATS, as the studio does
        old = s.exec(select(AssistantChat).order_by(AssistantChat.updated.desc()).offset(MAX_CHATS)).all()
        protected = {p.chat_id for p in s.exec(select(ClipProject)).all()}
        for c in old:
            if c.id not in protected:
                s.delete(c)
        s.commit()
    return chat


@router.get("/chats/{cid}")
def get_chat(cid: str):
    with session() as s:
        return s.get(AssistantChat, cid) or _404()


@router.delete("/chats/{cid}")
def delete_chat(cid: str, request: Request):
    svc = _svc(request)
    if svc.chat_id == cid:
        svc.cancel()
    with session() as s:
        if s.exec(select(ClipProject).where(ClipProject.chat_id == cid)).first():
            raise HTTPException(409, "Этот чат связан с проектом клипа и хранит его обсуждение")
        if chat := s.get(AssistantChat, cid):
            s.delete(chat)
            s.commit()
    return {"ok": True}


@router.post("/attachments")
async def upload_attachment(file: UploadFile = File(...)):
    if library.kind_of(file.filename or "") != "image":
        raise HTTPException(415, "Во вложения чата можно добавить только картинку")
    ATTACH_DIR.mkdir(parents=True, exist_ok=True)
    aid = uuid.uuid4().hex[:16] + Path(file.filename).suffix.lower()
    (ATTACH_DIR / aid).write_bytes(await file.read())
    return {"id": aid, "name": file.filename}


@router.get("/attachments/{aid}")
def get_attachment(aid: str):
    path = ATTACH_DIR / Path(aid).name
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path)


class ChatIn(BaseModel):
    text: str
    attachment: dict | None = None  # {id, name} from /attachments
    refs: list[ComposeRef] = []  # the generation panel's current references
    draft: str = ""  # the generation panel's current prompt
    duration: float = 2.0
    look: str = "cinema"
    camera: str = "auto"
    light: str = "auto"
    cinematic_technique: str = "auto"
    cinematic_techniques: list[str] = []


@router.post("/chats/{cid}/send")
def send(cid: str, body: ChatIn, request: Request):
    svc = _svc(request)
    with session() as s:
        if s.exec(select(ClipProject).where(ClipProject.chat_id == cid)).first():
            raise HTTPException(409, "Продолжите обсуждение в режиме «Клип» — там сохраняется паспорт и контекст проекта")
    if not body.text.strip() and not body.attachment:
        raise HTTPException(422, "Напишите сообщение")
    if (busy := _precheck(svc)) is not None:
        return busy
    with session() as s:
        chat = s.get(AssistantChat, cid) or _404()
        msg = {"role": "user", "content": body.text.strip()}
        if body.attachment:
            msg["attachment"] = {"id": Path(body.attachment["id"]).name, "name": body.attachment.get("name", "")}
        chat.messages = [*(chat.messages or []), msg]
        if chat.title == "Новый чат":
            chat.title = _chat_title(body.text or msg.get("attachment", {}).get("name", ""))
        chat.updated = utcnow()
        s.add(chat)
        s.commit()
        infos, images = [], []
        fresh = sum(m["role"] == "user" for m in chat.messages) <= 1  # studio правка 166
        if not fresh:
            for ref in body.refs:
                up = s.get(Upload, ref.upload_id)
                if up is None:
                    continue
                infos.append(prompt.RefInfo(kind=up.kind, name=up.orig_name, with_audio=ref.with_audio))
                if up.kind == "image":
                    images.append(Path(up.path))
        history = [_as_llm_message(m) for m in chat.messages[-HISTORY_LIMIT:]]
    if body.attachment and (ATTACH_DIR / msg["attachment"]["id"]).exists():
        images.append(ATTACH_DIR / msg["attachment"]["id"])
        history[-1]["content"] += (f"\n\n[Вложение чата: {msg['attachment']['name']} — прикреплено для описания/анализа, "
                                   "НЕ референс генерации, не называй его <Picture N>]")
    techniques = resolve_cinematic_technique_ids(body.cinematic_techniques, body.cinematic_technique,
                                                  body.camera, body.light)
    system = prompt.chat_system(infos, body.duration, body.draft, fresh, body.look, body.camera, body.light,
                                cinematic_techniques=techniques)

    async def run():
        svc.chat_id = cid
        text = ""
        try:
            async for event in svc.chat(system, history, images):
                if "delta" in event:
                    text += event["delta"]
                yield event
        finally:  # commit even a stopped answer, so the chat keeps what was shown
            svc.chat_id = None
            if text.strip():
                with session() as s:
                    if chat := s.get(AssistantChat, cid):
                        chat.messages = [*(chat.messages or []), {"role": "assistant", "content": text}]
                        chat.updated = utcnow()
                        s.add(chat)
                        s.commit()
    return _sse(run())


def _as_llm_message(m: dict) -> dict:
    content = m.get("content", "")
    if m.get("attachment"):  # older attachments are not re-sent: only named, so the model knows they existed
        content = (content + f"\n\n[Вложение чата: {m['attachment'].get('name', '')}]").strip()
    return {"role": m["role"], "content": content}


def _404():
    raise HTTPException(404, "не найдено")
