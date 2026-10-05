"""Generation queue: one job at a time through the engine, live progress to the UI."""

import asyncio
import base64
import hashlib
import logging
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path

from .. import settings
from ..comfy.client import ComfyClient, PromptRejected
from ..comfy.health import WORKER_FAILED
from ..comfy.supervisor import EngineSupervisor
from ..db.models import Generation, MediaAsset, Upload, select, session, utcnow
from ..hub import hub
from ..workflow.params import FaceFullParams, FullParams
from .errors import describe_rejection, humanize_error
from .persist import push_generation, register_asset
from .pipelines import PIPELINES, Pipeline
from .registry import HANDLERS, asset_title_for, get_handler, pipeline_for

log = logging.getLogger("shellmax.jobs")

READY_STATES = ("ready", "external")

# Re-export for callers/tests that historically imported from queue.
__all__ = [
    "JobManager", "Running", "READY_STATES",
    "apply_history_status", "humanize_error", "describe_rejection",
    "push_generation", "register_asset",
]


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
    started_at: float = field(default_factory=time.time)  # job start: exact wall time is measured from here
    stage_marks: list = field(default_factory=list)  # [(stage, t)] when each stage began
    cold: bool = False  # models had to be loaded (first job after engine start or after they were freed)
    artifact_done: bool = False

    def stage_seconds(self, until: float) -> dict[str, float]:
        out: dict[str, float] = {}
        marks = self.stage_marks + [("", until)]
        for (stage, t0), (_, t1) in zip(marks, marks[1:]):
            out[stage] = round(out.get(stage, 0.0) + (t1 - t0), 2)
        return out


def apply_history_status(r: Running, hist: dict) -> bool:
    """If ComfyUI history says the prompt finished, update `r` and return True.

    Used when the websocket missed execution_error / executing(null) — e.g. after a long
    OOM or an engine restart mid-job — so the UI does not stay on «running» forever.
    """
    if not hist:
        return False
    status = hist.get("status") or {}
    messages = status.get("messages") or []
    for kind, data in messages:
        if not isinstance(data, dict):
            data = {}
        if kind == "execution_error":
            r.error = humanize_error(data.get("exception_type", ""), data.get("exception_message", ""),
                                     data.get("node_type", ""))
            r.done.set()
            return True
        if kind == "execution_interrupted":
            r.cancelled = True
            r.done.set()
            return True
    # completed flag / status_str without a typed message (older Comfy builds)
    if status.get("completed") or status.get("status_str") in ("success", "error"):
        if status.get("status_str") == "error" and not r.error:
            r.error = ("generic", "Движок завершил задачу с ошибкой")
        r.done.set()
        return True
    return False


