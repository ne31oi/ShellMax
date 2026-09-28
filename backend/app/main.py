"""ShellMax backend entry point: `uv run python -m app.main` (from backend/)."""

import asyncio
import logging
import os
import webbrowser
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import services, settings
from .api import router
from .assistant_api import router as assistant_router
from .clip_api import router as clip_router
from .clip_service import ClipManager
from .comfy.client import ComfyClient
from .comfy.supervisor import EngineSupervisor
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
    asyncio.create_task(assistant.runner.idle_watchdog(assistant.busy))
    await jobs.start()
    await app.state.clips.start()
    asyncio.create_task(engine.start())  # warm the engine up right away
    asyncio.create_task(engine.watch())
    if os.environ.get("SHELLMAX_OPEN_BROWSER") and settings.FRONTEND_DIST.exists():
        webbrowser.open(f"http://{settings.API_HOST}:{settings.API_PORT}")
    yield
    await app.state.clips.stop()
    await jobs.stop()
    await assistant.runner.stop()
    await engine.stop()
    await client.close()


app = FastAPI(title="ShellMax", lifespan=lifespan)
app.include_router(router)
app.include_router(assistant_router)
app.include_router(clip_router)

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
