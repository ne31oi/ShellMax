"""Generation queue: one job at a time through the engine, live progress to the UI."""

import asyncio
import base64
import logging
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path

from .. import settings
from ..comfy.client import ComfyClient, PromptRejected
from ..comfy.supervisor import EngineSupervisor
from ..db.models import Generation, MediaAsset, Upload, select, session, utcnow
from ..hub import hub
from ..media import library
from ..workflow.builder import build_prompt
from ..workflow.builder_face import build_face_prompt
from ..workflow.params import FaceFullParams, FullParams
from .pipelines import PIPELINES, Pipeline

log = logging.getLogger("shellmax.jobs")

READY_STATES = ("ready", "external")


@dataclass
class Running:
    gen_id: int
    pipe: Pipeline = PIPELINES["generate"]
    kind: str = "generate"
    prompt_id: str | None = None
    stage: str = "load"
    progress: float = 0.0
    draft_asset_id: int | None = None
    final_asset_id: int | None = None
    stop_after_draft: bool = False
    cancelled: bool = False
    error: tuple[str, str] | None = None  # (kind, message)
    done: asyncio.Event = field(default_factory=asyncio.Event)
    last_push: float = 0.0
    last_preview: float = 0.0
    step: dict | None = None  # {"value", "max"} of the node currently reporting progress


def humanize_error(exc_type: str, message: str, node_type: str = "") -> tuple[str, str]:
    low = f"{exc_type} {message}".lower()
    if "out of memory" in low or "outofmemory" in low or "allocation on device" in low:
        return "oom", "Не хватило видеопамяти. Снизьте качество или длительность, либо включите «Экономию VRAM»."
    if "filenotfound" in low or "файл не найден" in low or "путь к файлу" in low:
        return "missing_file", message.replace("ShellMax: ", "")
    where = f" ({node_type})" if node_type else ""
    return "generic", f"Ошибка движка{where}: {message.strip() or exc_type}"


