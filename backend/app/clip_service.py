"""Durable clip jobs and directing proposals, using the existing assistant and video queue."""

import asyncio
import json
import re
import threading
import uuid
from pathlib import Path

from fastapi import HTTPException
from pydantic import ValidationError

from .clip_schema import (AudioAnalysis, BlockDraft, BlockVersion, ClipBlock, ClipDocument,
                          EditorialReview, Treatment, check_coverage)
from .db.models import (AssistantChat, ClipJob, ClipProject, ClipRevision, Generation, MediaAsset, Project,
                        Upload, select, session, utcnow)
from .hub import hub
from .llm import prompt as h3_prompt
from .media import clip_audio, library
from .timeline_schema import PlanBlock
from .workflow.params import FPS, frame_count

ACTIVE = ("queued", "running")
DIRECTING = """Ты режиссёр музыкального клипа. Общайся по-русски. Решения в паспорте обязательны.
Сначала постановочная идея и причина смотреть, затем камера. Не заменяй идеи сменой крупностей,
фонов или одинаковыми перформансами. Стерильно = предсказуемая постановка, не чистота локации.
Строй контраст события, реакции, паузы, нового импульса. Музыка не требует склейки на каждый бит.
Не иллюстрируй все слова буквально. Используй конкретное пространство, перекрытия и реакции.
Разделяй героя, камеру и фон; описывай контакты, анатомическую сторону рук и экранное направление.
Один кадр — одно мотивированное движение камеры или неподвижная камера. Для каждого кадра нужна
Camera Behavior Card. Не меняй лицо, комплекцию, костюм, палитру и границы аудио без просьбы.
Анализ аудио — измерения и неточная расшифровка; ты не слышишь трек. Не выдумывай услышанные звуки.
Предложение не означает запуск генерации. Не объявляй движение или липсинк проверенными по фото.
"""


def get_clip(cid: str) -> ClipProject:
    with session() as s:
        row = s.get(ClipProject, cid)
        if row is None:
            raise HTTPException(404, "Проект клипа не найден")
        return row


def save_document(cid: str, revision: int, document: ClipDocument) -> ClipProject:
    from sqlalchemy import update

    with session() as s:
        previous = s.get(ClipProject, cid)
        if previous is None or previous.revision != revision:
            raise HTTPException(409, "Проект изменился — обновите предложение, ваши изменения сохранены")
        archive = ClipRevision(clip_id=cid, revision=revision, document=previous.document)
        result = s.execute(update(ClipProject).where(ClipProject.id == cid, ClipProject.revision == revision)
                           .values(document=document.model_dump(), revision=revision + 1, updated=utcnow()))
        if result.rowcount != 1:
            raise HTTPException(409, "Проект изменился — обновите предложение, ваши изменения сохранены")
        s.add(archive)
        s.commit()
    return get_clip(cid)


def generations(cid: str) -> list[Generation]:
    row = get_clip(cid)
    with session() as s:
        all_rows = list(s.exec(select(Generation).where(Generation.project_id == row.project_id).order_by(Generation.id)).all())
    result = [g for g in all_rows if (g.info or {}).get("clip_id") == cid]
    included = {g.id for g in result}
    # Refinement remains a separate job; inherit only shot provenance, never an execution job id.
    changed = True
    while changed:
        changed = False
        owners = {aid: g for g in result for aid in (g.output_asset_id, g.draft_asset_id) if aid}
        for g in all_rows:
            parent = owners.get(g.source_asset_id)
            if g.id in included or g.kind not in ("face", "enhance") or parent is None:
                continue
            inherited = {k: (parent.info or {}).get(k) for k in ("clip_id", "block_id", "block_version", "shot_id", "plan_mode")}
            result.append(g.model_copy(update={"info": {**(g.info or {}), **inherited, "clip_derived_from": parent.id}}))
            included.add(g.id)
            changed = True
    return sorted(result, key=lambda g: g.id)


def snapshot(cid: str) -> dict:
    row = get_clip(cid)
    with session() as s:
        jobs = s.exec(select(ClipJob).where(ClipJob.clip_id == cid).order_by(ClipJob.created.desc())).all()
    return {**row.model_dump(), "jobs": [j.model_dump() for j in jobs],
            "takes": [g.model_dump() for g in generations(cid)]}


