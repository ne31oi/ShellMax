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
from .comfy.client import ComfyClient
from .comfy.supervisor import EngineSupervisor
from .db.models import init_db
from .hub import hub
from .jobs.queue import JobManager

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
    app.state.engine, app.state.jobs = engine, jobs
    await jobs.start()
    asyncio.create_task(engine.start())  # warm the engine up right away
    asyncio.create_task(engine.watch())
    if os.environ.get("SHELLMAX_OPEN_BROWSER") and settings.FRONTEND_DIST.exists():
        webbrowser.open(f"http://{settings.API_HOST}:{settings.API_PORT}")
    yield
    await jobs.stop()
    await engine.stop()
    await client.close()


app = FastAPI(title="ShellMax", lifespan=lifespan)
app.include_router(router)

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