class JobManager:
    def __init__(self, client: ComfyClient, engine: EngineSupervisor):
        self.client = client
        self.engine = engine
        self.queue: asyncio.Queue[int] = asyncio.Queue()
        self.running: Running | None = None
        self._stop = asyncio.Event()

    # ------------------------------------------------------------------ lifecycle
    async def start(self) -> None:
        with session() as s:
            for g in s.exec(select(Generation).where(Generation.status == "running")).all():
                g.status, g.error, g.error_kind = "error", "Прервано перезапуском ShellMax", "generic"
                s.add(g)
            s.commit()
            queued = s.exec(select(Generation.id).where(Generation.status == "queued").order_by(Generation.id)).all()
        for gid in queued:
            self.queue.put_nowait(gid)
        asyncio.create_task(self.client.listen(self._on_ws, self._on_preview, self._stop))
        asyncio.create_task(self._worker())

    async def stop(self) -> None:
        self._stop.set()

    def enqueue(self, gen_id: int) -> None:
        self.queue.put_nowait(gen_id)

    # ------------------------------------------------------------------ user actions
    async def cancel(self, gen_id: int) -> None:
        r = self.running
        if r and r.gen_id == gen_id:
            # with a draft in hand, stopping keeps it ("cancel final")
            r.stop_after_draft = r.draft_asset_id is not None
            r.cancelled = True
            if r.prompt_id:
                await self.client.interrupt(r.prompt_id)
            else:
                r.done.set()
            return
        with session() as s:
            g = s.get(Generation, gen_id)
            if g and g.status == "queued":
                g.status, g.finished = "cancelled", utcnow()
                s.add(g)
                s.commit()
                await push_generation(g)

    # ------------------------------------------------------------------ worker
    async def _worker(self) -> None:
        while not self._stop.is_set():
            gen_id = await self.queue.get()
            with session() as s:
                g = s.get(Generation, gen_id)
            if not g or g.status != "queued":
                continue
            try:
                await self._run(g)
            except Exception as e:  # noqa: BLE001 - a job must never kill the worker
                log.exception("generation %s failed", gen_id)
                await self._finish(gen_id, "error", error=("generic", f"Внутренняя ошибка: {e}"))
            finally:
                self.running = None

    async def _ensure_engine(self) -> str | None:
        if self.engine.state not in READY_STATES:
            if self.engine.state == "not_installed":
                return self.engine.detail
            if self.engine.state in ("stopped", "error"):
                await self.engine.start()
            for _ in range(600):
                if self.engine.state in READY_STATES:
                    break
                if self.engine.state in ("error", "not_installed"):
                    return self.engine.detail
                await asyncio.sleep(1)
            else:
                return "Движок не запустился"
        return None

    async def _run(self, g: Generation) -> None:
        r = self.running = Running(gen_id=g.id, pipe=PIPELINES.get(g.kind, PIPELINES["generate"]), kind=g.kind)
        with session() as s:
            row = s.get(Generation, g.id)
            row.status, row.stage, row.started, row.progress = "running", "load", utcnow(), 0.0
            s.add(row)
            s.commit()
            await push_generation(row)

        problem = await self._ensure_engine()
        if problem:
            await self._finish(g.id, "error", error=("engine_down", problem))
            return
        if r.cancelled:
            await self._finish(g.id, "cancelled")
            return

        if g.kind == "face":
            full = await self._upload_face_refs(FaceFullParams(**g.full_params))
            prompt = build_face_prompt(full)
        else:
            full = await self._upload_refs(FullParams(**g.full_params), g.ui_params)
            prompt = build_prompt(full)
        with session() as s:
            row = s.get(Generation, g.id)
            row.full_params = full.model_dump()
            s.add(row)
            s.commit()

        try:
            r.prompt_id = await self.client.queue_prompt(prompt)
        except PromptRejected as e:
            await self._finish(g.id, "error", error=("generic", describe_rejection(e)))
            return
        with session() as s:
            row = s.get(Generation, g.id)
            row.comfy_prompt_id = r.prompt_id
            s.add(row)
            s.commit()

        t0 = time.time()
        await r.done.wait()
        await self._collect_missing_outputs(r)

        if r.error:
            await self._finish(g.id, "error", error=r.error)
        elif r.final_asset_id:
            await self._finish(g.id, "done", elapsed=time.time() - t0)
        elif r.draft_asset_id and (r.stop_after_draft or r.cancelled):
            await self._finish(g.id, "draft_only")
        elif r.cancelled:
            await self._finish(g.id, "cancelled")
        else:
            await self._finish(g.id, "error", error=("generic", "Движок завершил работу без результата"))

    async def _upload_refs(self, full: FullParams, ui_params: dict) -> FullParams:
        """Images/audio go into ComfyUI's input dir (LoadImage/LoadAudio); videos load by path."""
        upload_ids = [ref["upload_id"] for ref in ui_params.get("refs", [])]
        refs = []
        with session() as s:
            for ref, uid in zip(full.refs, upload_ids):
                if ref.kind in ("image", "audio") and not ref.comfy_name:
                    up = s.get(Upload, uid)
                    if not up.comfy_name:
                        up.comfy_name = await self.client.upload_input(Path(up.path), Path(up.path).name)
                        s.add(up)
                        s.commit()
                    ref = ref.model_copy(update={"comfy_name": up.comfy_name})
                refs.append(ref)
        return full.model_copy(update={"refs": refs})

    async def _upload_face_refs(self, full: FaceFullParams) -> FaceFullParams:
        """Identity (<Picture 1>) and close-up (<Picture 2>) images go into ComfyUI's input dir."""
        names = {}
        for path in {full.identity_path, full.closeup_path}:
            names[path] = await self.client.upload_input(Path(path), Path(path).name)
        return full.model_copy(update={"identity_image": names[full.identity_path],
                                       "closeup_image": names[full.closeup_path]})

    async def _finish(self, gen_id: int, status: str, error: tuple[str, str] | None = None,
                      elapsed: float | None = None) -> None:
        r = self.running
        with session() as s:
            g = s.get(Generation, gen_id)
            g.status = status
            g.finished = utcnow()
            if r:
                g.draft_asset_id = r.draft_asset_id or g.draft_asset_id
                g.output_asset_id = r.final_asset_id or g.output_asset_id
            if status == "done":
                g.progress, g.stage = 1.0, "done"
            if elapsed is not None:
                g.elapsed_s = elapsed
            if error:
                g.error_kind, g.error = error
            s.add(g)
            s.commit()
            await push_generation(g)

    # ------------------------------------------------------------------ engine events
    async def _on_ws(self, msg: dict) -> None:
        r = self.running
        data = msg.get("data") or {}
        kind = msg.get("type")
        if kind == "status" or not r or not r.prompt_id or data.get("prompt_id") != r.prompt_id:
            return

        if kind == "executing":
            node = data.get("node")
            if node is None:  # whole prompt finished
                r.done.set()
                return
            stage = r.pipe.stage_by_node.get(str(node))
            if stage and r.pipe.stage_start[stage] >= r.pipe.stage_start[r.stage]:
                changed = stage != r.stage
                r.stage = stage
                if changed:
                    r.step = None  # a new stage starts without step info until its node reports
                await self._progress(r, r.pipe.stage_start[stage], force=changed)
        elif kind == "progress":
            node = str(data.get("node"))
            if node in r.pipe.sampler_nodes or r.pipe.stage_by_node.get(node) == r.stage:
                value, total = data.get("value", 0), max(1, data.get("max", 1))
                first = r.step is None
                r.step = {"value": value, "max": total}
                # always show the first and the last step; throttle the ones in between
                await self._progress(r, r.pipe.stage_start[r.stage] + r.pipe.stage_weight[r.stage] * value / total,
                                     force=first or value >= total)
        elif kind == "executed":
            node = str(data.get("node"))
            if node in (r.pipe.draft_node, r.pipe.final_node):
                await self._save_output(r, node, data.get("output") or {})
            elif node == r.pipe.report_node:
                await self._save_report(r, data.get("output") or {})
        elif kind == "execution_error":
            r.error = humanize_error(data.get("exception_type", ""), data.get("exception_message", ""),
                                     data.get("node_type", ""))
            r.done.set()
        elif kind == "execution_interrupted":
            r.cancelled = True
            r.done.set()
        elif kind == "execution_success":
            r.done.set()

    async def _progress(self, r: Running, value: float, force: bool = False) -> None:
        value = max(r.progress, min(value, 0.99))
        r.progress = value
        now = time.time()
        if not force and now - r.last_push < 0.3:
            return
        r.last_push = now
        with session() as s:
            g = s.get(Generation, r.gen_id)
            g.stage, g.progress = r.stage, value
            s.add(g)
            s.commit()
            await push_generation(g, r.step)

    async def _on_preview(self, image: bytes, mime: str) -> None:
        r = self.running
        if not r:
            return
        now = time.time()
        if now - r.last_preview < 0.2:
            return
        r.last_preview = now
        await hub.broadcast({"type": "preview", "generation_id": r.gen_id,
                             "data": f"data:{mime};base64,{base64.b64encode(image).decode()}"})

    async def _save_output(self, r: Running, node: str, output: dict) -> None:
        files = output.get("gifs") or output.get("videos") or []
        if not files:
            return
        info = files[0]
        is_draft = node == r.pipe.draft_node
        if (is_draft and r.draft_asset_id) or (not is_draft and r.final_asset_id):
            return
        suffix = Path(info["filename"]).suffix or ".mp4"
        dest = settings.MEDIA_DIR / f"gen{r.gen_id}_{'draft' if is_draft else 'final'}{suffix}"
        src = Path(info.get("fullpath", ""))
        if src.is_file():
            await asyncio.to_thread(shutil.copy2, src, dest)
        else:
            await self.client.download_output(info, dest)
        with session() as s:
            g = s.get(Generation, r.gen_id)
            if g.kind == "face":
                src_asset = s.get(MediaAsset, g.source_asset_id) if g.source_asset_id else None
                base = src_asset.name if src_asset else f"Клип {g.source_asset_id}"
                title = f"{base} · {'трекинг' if is_draft else 'лицо'}"
            else:
                title = asset_title((g.ui_params or {}).get("prompt", ""), r.gen_id)
        asset_id = await register_asset(dest, generation_id=r.gen_id, source="draft" if is_draft else "generated",
                                        name=title)
        if is_draft:
            r.draft_asset_id = asset_id
        else:
            r.final_asset_id = asset_id
        with session() as s:
            g = s.get(Generation, r.gen_id)
            if is_draft:
                g.draft_asset_id = asset_id
            else:
                g.output_asset_id = asset_id
            s.add(g)
            s.commit()
            await push_generation(g, r.step)

    async def _save_report(self, r: Running, output: dict) -> None:
        """PreviewAny text (face tracking report) -> Generation.info, shown in the UI."""
        text = output.get("text")
        report = "\n".join(map(str, text)) if isinstance(text, list) else str(text or "")
        if not report:
            return
        with session() as s:
            g = s.get(Generation, r.gen_id)
            g.info = {**(g.info or {}), "track_report": report}
            s.add(g)
            s.commit()
            await push_generation(g, r.step)

    async def _collect_missing_outputs(self, r: Running) -> None:
        """Websocket messages can be missed across reconnects; history is authoritative."""
        if not r.prompt_id or (r.final_asset_id and r.draft_asset_id):
            return
        try:
            hist = await self.client.history(r.prompt_id)
        except Exception:  # noqa: BLE001
            return
        for node, out in (hist.get("outputs") or {}).items():
            if node in (r.pipe.draft_node, r.pipe.final_node):
                await self._save_output(r, node, out)
            elif node == r.pipe.report_node:
                await self._save_report(r, out)
        status = hist.get("status") or {}
        if not r.error and status.get("status_str") == "error":
            for m in status.get("messages", []):
                if m[0] == "execution_error":
                    d = m[1]
                    r.error = humanize_error(d.get("exception_type", ""), d.get("exception_message", ""),
                                             d.get("node_type", ""))


