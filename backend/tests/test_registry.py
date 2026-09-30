"""Every PIPELINES kind must be registered with build + params."""

from app.jobs.pipelines import PIPELINES
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
