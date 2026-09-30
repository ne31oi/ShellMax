"""RefMod selection must work without a backend tensor/image runtime."""

import asyncio
from contextlib import contextmanager

import pytest
from fastapi import HTTPException

from app import refmods


def test_use_visual_only_refmod_builds_preview_with_media_service(monkeypatch, tmp_path):
    items = [
        {"visual": None, "audio": None},
        {"label": "Square", "preview": "square", "visual": {
            "file": "square", "kind": "video", "tokens": 12, "w": 12, "h": 8}, "audio": None},
    ]
    async def catalogue():
        return {"items": items}

    async def preview(name):
        assert name == "square"
        return b"preview-image"

    async def thumbnail(src, dest, kind):
        assert src.read_bytes() == b"preview-image" and kind == "image"
        dest.write_bytes(b"jpeg")

    class Store:
        saved = None

        def get(self, cls, uid):
            return None

        def merge(self, up):
            self.saved = up

        def commit(self):
            pass

    store = Store()
    @contextmanager
    def session():
        yield store

    monkeypatch.setattr(refmods, "catalogue", catalogue)
    monkeypatch.setattr(refmods, "preview", preview)
    monkeypatch.setattr(refmods, "resolve_member", lambda name: tmp_path / "square.safetensors")
    monkeypatch.setattr(refmods, "session", session)
    monkeypatch.setattr(refmods.settings, "THUMBS_DIR", tmp_path)
    monkeypatch.setattr("app.media.library.thumbnail", thumbnail)
    up = asyncio.run(refmods.use_member("square"))
    assert up is store.saved
    assert up.refmod_file == "square" and up.width == 192 and up.height == 128
    assert (tmp_path / f"up_{up.id}.jpg").read_bytes() == b"jpeg"
    assert not list(tmp_path.glob("*.preview.png"))
    with pytest.raises(HTTPException) as error:
        asyncio.run(refmods.use_member("missing"))
    assert error.value.status_code == 404