def asset_title(prompt: str, gen_id: int) -> str:
    """Short human name for a clip: the summary of a structured prompt, else its first meaningful line."""
    import re

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


def describe_rejection(e: PromptRejected) -> str:
    parts = [str(e)]
    for node_id, err in (e.details.get("node_errors") or {}).items():
        for item in err.get("errors", []):
            parts.append(f"{err.get('class_type', node_id)}: {item.get('details') or item.get('message')}")
    return "Движок отклонил задачу: " + "; ".join(parts)


async def register_asset(path: Path, generation_id: int | None, source: str, project_id: int | None = None,
                         name: str | None = None) -> int:
    kind = library.kind_of(path.name) or "video"
    meta = await library.probe(path)
    thumb = await library.thumbnail(path, settings.THUMBS_DIR / f"{path.stem}.jpg", kind)
    with session() as s:
        if project_id is None and generation_id is not None:
            project_id = s.get(Generation, generation_id).project_id
        asset = MediaAsset(project_id=project_id or 1, kind=kind, name=name or path.stem, path=str(path),
                           duration=meta.duration, width=meta.width, height=meta.height, fps=meta.fps,
                           has_audio=meta.has_audio, source=source, generation_id=generation_id,
                           thumb=str(thumb) if thumb else None)
        s.add(asset)
        s.commit()
        s.refresh(asset)
        await hub.broadcast({"type": "asset", "asset": asset.model_dump()})
        return asset.id


async def push_generation(g: Generation, step: dict | None = None) -> None:
    """`step` is live-only (not stored): progress of the node running right now."""
    await hub.broadcast({"type": "generation", "generation": {**g.model_dump(), "step": step}})
