"""Full ShellMax restart must actually stop and relaunch (not just return ok)."""

import asyncio
import os
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, Request
from sqlmodel import SQLModel, Session, create_engine, select
from sqlalchemy.pool import StaticPool

from app import engine_api
from app.db import models
from app.db.models import Generation, Project
from app.engine_api import meta, system_restart, system_shutdown


@pytest.fixture
def db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)
    factory = lambda: Session(engine, expire_on_commit=False)
    monkeypatch.setattr(models, "session", factory)
    monkeypatch.setattr(engine_api, "session", factory)
    with factory() as s:
        s.add(Project(id=1, name="Test"))
        s.add(Generation(project_id=1, status="running", seed=1, ui_params={}))
        s.add(Generation(project_id=1, status="queued", seed=2, ui_params={}))
        s.add(Generation(project_id=1, status="done", seed=3, ui_params={}))
        s.commit()
    yield factory
    engine.dispose()


def test_meta_exposes_backend_pid():
    assert meta()["pid"] == os.getpid()


@pytest.mark.asyncio
async def test_system_restart_marks_jobs_stops_all_and_relaunches(db, monkeypatch):
    """Regression: missing Generation import crashed the shutdown task before relaunch."""
    stops: list[str] = []
    st = SimpleNamespace(
        clips=SimpleNamespace(stop=AsyncMock(side_effect=lambda: stops.append("clips"))),
        assistant=SimpleNamespace(runner=SimpleNamespace(stop=AsyncMock(side_effect=lambda: stops.append("assistant")))),
        jobs=SimpleNamespace(stop=AsyncMock(side_effect=lambda: stops.append("jobs"))),
        engine=SimpleNamespace(stop=AsyncMock(side_effect=lambda: stops.append("engine"))),
    )
    relaunched: list[bool] = []
    exited: list[int] = []
    monkeypatch.setattr("app.relaunch.spawn_relaunch", lambda: relaunched.append(True))
    monkeypatch.setattr(engine_api.os, "_exit", lambda code: exited.append(code))

    real_sleep = asyncio.sleep

    async def fast_sleep(delay, *args, **kwargs):
        if delay and delay > 0.05:
            return None
        return await real_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", fast_sleep)

    app = FastAPI()
    app.state.clips = st.clips
    app.state.assistant = st.assistant
    app.state.jobs = st.jobs
    app.state.engine = st.engine

    scope = {"type": "http", "app": app, "headers": [], "method": "POST", "path": "/api/system/restart", "query_string": b""}
    request = Request(scope)
    result = await system_restart(request)
    assert result == {"ok": True}

    for _ in range(50):
        if exited:
            break
        await real_sleep(0.02)
    assert relaunched == [True]
    assert exited == [0]
    assert stops == ["clips", "assistant", "jobs", "engine"]

    with db() as s:
        rows = {g.seed: g for g in s.exec(select(Generation)).all()}
    assert rows[1].status == "error" and "перезапуском" in (rows[1].error or "")
    assert rows[2].status == "error"
    assert rows[3].status == "done"


@pytest.mark.asyncio
async def test_system_shutdown_marks_jobs_stops_all_without_relaunch(db, monkeypatch):
    stops: list[str] = []
    st = SimpleNamespace(
        clips=SimpleNamespace(stop=AsyncMock(side_effect=lambda: stops.append("clips"))),
        assistant=SimpleNamespace(runner=SimpleNamespace(stop=AsyncMock(side_effect=lambda: stops.append("assistant")))),
        jobs=SimpleNamespace(stop=AsyncMock(side_effect=lambda: stops.append("jobs"))),
        engine=SimpleNamespace(stop=AsyncMock(side_effect=lambda: stops.append("engine"))),
    )
    relaunched: list[bool] = []
    exited: list[int] = []
    monkeypatch.setattr("app.relaunch.spawn_relaunch", lambda: relaunched.append(True))
    monkeypatch.setattr(engine_api.os, "_exit", lambda code: exited.append(code))

    real_sleep = asyncio.sleep

    async def fast_sleep(delay, *args, **kwargs):
        if delay and delay > 0.05:
            return None
        return await real_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", fast_sleep)

    app = FastAPI()
    app.state.clips = st.clips
    app.state.assistant = st.assistant
    app.state.jobs = st.jobs
    app.state.engine = st.engine

    scope = {"type": "http", "app": app, "headers": [], "method": "POST", "path": "/api/system/shutdown", "query_string": b""}
    request = Request(scope)
    result = await system_shutdown(request)
    assert result == {"ok": True}

    for _ in range(50):
        if exited:
            break
        await real_sleep(0.02)
    assert relaunched == []
    assert exited == [0]
    assert stops == ["clips", "assistant", "jobs", "engine"]

    with db() as s:
        rows = {g.seed: g for g in s.exec(select(Generation)).all()}
    assert rows[1].status == "error" and "выключением" in (rows[1].error or "")
    assert rows[2].status == "error"
    assert rows[3].status == "done"
