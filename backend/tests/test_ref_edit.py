"""Reference edits: a derived file cut from the original, deterministic ids, edits always from the original."""

import asyncio
import subprocess

import numpy as np
import pytest
from fastapi import HTTPException
from sqlmodel import Session, SQLModel, create_engine

from app import services, settings
from app.db.models import Upload
from app.media import library

needs_ffmpeg = pytest.mark.skipif(library.ffmpeg_bin("ffmpeg") is None, reason="ffmpeg not in PATH")


@pytest.fixture
def env(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'db.sqlite'}")
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(services, "session", lambda: Session(engine, expire_on_commit=False))
    monkeypatch.setattr(settings, "UPLOADS_DIR", tmp_path / "uploads")
    monkeypatch.setattr(settings, "THUMBS_DIR", tmp_path / "thumbs")
    (tmp_path / "uploads").mkdir()

    def add(kind: str, path, **meta) -> Upload:
        up = Upload(id=f"src_{kind}", kind=kind, orig_name=f"ориг.{str(path).rsplit('.', 1)[1]}", path=str(path), **meta)
        with Session(engine) as s:
            s.add(up)
            s.commit()
        return up
    return tmp_path, add


def run(coro):
    return asyncio.run(coro)


def _image(tmp_path):
    import cv2

    img = np.zeros((400, 600, 3), np.uint8)
    img[100:300, 200:400] = (0, 0, 255)
    path = tmp_path / "кадр.png"  # non-ASCII on purpose: cv2.imwrite/imread fail on such paths
    path.write_bytes(cv2.imencode(".png", img)[1].tobytes())
    return path


def test_image_crop_and_ids(env):
    tmp, add = env
    add("image", _image(tmp), width=600, height=400)
    crop = {"x": 1 / 3, "y": 0.25, "w": 1 / 3, "h": 0.5}
    d = run(services.edit_upload("src_image", services.RefEdit(crop=crop)))
    assert d.source_id == "src_image" and d.id.startswith("e_") and d.edit["crop"]
    assert (d.width, d.height) == (200, 200) and "(обрезано)" in d.orig_name
    import cv2
    out = cv2.imdecode(np.fromfile(d.path, np.uint8), cv2.IMREAD_COLOR)
    assert out[100, 100].tolist() == [0, 0, 255]  # the red square is all that is left
    # same edit -> same file; editing the edit starts from the original
    assert run(services.edit_upload("src_image", services.RefEdit(crop=crop))).id == d.id
    again = run(services.edit_upload(d.id, services.RefEdit(crop=crop)))
    assert again.id == d.id and again.source_id == "src_image"
    # whole frame = reset to the original
    assert run(services.edit_upload(d.id, services.RefEdit(crop={"x": 0, "y": 0, "w": 1, "h": 1}))).id == "src_image"


def test_too_small_region_rejected(env):
    tmp, add = env
    add("image", _image(tmp), width=600, height=400)
    with pytest.raises(HTTPException) as e:
        run(services.edit_upload("src_image", services.RefEdit(crop={"x": 0, "y": 0, "w": 0.05, "h": 0.05})))
    assert e.value.status_code == 422


@needs_ffmpeg
def test_audio_fragment(env):
    tmp, add = env
    src = tmp / "tone.wav"
    subprocess.run([library.ffmpeg_bin("ffmpeg"), "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
                    str(src)], check=True)
    add("audio", src, duration=6.0)
    d = run(services.edit_upload("src_audio", services.RefEdit(start=1.5, end=4.5)))
    assert d.path.endswith(".wav") and d.duration == pytest.approx(3.0, abs=0.05)
    assert d.edit == {"start": 1.5, "end": 4.5}
    peaks = run(library.peaks(__import__("pathlib").Path(d.path), n=50))
    assert len(peaks) == 50 and min(peaks) > 0.1  # a steady tone (lavfi sine is 1/8 of full scale)
    with pytest.raises(HTTPException):
        run(services.edit_upload("src_audio", services.RefEdit(start=2.0, end=2.2)))


@needs_ffmpeg
def test_video_region_and_fragment(env):
    tmp, add = env
    src = tmp / "clip.mp4"
    subprocess.run([library.ffmpeg_bin("ffmpeg"), "-v", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=24:duration=5",
                    "-f", "lavfi", "-i", "sine=duration=5", "-shortest", "-pix_fmt", "yuv420p", str(src)], check=True)
    add("video", src, duration=5.0, width=640, height=360, has_audio=True)
    d = run(services.edit_upload("src_video", services.RefEdit(crop={"x": 0.1, "y": 0.1, "w": 0.5, "h": 0.5},
                                                                start=1.0, end=3.5)))
    assert (d.width, d.height) == (320, 180) and d.has_audio
    assert d.duration == pytest.approx(2.5, abs=0.1)
