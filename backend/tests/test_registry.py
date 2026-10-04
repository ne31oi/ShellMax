"""Every PIPELINES kind must be registered with build + params."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from app import services
from app.jobs.pipelines import PIPELINES
from app.jobs.queue import JobManager
from app.jobs.registry import HANDLERS, get_handler


def test_handlers_cover_pipelines():
    assert set(HANDLERS) == set(PIPELINES)


def test_each_handler_builds():
    for kind, h in HANDLERS.items():
        assert h.params_cls is not None, kind
        assert callable(h.build), kind
        assert get_handler(kind) is h


def test_pipelines_cover_initial_queue_stage_and_all_node_stages():
    # The queue starts every kind in load before the first executing event.
    for kind, pipeline in PIPELINES.items():
        assert "load" in pipeline.stage_start, kind
        assert set(pipeline.stage_by_node.values()) <= set(pipeline.stage_start), kind


def test_retired_kind_cannot_fall_back_to_generation():
    with pytest.raises(ValueError, match="больше не поддерживается"):
        get_handler("retired_workflow")


def test_retired_job_cannot_be_retried(monkeypatch):
    def unexpected_generation(*args, **kwargs):
        pytest.fail("A retired job must never create an H3 generation")

    monkeypatch.setattr(services, "create_generations", unexpected_generation)
    with pytest.raises(HTTPException) as error:
        services.recreate_generations(SimpleNamespace(kind="retired_workflow"))
    assert error.value.status_code == 422


@pytest.mark.asyncio
async def test_retired_queued_job_does_not_start_engine():
    manager = JobManager(AsyncMock(), AsyncMock())
    manager._ensure_engine = AsyncMock()
    manager._finish = AsyncMock()
    await manager._run(SimpleNamespace(id=1, kind="retired_workflow"))
    manager._ensure_engine.assert_not_awaited()
    manager.client.queue_prompt.assert_not_awaited()
    manager._finish.assert_awaited_once()
    assert manager._finish.call_args.args == (1, "error")
    assert manager.running is None
