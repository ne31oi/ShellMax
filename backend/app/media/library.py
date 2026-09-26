"""Media probing and derived files (thumbnails, frames) via ffmpeg/ffprobe."""

import asyncio
import json
import logging
import shutil
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("shellmax.media")

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}
VIDEO_EXT = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"}
AUDIO_EXT = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".opus"}


def kind_of(name: str) -> str | None:
    ext = Path(name).suffix.lower()
    if ext in IMAGE_EXT:
        return "image"
    if ext in VIDEO_EXT:
        return "video"
    if ext in AUDIO_EXT:
        return "audio"
    return None


def ffmpeg_bin(name: str) -> str | None:
    return shutil.which(name)


@dataclass
class Probe:
    duration: float | None = None
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    has_audio: bool = False


async def _run(*args: str) -> tuple[int, bytes, bytes]:
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await proc.communicate()
    return proc.returncode, out, err


async def probe(path: Path) -> Probe:
    exe = ffmpeg_bin("ffprobe")
    if not exe:
        return Probe()
    code, out, _ = await _run(exe, "-v", "error", "-print_format", "json",
                              "-show_format", "-show_streams", str(path))
    if code != 0:
        return Probe()
    data = json.loads(out or b"{}")
    p = Probe()
    fmt_duration = data.get("format", {}).get("duration")
    p.duration = float(fmt_duration) if fmt_duration else None
    for s in data.get("streams", []):
        if s.get("codec_type") == "video" and p.width is None:
            p.width, p.height = s.get("width"), s.get("height")
            rate = s.get("avg_frame_rate") or s.get("r_frame_rate") or "0/1"
            num, _, den = rate.partition("/")
            try:
                p.fps = float(num) / float(den or 1) if float(den or 1) else None
            except ValueError:
                p.fps = None
        elif s.get("codec_type") == "audio":
            p.has_audio = True
    return p


async def thumbnail(src: Path, dest: Path, kind: str, at: float = 0.5, width: int = 480) -> Path | None:
    """JPEG thumbnail for video/image. Audio gets none (the UI draws a waveform)."""
    exe = ffmpeg_bin("ffmpeg")
    if not exe or kind == "audio":
        return None
    dest.parent.mkdir(parents=True, exist_ok=True)
    args = [exe, "-y", "-v", "error"]
    if kind == "video":
        args += ["-ss", f"{at:.3f}"]
    args += ["-i", str(src), "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", "4", str(dest)]
    code, _, err = await _run(*args)
    if code != 0 or not dest.exists():
        if kind == "video" and at > 0:
            return await thumbnail(src, dest, kind, at=0, width=width)
        log.warning("thumbnail failed for %s: %s", src, err.decode(errors="replace")[-300:])
        return None
    return dest


async def extract_frame(src: Path, dest: Path, at: float) -> Path:
    """Full-resolution PNG of the frame at `at` seconds (used as a new reference image)."""
    exe = ffmpeg_bin("ffmpeg")
    if not exe:
        raise RuntimeError("ffmpeg не найден в PATH")
    dest.parent.mkdir(parents=True, exist_ok=True)
    code, _, err = await _run(exe, "-y", "-v", "error", "-ss", f"{max(0.0, at):.3f}", "-i", str(src),
                              "-frames:v", "1", str(dest))
    if code != 0 or not dest.exists():
        raise RuntimeError(f"не удалось извлечь кадр: {err.decode(errors='replace')[-300:]}")
    return dest
