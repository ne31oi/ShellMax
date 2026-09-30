"""REST + websocket API consumed by the frontend."""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from . import services  # noqa: F401 — re-export for tests that patch app.api.services
from .engine_api import estimate, router as engine_router  # noqa: F401
from .generations_api import router as generations_router
from .hub import hub
from .jobs.estimator import estimate as estimate_time  # noqa: F401 — re-export for tests
from .library_api import router as library_router
from .projects_api import router as projects_router
from .fantastic_api import router as fantastic_router

router = APIRouter(prefix="/api")
router.include_router(engine_router)
router.include_router(library_router)
router.include_router(generations_router)
router.include_router(projects_router)
router.include_router(fantastic_router)

# ---------------------------------------------------------------- live events
@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await hub.connect(ws)
    try:
        await ws.send_json({"type": "engine", "engine": ws.app.state.engine.snapshot()})
        while True:
            await ws.receive_text()  # keepalive; the UI doesn't send commands here
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(ws)

