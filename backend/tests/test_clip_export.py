"""Exercise actual ffmpeg output, including continuous music across dissimilar video sources."""

import json
import shutil
import subprocess

import numpy as np
import pytest

from app import settings
from app.db.models import MediaAsset
from app.media.timeline_render import export_timeline
from app.timeline_schema import parse_timeline


@pytest.mark.asyncio
@pytest.mark.parametrize("repeats", [1, 10])
async def test_export_keeps_music_across_cuts(tmp_path, monkeypatch, repeats):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        pytest.skip("ffmpeg unavailable")
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path)
    paths = [tmp_path / "first.mp4", tmp_path / "second.mp4", tmp_path / "music.wav"]
    for path, size, color, rate in [(paths[0], "160x120", "red", 24), (paths[1], "120x160", "blue", 30)]:
        subprocess.run([ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-i", f"color={color}:s={size}:r={rate}:d=1.5",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)], check=True)
    subprocess.run([ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=14", str(paths[2])], check=True)
    assets = {i + 1: MediaAsset(id=i + 1, project_id=1, kind="video" if i < 2 else "audio", name=str(i),
                               path=str(p), duration=1.5 if i < 2 else 14, has_audio=i == 2) for i, p in enumerate(paths)}
    cut_duration = 13 / 24
    duration = 2 * repeats * cut_duration
    timeline = parse_timeline({"tracks": [
        {"id": "v", "kind": "video", "clips": [{"id": f"v{i}", "assetId": i % 2 + 1, "in": 0.25, "out": 0.25 + cut_duration, "muted": True} for i in range(2 * repeats)]},
        {"id": "a", "kind": "audio", "clips": [{"id": "a1", "assetId": 3, "in": 0.5, "out": 0.5 + duration, "start": 0}]}]})
    dest = tmp_path / "export.mp4"
    await export_timeline(timeline, assets, dest, 160, 120, 24)
    meta = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(dest)]))
    video = next(s for s in meta["streams"] if s["codec_type"] == "video")
    assert video["width"] == 160 and video["height"] == 120
    assert int(video["nb_frames"]) == 26 * repeats
    assert abs(float(video["duration"]) - duration) <= 1 / 24
    pixels = subprocess.check_output([ffmpeg, "-v", "error", "-i", str(dest), "-vf", "crop=2:2", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"])
    colors = np.frombuffer(pixels, dtype=np.uint8).reshape(-1, 4, 3).mean(axis=1)
    for frame, color in enumerate(colors):
        assert (color[0] > color[2]) == (frame // 13 % 2 == 0), f"Wrong cut at frame {frame}"
    raw = subprocess.check_output([ffmpeg, "-v", "error", "-i", str(dest), "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"])
    audio = np.frombuffer(raw, dtype=np.float32)
    # No silence, phase reset or extra soundtrack at the video cut.
    for start in (0.1, cut_duration - 0.04, duration - 0.1):
        chunk = audio[int(start * 48000):int((start + 0.08) * 48000)]
        assert np.sqrt(np.mean(chunk ** 2)) > 0.02
        frequency = np.argmax(np.abs(np.fft.rfft(chunk))) * 48000 / len(chunk)
        assert abs(frequency - 440) < 20