class JobManager:
    def __init__(self, client: ComfyClient, engine: EngineSupervisor):
        self.client = client
        self.engine = engine
        self.queue: asyncio.Queue[int] = asyncio.Queue()
        self.running: Running | None = None
        self._stop = asyncio.Event()
        # awaited right before a job goes to ComfyUI (the assistant finishes and leaves the GPU)
        self.before_submit = None
        self.cold_next = True  # next job loads models from disk (engine start / models freed)
        self._warm_pid: int | None = None

    # ------------------------------------------------------------------ lifecycle
    async def start(self) -> None:
        recovering = []
        with session() as s:
            for g in s.exec(select(Generation).where(Generation.status == "running")).all():
                if (g.info or {}).get("clip_job_id") and g.comfy_prompt_id:
                    recovering.append(g.id)
                    continue
                g.status, g.error, g.error_kind = "error", "Прервано перезапуском ShellMax", "generic"
                s.add(g)
            s.commit()
            queued = s.exec(select(Generation.id).where(Generation.status == "queued").order_by(Generation.id)).all()
        for gid in [*recovering, *queued]:
            self.queue.put_nowait(gid)
        asyncio.create_task(self.client.listen(self._on_ws, self._on_preview, self._stop))
        asyncio.create_task(self._worker())

    async def stop(self) -> None:
        self._stop.set()

    def mark_cold(self) -> None:
        """Models were unloaded (e.g. for the assistant): the next job is a cold sample."""
        self.cold_next = True

    async def _free_for_enhance(self) -> None:
        """Unload lingering ComfyUI models so SeedVR2 gets free VRAM (same idea as assistant._free_comfy)."""
        try:
            await self.client.free_models()
        except Exception:  # noqa: BLE001 - engine hiccup: still try to run
            log.warning("could not free ComfyUI models before enhance", exc_info=True)
            return
        self.mark_cold()
        last: float | None = None
        for _ in range(30):
            try:
                free_mb = (await self.client.system_stats())["devices"][0]["vram_free"] / 2**20
            except Exception:  # noqa: BLE001
                return
            if last is not None and abs(free_mb - last) < 64:
                log.info("VRAM after free for enhance: %.0f MB", free_mb)
                return
            last = free_mb
            await asyncio.sleep(1)

    def busy(self) -> bool:
        """A video job is running or waiting."""
        return self.running is not None or not self.queue.empty()

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
                return
            # orphan "running" row (worker lost / backend restarted mid-poll): free the UI
            if g and g.status == "running":
                g.status, g.finished = "cancelled", utcnow()
                g.error_kind, g.error = "generic", "Остановлено"
                s.add(g)
                s.commit()
                await push_generation(g)

    async def cancel_all(self) -> list[int]:
        """Cancel every queued job, then interrupt the one currently running."""
        cancelled: list[int] = []
        with session() as s:
            rows = list(s.exec(select(Generation).where(Generation.status == "queued")).all())
            for g in rows:
                g.status, g.finished = "cancelled", utcnow()
                s.add(g)
                cancelled.append(g.id)
            s.commit()
            for g in rows:
                s.refresh(g)
                await push_generation(g)
        running_id = self.running.gen_id if self.running else None
        if running_id is not None:
            await self.cancel(running_id)
            if running_id not in cancelled:
                cancelled.append(running_id)
        return cancelled

    # ------------------------------------------------------------------ worker
    async def _worker(self) -> None:
        while not self._stop.is_set():
            gen_id = await self.queue.get()
            with session() as s:
                g = s.get(Generation, gen_id)
            recovering = g and g.status == "running" and (g.info or {}).get("clip_job_id") and g.comfy_prompt_id
            if not g or (g.status != "queued" and not recovering):
                continue
            try:
                if recovering:
                    await self._resume(g)
                else:
                    await self._run(g)
            except Exception as e:  # noqa: BLE001 - a job must never kill the worker
                log.exception("generation %s failed", gen_id)
                await self._finish(gen_id, "error", error=("generic", f"Внутренняя ошибка: {e}"))
            finally:
                self.running = None

    async def _ensure_engine(self) -> str | None:
        await self.engine.check_health()
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
        if g.kind not in HANDLERS:
            await self._finish(g.id, "error", error=("generic", "Этот тип обработки больше не поддерживается. Готовые клипы сохранены; выберите другой способ обработки."))
            return
        r = self.running = Running(gen_id=g.id, pipe=pipeline_for(g.kind), kind=g.kind)
        r.stage_marks.append(("prepare", r.started_at))
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

        handler = get_handler(g.kind)
        if handler.upload == "face":
            full = await self._upload_face_refs(FaceFullParams(**g.full_params))
        elif handler.upload == "refs":
            full = await self._upload_refs(handler.params_cls(**g.full_params), g.ui_params)
        elif handler.upload == "media":
            full = await self._upload_media(handler.params_cls(**g.full_params))
        else:
            full = handler.params_cls(**g.full_params)
        prompt = handler.build(full)
        with session() as s:
            row = s.get(Generation, g.id)
            row.full_params = full.model_dump()
            s.add(row)
            s.commit()

        if self.before_submit:
            await self.before_submit()
        # SeedVR2 needs a clean slate: MiniMax weights left from the previous job
        # otherwise trigger OOM / cryptic cuDNN MHA failures in KSampler.
        if handler.free_before:
            await self._free_for_enhance()
        r.cold = self.cold_next or self.engine.pid != self._warm_pid
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

        await self._await_prompt(r)
        await self._collect_missing_outputs(r)
        await self._finish_result(r)

    async def _resume(self, g: Generation) -> None:
        # Reattach by persisted prompt id; never rebuild or resubmit a graph after a restart.
        r = self.running = Running(gen_id=g.id, pipe=pipeline_for(g.kind),
                                   kind=g.kind, prompt_id=g.comfy_prompt_id, stage=g.stage,
                                   progress=g.progress, draft_asset_id=g.draft_asset_id,
                                   final_asset_id=g.output_asset_id, cold=True)
        problem = await self._ensure_engine()
        if problem:
            await self._finish(g.id, "error", error=("engine_down", problem))
            return
        if not await self._reconcile_prompt(r):
            await self._await_prompt(r)
        await self._collect_missing_outputs(r)
        await self._finish_result(r)

    async def _finish_result(self, r: Running) -> None:
        if r.error:
            await self._finish(r.gen_id, "error", error=r.error)
        elif r.final_asset_id or r.artifact_done:
            await self._finish(r.gen_id, "done", elapsed=time.time() - r.started_at)
            self.cold_next, self._warm_pid = False, self.engine.pid
        elif r.draft_asset_id and (r.stop_after_draft or r.cancelled):
            # User cancelled after draft appeared («Остановить, оставить черновик»)
            await self._finish(r.gen_id, "draft_only")
        elif r.cancelled:
            await self._finish(r.gen_id, "cancelled")
        else:
            await self._finish(r.gen_id, "error", error=("generic", "Движок завершил работу без результата"))

    async def _await_prompt(self, r: Running) -> None:
        """Block until Comfy finishes this prompt; poll history so a missed WS event cannot hang forever."""
        absent = 0  # consecutive polls: not in queue and not yet in history
        while not r.done.is_set():
            try:
                await asyncio.wait_for(r.done.wait(), timeout=5.0)
                return
            except asyncio.TimeoutError:
                pass
            if await self._reconcile_prompt(r):
                return
            # A dead worker can leave its prompt in the HTTP queue forever.
            # Only the fatal worker diagnosis overrides queue presence, not a stats timeout.
            if self.engine.state == "error" and self.engine.detail == WORKER_FAILED:
                r.error = ("engine_down", WORKER_FAILED)
                r.done.set()
                return
            alive = False
            try:
                # The engine status can lag a transient HTTP/GPU-stat failure;
                # only the actual queue can tell us whether this prompt disappeared.
                q = await self.client.queue_state()
                alive = self.client.prompt_in_queue(q, r.prompt_id or "")
            except Exception:  # noqa: BLE001
                alive = False
            if alive:
                absent = 0
            else:
                absent += 1
            # ~30 s outside the queue without history → treat as lost (covers engine crash)
            if absent >= 6 and not r.done.is_set():
                if await self._reconcile_prompt(r):
                    return
                r.error = ("engine_down",
                           "Связь с движком потеряна во время генерации — задача прервалась. Запустите снова.")
                r.done.set()
                return

    async def _reconcile_prompt(self, r: Running) -> bool:
        """Pull Comfy history for the running prompt; True if the job is finished."""
        if not r.prompt_id:
            return False
        try:
            hist = await self.client.history(r.prompt_id)
        except Exception:  # noqa: BLE001
            return False
        return apply_history_status(r, hist)

    async def _upload_refs(self, full: FullParams, ui_params: dict) -> FullParams:
        """Images/audio go into ComfyUI's input dir (LoadImage/LoadAudio); videos load by path."""
        upload_ids = [ref["upload_id"] for ref in ui_params.get("refs", [])]
        refs = []
        with session() as s:
            for ref, uid in zip(full.refs, upload_ids):
                if ref.kind in ("image", "audio") and not ref.comfy_name and not ref.refmod_file:
                    up = s.get(Upload, uid)
                    if not up.comfy_name:
                        up.comfy_name = await self.client.upload_input(Path(up.path), Path(up.path).name)
                        s.add(up)
                        s.commit()
                    ref = ref.model_copy(update={"comfy_name": up.comfy_name})
                refs.append(ref)
        return full.model_copy(update={"refs": refs})

    async def _upload_media(self, full):
        sources = []
        for source in full.sources:
            path = Path(source.path)
            # A content-stamped name prevents a repeat from overwriting an older job's source.
            stamp = hashlib.sha256(f"{path}:{path.stat().st_size}:{path.stat().st_mtime_ns}".encode()).hexdigest()[:20]
            name = await self.client.upload_input(path, f"shellmax_{stamp}{path.suffix}")
            sources.append(source.model_copy(update={"file": name}))
        updated = full.model_copy(update={"sources": sources})
        if hasattr(updated, "base"):
            names = {source.path: source.file for source in sources}
            refs = [ref.model_copy(update={"comfy_name": names.get(ref.path, ref.comfy_name)})
                    if not ref.refmod_file else ref for ref in updated.base.refs]
            updated = updated.model_copy(update={"base": updated.base.model_copy(update={"refs": refs})})
        return updated

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
                g.elapsed_s = round(elapsed, 2)
            if r and r.gen_id == gen_id:
                stages = r.stage_seconds(time.time())
                # a job that had to load the models from disk is a "cold" sample for time estimates
                g.info = {**(g.info or {}), "stage_seconds": stages, "cold": r.cold}
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
                if changed or not r.stage_marks:
                    r.stage_marks.append((stage, time.time()))
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
        collect = get_handler(r.kind).collect_artifact
        if collect:
            with session() as s:
                g = s.get(Generation, r.gen_id)
                info = collect(g, output)
                if info:
                    g.info = {**(g.info or {}), **info}
                    s.add(g)
                    s.commit()
                    r.artifact_done = True
                    await push_generation(g, r.step)
            return
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
            src_asset = s.get(MediaAsset, g.source_asset_id) if g.source_asset_id else None
            source_name = src_asset.name if src_asset else None
            title = asset_title_for(g, is_draft, source_name)
        asset_id = await register_asset(dest, generation_id=r.gen_id, source="draft" if is_draft else "generated",
                                        name=title)
        if is_draft:
            r.draft_asset_id = asset_id
            if r.stop_after_draft and r.prompt_id:
                try:
                    await self.client.interrupt(r.prompt_id)
                except Exception:  # noqa: BLE001
                    log.exception("interrupt after draft failed for gen %s", r.gen_id)
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
        if not r.error:
            apply_history_status(r, hist)
            # Comfy marks interrupted prompts as status_str=error. That is normal for
            # stop-after-draft / user cancel — do not invent a failure on top.
            if (
                not r.error
                and not r.cancelled
                and status.get("status_str") == "error"
            ):
                r.error = ("generic", "Движок завершил задачу с ошибкой")