def block_by_id(doc: ClipDocument, bid: str) -> ClipBlock:
    block = next((b for b in doc.blocks if b.id == bid), None)
    if block is None:
        raise ValueError("Блок не найден — обновите проект")
    return block


def decode_json(text: str, schema):
    text = text.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    try:
        return schema.model_validate_json(fenced.group(1) if fenced else text)
    except ValidationError as exc:
        raise ValueError("Ассистент вернул неполное или некорректное предложение. "
                         "Повторите операцию. Утверждённые решения сохранены.") from exc


def incomplete_json(text: str, schema) -> bool:
    try:
        decode_json(text, schema)
    except ValueError as exc:
        cause = exc.__cause__
        return isinstance(cause, ValidationError) and any(
            e["type"] == "json_invalid" and "EOF" in e.get("ctx", {}).get("error", "")
            for e in cause.errors()
        )
    return False


def align_shots_to_block(shots, start: float, end: float) -> None:
    """Snap sub-frame boundary drift to adjacent frames while preserving real gaps."""
    start_frame, end_frame = round(start * FPS), round(end * FPS)
    cursor = start_frame
    for index, shot in enumerate(shots):
        model_start = round(shot.start * FPS)
        model_end = round((shot.start + shot.duration) * FPS)
        if abs(model_start - cursor) > 1:
            raise ValueError(f"Кадры блока должны идти подряд: проверьте границу около {cursor / FPS:.2f} с")
        duration_frames = model_end - model_start
        if duration_frames < 1:
            raise ValueError("Длительность кадра должна быть не меньше одного кадра")
        next_frame = cursor + duration_frames
        if index == len(shots) - 1:
            if abs(next_frame - end_frame) > 1:
                raise ValueError(f"Кадры должны закрывать интервал до {end:.2f} с")
            next_frame = end_frame
        shot.start = cursor / FPS
        shot.duration = (next_frame - cursor) / FPS
        cursor = next_frame
    if cursor != end_frame:
        raise ValueError(f"Кадры должны закрывать интервал до {end:.2f} с")


def ref_tags(ids: list[str]) -> tuple[dict[str, str], list[h3_prompt.RefInfo], list[Path]]:
    counts = {"image": 0, "video": 0, "audio": 0}
    names = {"image": "Picture", "video": "Video", "audio": "Audio"}
    tags, infos, images = {}, [], []
    with session() as s:
        for uid in ids:
            up = s.get(Upload, uid)
            if up is None or not Path(up.path).is_file():
                raise ValueError("Референс отсутствует — прикрепите его снова")
            counts[up.kind] += 1
            if counts[up.kind] > (9 if up.kind == "image" else 3):
                raise ValueError("Слишком много референсов одного типа")
            tags[uid] = f"<{names[up.kind]} {counts[up.kind]}>"
            infos.append(h3_prompt.RefInfo(kind=up.kind, name=up.orig_name, with_audio=False))
            if up.kind == "image":
                images.append(Path(up.path))
    return tags, infos, images


