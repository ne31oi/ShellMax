"""ShellMax backend entry point: `uv run python -m app.main` (from backend/)."""

import asyncio
import logging
import os
import webbrowser
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import services, settings
from .api import router
from .assistant_api import router as assistant_router
from .clip_api import router as clip_router
from .clip_service import ClipManager
from .comfy.client import ComfyClient
from .comfy.supervisor import EngineSupervisor
from .comfy.updates import EngineUpdates
from .db.models import init_db
from .hub import hub
from .jobs.queue import JobManager
from .llm.service import AssistantService

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    services.bootstrap()
    client = ComfyClient()

    async def on_engine_state(snapshot: dict) -> None:
        await hub.broadcast({"type": "engine", "engine": snapshot})

    engine = EngineSupervisor(client, on_engine_state)
    jobs = JobManager(client, engine)
    assistant = AssistantService(client, jobs.busy, jobs.mark_cold)
    jobs.before_submit = assistant.release_for_generation  # the LLM leaves the GPU before MiniMax runs
    app.state.engine, app.state.jobs, app.state.assistant = engine, jobs, assistant
    app.state.clips = ClipManager(assistant, jobs)
    app.state.active_mutations = 0
    updates = EngineUpdates(engine, lambda: jobs.busy() or assistant.busy() or bool(app.state.clips.tasks)
                            or app.state.active_mutations > 0)
    app.state.updates = updates
    asyncio.create_task(assistant.runner.idle_watchdog(assistant.busy))
    await jobs.start()
    await app.state.clips.start()
    if not updates.info["needs_restore"]:
        asyncio.create_task(engine.start())  # warm the engine up right away
    asyncio.create_task(engine.watch())
    if os.environ.get("SHELLMAX_OPEN_BROWSER") and settings.FRONTEND_DIST.exists():
        webbrowser.open(f"http://{settings.API_HOST}:{settings.API_PORT}")
    yield
    if updates.installing:
        await asyncio.shield(updates.task)  # finish the transaction before a graceful API shutdown
    await app.state.clips.stop()
    await jobs.stop()
    await assistant.shutdown()
    await engine.stop()
    await client.close()


app = FastAPI(title="ShellMax", lifespan=lifespan)
app.include_router(router)
app.include_router(assistant_router)
app.include_router(clip_router)


@app.middleware("http")
async def guard_engine_updates(request, call_next):
    st = request.app.state
    updates = getattr(st, "updates", None)
    mutation = request.method not in {"GET", "HEAD", "OPTIONS"} and not request.url.path.startswith("/api/engine-updates")
    if updates and mutation:
        if updates.installing or updates.info["needs_restore"]:
            detail = "Движок обновляется. Дождитесь окончания установки." if updates.installing else "Обновление прервано. Восстановите копию в Настройках → Система."
            return JSONResponse(status_code=409, content={"detail": detail})
        st.active_mutations += 1
        try:
            return await call_next(request)
        finally:
            st.active_mutations -= 1
    return await call_next(request)

if settings.FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=settings.FRONTEND_DIST / "assets"), name="static")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        target = settings.FRONTEND_DIST / path
        if path and target.is_file():
            return FileResponse(target)
        return FileResponse(settings.FRONTEND_DIST / "index.html")


def run() -> None:
    uvicorn.run(app, host=settings.API_HOST, port=settings.API_PORT, log_level="info")


if __name__ == "__main__":
    run()
