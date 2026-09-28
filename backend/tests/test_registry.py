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