def context(doc: ClipDocument) -> str:
    data = doc.model_dump()
    # Long songs must not evict the passport. Only structural audio facts enter the LLM context.
    if data["analysis"]:
        a = data["analysis"]
        data["analysis"] = {k: a[k] for k in ("sections", "lyrics", "warnings", "repetitions", "pauses")}
        data["analysis"]["lyrics"] = a["lyrics"][:12000]
        data["analysis"]["energy"] = a["energy"][::max(1, len(a["energy"]) // 256)]
        data["analysis"]["strong_changes"] = sorted(sorted(a["changes"], key=lambda p: p[1], reverse=True)[:32])
    data["messages"] = data["messages"][-12:]
    data["blocks"] = [{k: v for k, v in b.items() if k != "versions"} for b in data["blocks"]]
    return json.dumps(data, ensure_ascii=False)


class ClipManager:
    def __init__(self, assistant, jobs):
        self.assistant, self.jobs = assistant, jobs
        self.tasks: dict[str, asyncio.Task] = {}
        self.cancels: dict[str, threading.Event] = {}
        self.llm_lock = asyncio.Lock()
        self.owned_llm_job: str | None = None

    async def start(self):
        with session() as s:
            pending = s.exec(select(ClipJob).where(ClipJob.status.in_(ACTIVE))).all()
            for job in pending:
                if job.kind == "generate":
                    self._spawn(job.id, resume=True)
                else:
                    job.status = "interrupted"
                    job.stage = "Прервано перезапуском"
                    job.error = "Повторите операцию. Утверждённые решения сохранены."
                    s.add(job)
            s.commit()

    async def stop(self):
        for event in self.cancels.values():
            event.set()
        if self.owned_llm_job:
            self.assistant.cancel()
        for task in list(self.tasks.values()):
            task.cancel()
        await asyncio.gather(*list(self.tasks.values()), return_exceptions=True)

    def _spawn(self, jid: str, resume=False):
        self.cancels[jid] = threading.Event()
        task = asyncio.create_task(self._run(jid, resume))
        self.tasks[jid] = task
        task.add_done_callback(lambda _: self.tasks.pop(jid, None))

    def create(self, cid: str, kind: str, revision: int, request: dict) -> ClipJob:
        if cid:
            row = get_clip(cid)
            if row.revision != revision:
                raise HTTPException(409, "Проект изменился — обновите страницу")
        with session() as s:
            existing = s.exec(select(ClipJob).where(ClipJob.clip_id == cid, ClipJob.status.in_(ACTIVE))).first()
            if existing:
                # The persisted operation also acts as a double-click guard.
                if existing.kind == kind and existing.base_revision == revision and existing.request == request:
                    return existing
                raise HTTPException(409, "Дождитесь текущей операции или остановите её")
            job = ClipJob(id=uuid.uuid4().hex, clip_id=cid, kind=kind, base_revision=revision, request=request)
            s.add(job)
            s.commit()
        self._spawn(job.id)
        return job

    async def update(self, jid: str, **fields):
        with session() as s:
            row = s.get(ClipJob, jid)
            for k, v in fields.items():
                setattr(row, k, v)
            row.updated = utcnow()
            s.add(row)
            s.commit()
            event = {"type": "clip_job", "clip_id": row.clip_id, "job": row.model_dump()}
        await hub.broadcast(event)

    async def cancel(self, jid: str):
        with session() as s:
            job = s.get(ClipJob, jid)
        if not job or job.status not in ACTIVE:
            return
        self.cancels.setdefault(jid, threading.Event()).set()
        if self.owned_llm_job == jid:
            self.assistant.cancel()
        if job.kind == "generate":
            for g in generations(job.clip_id):
                if (g.info or {}).get("clip_job_id") == jid and g.status in ACTIVE:
                    await self.jobs.cancel(g.id)
        await self.update(jid, stage="Останавливаю…")

    def check(self, jid: str):
        if self.cancels[jid].is_set():
            raise InterruptedError("Операция остановлена")

    async def llm(self, jid: str, system: str, user: str, images=None, schema=None) -> str:
        async with self.llm_lock:
            self.check(jid)
            self.assistant.precheck()
            self.owned_llm_job = jid
            text = ""
            if schema:
                system += "\nВерни только JSON, без markdown, точно по схеме:\n" + json.dumps(schema.model_json_schema(), ensure_ascii=False)
            try:
                request = user
                request_system = system
                # Keep the model's output budget; resume only an unfinished JSON value.
                for attempt in range(3):
                    completed = False
                    finish_reason = None
                    async for event in self.assistant.stream(request_system, request, images or []):
                        self.check(jid)
                        if event.get("error"):
                            raise ValueError("Ошибка ассистента: " + str(event["error"]))
                        text += event.get("delta", "")
                        if event.get("done") and not event.get("cancelled"):
                            completed = True
                            finish_reason = event.get("finish_reason")
                    self.check(jid)
                    if not completed:
                        raise ValueError("Ответ ассистента не завершён. Повторите операцию")
                    if not schema:
                        if finish_reason == "length":
                            raise ValueError("Ответ ассистента достиг лимита длины. Повторите операцию")
                        break
                    if not incomplete_json(text, schema) or attempt == 2:
                        decode_json(text, schema)
                        break
                    await self.update(jid, stage="Продолжаю незавершённый ответ")
                    request_system = system + ("\nРежим продолжения: начало JSON уже получено. "
                                               "Верни только его недостающий хвост, чтобы вместе "
                                               "с префиксом он соответствовал схеме. Не повторяй префикс.")
                    request = (user + "\nОтвет оборвался. Продолжи JSON точно с места обрыва, "
                               "включая незавершённую строку. Верни только недостающий хвост: "
                               "без повторения начала, пояснений и markdown. Уже полученный префикс:\n" + text)
            finally:
                self.owned_llm_job = None
            return text

    async def _run(self, jid: str, resume: bool):
        with session() as s:
            job = s.get(ClipJob, jid)
        try:
            await self.update(jid, status="running", stage="Начинаю", error=None)
            if job.kind == "download_audio":
                await self.update(jid, stage="Скачиваю medium для распознавания слов")
                await asyncio.to_thread(clip_audio.download_model)
                result = {"ready": clip_audio.model_ready()}
            else:
                row = get_clip(job.clip_id)
                doc = ClipDocument.model_validate(row.document)
                if job.kind == "analyze":
                    with session() as s:
                        asset = s.get(MediaAsset, doc.audio_asset_id)
                    loop = asyncio.get_running_loop()
                    def progress(p, stage):
                        asyncio.run_coroutine_threadsafe(self.update(jid, progress=p, stage=stage), loop).result()
                    result = {"analysis": await asyncio.to_thread(clip_audio.analyze, Path(asset.path),
                              doc.audio_start, doc.audio_end, self.cancels[jid], progress)}
                elif job.kind == "discuss":
                    _, _, images = ref_tags(doc.ref_ids)
                    answer = await self.llm(jid, DIRECTING + "\nОбсуди замысел. Задавай не более трёх важных вопросов за раз. "
                                            "При запросе концепций предложи 2–3 разных постановочных решения. Промпты пока не пиши.",
                                            context(doc) + "\nСообщение пользователя:\n" + job.request["text"], images)
                    self.check(jid)
                    doc.messages += [{"role": "user", "content": job.request["text"]}, {"role": "assistant", "content": answer}]
                    saved = save_document(row.id, job.base_revision, doc)
                    with session() as s:
                        chat = s.get(AssistantChat, row.chat_id)
                        if chat:
                            chat.messages = doc.messages
                            chat.updated = utcnow()
                            s.add(chat)
                            s.commit()
                    result = {"text": answer, "revision": saved.revision}
                elif job.kind == "treatment":
                    await self.update(jid, stage="Предлагаю паспорт и структуру клипа")
                    _, _, images = ref_tags(doc.ref_ids)
                    text = await self.llm(jid, DIRECTING, context(doc) + "\nСоставь паспорт по обсуждению и блоки на всю длину "
                                          f"{doc.audio_end - doc.audio_start:.6f} секунд. Время блоков от нуля клипа, без пропусков. "
                                          "Обычно блок занимает 12–24 секунды и содержит несколько разных кадров. "
                                          "Названия и намерения по-русски. " + job.request.get("text", ""), images, schema=Treatment)
                    treatment = decode_json(text, Treatment)
                    check_coverage([(b.start, b.end) for b in treatment.blocks], 0, doc.audio_end - doc.audio_start)
                    for b in treatment.blocks:
                        b.id = uuid.uuid4().hex[:12]
                    result = treatment.model_dump()
                elif job.kind == "develop":
                    result = await self._develop(job, doc)
                elif job.kind == "generate":
                    result = await self._generate(job, doc, row.project_id, resume)
                elif job.kind == "review":
                    result = await self._review(job, doc)
                elif job.kind == "preview":
                    result = await self._preview(job, doc, row.project_id)
                else:
                    raise ValueError("Неизвестная операция")
            self.check(jid)
            await self.update(jid, status="done", stage="Готово", progress=1, result=result)
        except InterruptedError:
            await self.update(jid, status="cancelled", stage="Остановлено")
        except asyncio.CancelledError:
            # Persisted running jobs are reconciled at next startup; no automatic creative retries.
            raise
        except Exception as e:
            import logging
            logging.getLogger("shellmax.clip").exception("clip job %s failed", jid)
            detail = e.detail if isinstance(e, HTTPException) else str(e)
            await self.update(jid, status="error", stage="Нужна правка", error=str(detail))
        finally:
            self.cancels.pop(jid, None)

    async def _develop(self, job, doc):
        if not doc.passport_approved:
            raise ValueError("Сначала утвердите паспорт клипа")
        block = block_by_id(doc, job.request["block_id"])
        await self.update(job.id, stage="Ставлю кадры блока")
        _, _, images = ref_tags(doc.ref_ids)
        block_context = block.model_dump(exclude={"versions"})
        if doc.analysis:
            lo, hi = doc.audio_start + block.start, doc.audio_start + block.end
            block_context["measured_audio"] = {
                "timespace": "source_file", "clip_time_offset": doc.audio_start,
                "beats": [t for t in doc.analysis.beats if lo <= t < hi],
                "energy": [p for p in doc.analysis.energy if lo <= p[0] < hi],
                "words": [w.model_dump() for w in doc.analysis.words if lo <= w.start < hi],
            }
        if block.versions:
            block_context["current_shots"] = [s.model_dump(exclude={"prompt"}) for s in block.versions[-1].shots]
        user = context(doc) + "\nБлок:\n" + json.dumps(block_context, ensure_ascii=False) + "\nПравка пользователя:\n" + job.request.get("text", "")
        request = (user + "\nРазработай кадры блока без пропусков. Время от начала клипа. "
                   "ref_ids — только из проекта. prompt оставь пустым. "
                   "Camera Behavior Card — это обязательное поле camera в каждом Shot: заполни все его поля "
                   "из схемы. Крепление камеры опиши реально существующей опорой (например, штатив или "
                   "моторизованная головка), а не транспортом. Не добавляй движения, оптику, свет, реквизит, "
                   "татуировки, липсинк или музыкальные события, которых нет в паспорте, исходных данных "
                   "или правке пользователя. В ритме опирайся только на переданные измерения; не требуй "
                   "склейки на каждый бит.")

        def validate_draft(raw):
            candidate = decode_json(raw, BlockDraft)
            align_shots_to_block(candidate.shots, block.start, block.end)
            for shot in candidate.shots:
                if not set(shot.ref_ids) <= set(doc.ref_ids):
                    raise ValueError("Ассистент предложил отсутствующие референсы — повторите разработку")
                shot.id = uuid.uuid4().hex[:12]
            check_coverage([(x.start, x.start + x.duration) for x in candidate.shots], block.start, block.end)
            return candidate

        draft = validate_draft(await self.llm(job.id, DIRECTING, request, images, BlockDraft))
        await self.update(job.id, stage="Проверяю постановку и канон", progress=0.2)
        review = None
        for attempt in range(3):
            rubric = ("Проверь предложение только по данным паспорта, анализу и правке пользователя. "
                      "Не добавляй новых требований. Поле camera — это Camera Behavior Card; его физическая "
                      "опора, старт, траектория, ориентация, оптика/фокус, скорость, якорь/параллакс и конечный "
                      "кадр уже заданы отдельными полями схемы. Не требуй буквального имени camera_behavior_card. "
                      "Отклоняй только конкретное противоречие паспорту, недостающие обязательные поля, реальную "
                      "ошибку физики или перекрытие/пропуск границ. Не требуй точной привязки к битам, активации "
                      "деталей костюма, эффектов или реквизита, если их нет во входных данных. Срезы оценивай "
                      "по входящему/исходящему кадру, не по наличию англоязычного названия типа перехода. "
                      "Различай lipsync и обычную мимику/движение головы. Если конкретного нарушения нет, approved=true.")
            review = decode_json(await self.llm(job.id, DIRECTING,
                user + "\n" + rubric + "\nПредложение:\n" + draft.model_dump_json(), schema=EditorialReview), EditorialReview)
            if review.approved:
                break
            if attempt == 2:
                raise ValueError("Не удалось исправить конкретные замечания редактора за две попытки: "
                                 + "; ".join(review.notes) + ". Уточните идею и повторите разработку.")
            await self.update(job.id, stage=f"Исправляю замечания редактора ({attempt + 1}/2)")
            repair = (request + "\nРедактор отметил конкретные проблемы в предложении ниже. Исправь только "
                      "обоснованные замечания, которые следуют из паспорта и исходных данных. Поля схемы "
                      "обязательны; используй существующий camera как карточку поведения камеры. "
                      "Сохрани длительности и непрерывное покрытие блока. Замечания:\n"
                      + json.dumps(review.notes, ensure_ascii=False) + "\nТекущее предложение:\n"
                      + draft.model_dump_json())
            draft = validate_draft(await self.llm(job.id, DIRECTING, repair, images, BlockDraft))
        for i, shot in enumerate(draft.shots):
            self.check(job.id)
            await self.update(job.id, stage=f"Пишу промпт кадра {i + 1}/{len(draft.shots)}", progress=0.3 + 0.6 * i / len(draft.shots))
            tags, infos, images = ref_tags(shot.ref_ids)
            system = h3_prompt.compose_system(infos, shot.duration, "cinema", "auto", "auto")
            lyrics = ""
            if doc.analysis:
                lyrics = "".join(w.word for w in doc.analysis.words
                                 if doc.audio_start + shot.start <= w.start < doc.audio_start + shot.start + shot.duration)
            text = await self.llm(job.id, system, "Утверждённый паспорт:\n" + doc.passport.model_dump_json()
                                  + "\nПоставленный кадр:\n" + shot.model_dump_json()
                                  + "\nПредположительно слова фрагмента (при исправлениях приоритет у слов пользователя):\n" + lyrics
                                  + "\nАктуальный текст песни (исправления пользователя приоритетны; не придумывай точную привязку исправлений к губам):\n"
                                  + (doc.analysis.lyrics[:12000] if doc.analysis else "")
                                  + "\nНапиши полный самостоятельный промпт этого единственного кадра. Камера и действие строго по карточке.", images)
            compiled = h3_prompt.extract_prompt(text)
            for field in ("subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"):
                if not re.search(rf"(?m)^\s*{field}\s*:", compiled):
                    raise ValueError("Промпт неполный — повторите разработку блока")
            for uid, tag in tags.items():
                compiled = compiled.replace(tag, "{{ref:" + uid + "}}")
            if re.search(r"<(Picture|Video|Audio)\s+\d+>", compiled):
                raise ValueError("Промпт содержит неподключённый референс — повторите разработку")
            shot.prompt = compiled
        return {"block_id": block.id, "shots": [x.model_dump() for x in draft.shots], "review": review.notes}

    async def _generate(self, job, doc, project_id, resume):
        from . import plans, services
        from .jobs.queue import push_generation
        from .timeline_schema import parse_timeline

        block = block_by_id(doc, job.request["block_id"])
        if not block.versions or block.stale:
            raise ValueError("Сначала разработайте и примите актуальную версию блока")
        version = block.versions[-1]
        mode = job.request["mode"]
        if mode == "final" and not version.draft_approved:
            raise ValueError("Сначала просмотрите и утвердите черновик блока")
        existing = [g for g in generations(job.clip_id) if (g.info or {}).get("clip_job_id") == job.id]
        if not resume:
            with session() as s:
                project = s.get(Project, project_id)
            timeline = parse_timeline(project.timeline)
            expected = proposal_timeline(job.clip_id, block.id)
            audio_track = next((t for t in timeline.tracks if t.id == expected["audio_track"]["id"]), None)
            if not audio_track or audio_track.muted or len(audio_track.clips) != 1:
                raise ValueError("Музыкальная дорожка изменена — примените актуальный блок на таймлайн")
            music = audio_track.clips[0]
            if (music.asset_id, music.in_, music.out, music.start, music.muted) != (doc.audio_asset_id, doc.audio_start, doc.audio_end, 0, False):
                raise ValueError("Границы музыки изменены — обновите проект клипа")
            timeline = timeline.model_copy(update={"tracks": [t for t in timeline.tracks if t.kind != "audio" or t.id == audio_track.id]})
            actual = {p.id: p for t in timeline.tracks for p in t.plans}
            expected_plans = expected["plans"]
            for p in expected_plans:
                actual_plan = actual.get(p["id"])
                if not actual_plan or plan_content(actual_plan) != plan_content(PlanBlock.model_validate(p)):
                    raise ValueError("Планы изменены или не добавлены. Примените текущий блок на таймлайн перед генерацией")
            selected = set(job.request.get("shot_ids") or [s.id for s in version.shots])
            if not selected <= {s.id for s in version.shots}:
                raise ValueError("Кадр не принадлежит текущей версии")
            for shot in version.shots:
                if shot.id not in selected:
                    continue
                self.check(job.id)
                if any((g.info or {}).get("shot_id") == shot.id for g in existing):
                    continue
                p = actual[plan_id(job.clip_id, block.id, version.version, shot.id)]
                ui = await plans.build_ui_params(timeline, p)
                self.check(job.id)
                ui = ui.model_copy(update={"quality": "draft" if mode == "draft" else doc.quality})
                info = {"clip_id": job.clip_id, "clip_job_id": job.id, "block_id": block.id,
                        "block_version": version.version, "shot_id": shot.id, "plan_id": p.id, "plan_mode": mode}
                created = services.create_generations(ui, project_id, info=info)
                existing.extend(created)
                for g in created:
                    await push_generation(g)
                    self.jobs.enqueue(g.id)
        if not existing:
            raise ValueError("Запуск был прерван до создания задач. Запустите блок снова")
        while True:
            self.check(job.id)
            with session() as s:
                current = [s.get(Generation, g.id) for g in existing]
            finished = sum(g is None or g.status not in ACTIVE for g in current)
            await self.update(job.id, stage=f"Генерация: {finished}/{len(current)}", progress=finished / len(current))
            if finished == len(current):
                break
            await asyncio.sleep(2)
        failed = [g.id for g in current if g and g.status in ("error", "cancelled")]
        requested = set(job.request.get("shot_ids") or [s.id for s in version.shots])
        missing = requested - {(g.info or {}).get("shot_id") for g in existing}
        if missing:
            raise ValueError("Запуск прерван: часть кадров не была поставлена в очередь. Готовые дубли сохранены; запустите недостающие кадры отдельно")
        return {"generation_ids": [g.id for g in existing], "failed": failed,
                "needs_review": True, "resumed": resume}

    async def _review(self, job, doc):
        block = block_by_id(doc, job.request["block_id"])
        takes = selected_takes(job.clip_id, block, job.request["mode"], job.request.get("selections", {}))
        images, technical = [], []
        from . import settings
        temp = settings.DATA_DIR / "clip_review" / job.id
        temp.mkdir(parents=True, exist_ok=True)
        with session() as s:
            for shot, g in takes:
                asset = s.get(MediaAsset, g.output_asset_id or g.draft_asset_id)
                if not asset or not Path(asset.path).is_file():
                    raise ValueError("Результат отсутствует — выберите другой дубль")
                if (asset.duration or 0) + 1 / FPS < shot.duration:
                    technical.append(f"{shot.name}: результат короче монтажного кадра")
                for i, fraction in enumerate((0.1, 0.5, 0.9)):
                    dest = temp / f"{shot.id}_{i}.jpg"
                    await library.extract_frame(Path(asset.path), dest, shot.duration * fraction)
                    images.append(dest)
        # Review each shot separately: references plus three frames fit local vision context.
        observations = []
        for i, (shot, _) in enumerate(takes):
            _, _, refs = ref_tags(shot.ref_ids)
            await self.update(job.id, stage=f"Проверяю кадр {i + 1}/{len(takes)}", progress=i / len(takes))
            observations.append(await self.llm(job.id, DIRECTING,
                doc.passport.model_dump_json() + "\n" + shot.model_dump_json() +
                "\nПоследние три изображения — начало, середина, конец дубля, остальные — референсы. "
                "Проверь внешность, композицию и канон. Не утверждай, что проверил движение, склейки или липсинк.",
                refs + images[i * 3:i * 3 + 3]))
        return {"technical": technical, "observations": observations,
                "notice": "Движение, контакты, склейки и липсинк требуют просмотра видео с музыкой"}

    async def _preview(self, job, doc, project_id):
        from .media.timeline_export import export_project_timeline
        await self.update(job.id, stage="Собираю просмотр с исходной музыкой")
        timeline = assembly_timeline(job.clip_id, job.request.get("block_id"), job.request.get("mode", "draft"),
                                     job.request.get("selections", {}), require_approval=False, include_neighbors=True)
        asset = await export_project_timeline(project_id, timeline, check=lambda: self.check(job.id),
                                             progress=lambda p: self.update(job.id, progress=p))
        return {"asset_id": asset.id}


def plan_id(cid, bid, version, sid):
    return f"clip_{cid}_{bid}_{version}_{sid}"


def plan_content(plan: PlanBlock):
    return plan.model_dump(exclude={"status", "generation_id", "draft_asset_id", "output_asset_id", "error", "mode"})


def proposal_timeline(cid: str, bid: str) -> dict:
    row = get_clip(cid)
    doc = ClipDocument.model_validate(row.document)
    block = block_by_id(doc, bid)
    if block.stale or not block.versions:
        raise ValueError("Разработайте актуальный блок")
    version = block.versions[-1]
    audio_id = f"clip_audio_{cid}"
    plans = []
    with session() as s:
        for shot in version.shots:
            refs = []
            for uid in shot.ref_ids:
                up = s.get(Upload, uid)
                if not up:
                    raise ValueError("Референс удалён — прикрепите его снова")
                refs.append({"kind": up.kind, "uploadId": uid})
            plans.append({"id": plan_id(cid, bid, version.version, shot.id), "name": shot.name,
                          "start": shot.start, "duration": shot.duration, "renderDuration": frame_count(shot.duration) / FPS,
                          "prompt": shot.prompt, "refs": refs, "aspect": doc.passport.aspect, "quality": doc.quality,
                          "look": "cinema", "audio": {audio_id: True}, "lipsync": shot.lipsync})
    return {"revision": row.revision, "track_id": f"clip_plans_{cid}_{bid}", "plans": plans,
            "audio_track": {"id": audio_id, "kind": "audio", "name": "Музыка клипа", "plans": [],
                            "clips": [{"id": f"clip_music_{cid}", "assetId": doc.audio_asset_id,
                                       "in": doc.audio_start, "out": doc.audio_end, "start": 0}]}}


def selected_takes(cid, block, mode, selections):
    if not block.versions or block.stale:
        raise ValueError("Блок не разработан или требует пересмотра")
    v = block.versions[-1]
    saved = v.selected_final if mode == "final" else v.selected_draft
    all_takes = generations(cid)
    result = []
    for shot in v.shots:
        candidates = [g for g in all_takes if (g.info or {}).get("block_id") == block.id
                      and (g.info or {}).get("block_version") == v.version
                      and (g.info or {}).get("shot_id") == shot.id and (g.info or {}).get("plan_mode") == mode
                      and g.status in ("done", "draft_only") and (g.output_asset_id or g.draft_asset_id)]
        target = selections.get(shot.id, saved.get(shot.id))
        take = next((g for g in candidates if g.id == target), None) if target else (candidates[-1] if candidates else None)
        if take is None:
            raise ValueError(f"Для кадра «{shot.name}» нет готового выбранного дубля")
        result.append((shot, take))
    return result


def assembly_timeline(cid, bid=None, mode="final", selections=None, require_approval=True, include_neighbors=False):
    row = get_clip(cid)
    doc = ClipDocument.model_validate(row.document)
    blocks = [block_by_id(doc, bid)] if bid else doc.blocks
    if not blocks:
        raise ValueError("Сначала разработайте блоки")
    start, end = blocks[0].start, blocks[-1].end
    if not bid:
        check_coverage([(b.start, b.end) for b in blocks], 0, doc.audio_end - doc.audio_start)
    clips = []
    for block in blocks:
        if require_approval and (not block.versions or not block.versions[-1].final_approved):
            raise ValueError(f"Просмотрите и утвердите финал блока «{block.name}»")
        takes = selected_takes(cid, block, mode, selections or {})
        check_coverage([(s.start, s.start + s.duration) for s, _ in takes], block.start, block.end)
        for shot, g in takes:
            clips.append({"id": shot.id, "assetId": g.output_asset_id or g.draft_asset_id,
                          "in": 0, "out": shot.duration, "muted": True})
    if bid and include_neighbors:
        index = next(i for i, b in enumerate(doc.blocks) if b.id == bid)
        for neighbor_index, before in ((index - 1, True), (index + 1, False)):
            if not 0 <= neighbor_index < len(doc.blocks):
                continue
            neighbor = doc.blocks[neighbor_index]
            try:
                neighbor_takes = selected_takes(cid, neighbor, mode, {})
            except ValueError:
                continue
            shot, g = neighbor_takes[-1 if before else 0]
            length = min(1.0, shot.duration)
            offset = shot.duration - length if before else 0
            clip = {"id": shot.id, "assetId": g.output_asset_id or g.draft_asset_id,
                    "in": offset, "out": offset + length, "muted": True}
            if before:
                clips.insert(0, clip)
                start -= length
            else:
                clips.append(clip)
                end += length
    with session() as s:
        first = s.get(MediaAsset, clips[0]["assetId"])
    return {"outputWidth": first.width if first else None, "outputHeight": first.height if first else None,
            "outputFps": 24, "tracks": [{"id": "v1", "kind": "video", "name": "Видео", "clips": clips},
                       {"id": f"clip_audio_{cid}", "kind": "audio", "name": "Музыка клипа", "clips": [
                           {"id": f"clip_music_{cid}", "assetId": doc.audio_asset_id, "start": 0,
                            "in": doc.audio_start + start, "out": doc.audio_start + end}]}]}
