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


# ---------------------------------------------------------------- reference edits (crop / fragment)
def crop_image(src: Path, dest: Path, crop: dict) -> Path:
    """Normalized {x, y, w, h} region of an image, saved as lossless PNG."""
    import cv2
    import numpy as np

    img = cv2.imdecode(np.fromfile(str(src), dtype=np.uint8), cv2.IMREAD_UNCHANGED)  # imread fails on non-ASCII paths
    if img is None:
        raise RuntimeError("не удалось прочитать картинку")
    x0, y0, x1, y1 = _crop_px(crop, img.shape[1], img.shape[0])
    ok, buf = cv2.imencode(".png", img[y0:y1, x0:x1])
    if not ok:
        raise RuntimeError("не удалось сохранить картинку")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(buf.tobytes())
    return dest


def _crop_px(crop: dict, w: int, h: int, even: bool = False) -> tuple[int, int, int, int]:
    x0 = max(0, min(w - 1, round(crop["x"] * w)))
    y0 = max(0, min(h - 1, round(crop["y"] * h)))
    x1 = max(x0 + 1, min(w, round((crop["x"] + crop["w"]) * w)))
    y1 = max(y0 + 1, min(h, round((crop["y"] + crop["h"]) * h)))
    if even:  # yuv420p needs even sides and offsets
        x0, y0 = x0 // 2 * 2, y0 // 2 * 2
        x1, y1 = x0 + max(2, (x1 - x0) // 2 * 2), y0 + max(2, (y1 - y0) // 2 * 2)
    return x0, y0, x1, y1


async def edit_media(src: Path, dest: Path, kind: str, *, crop: dict | None = None, start: float | None = None,
                     end: float | None = None, width: int | None = None, height: int | None = None) -> Path:
    """Fragment (and, for video, region) of an audio/video file. Audio -> WAV PCM, video -> H.264 + AAC."""
    exe = ffmpeg_bin("ffmpeg")
    if not exe:
        raise RuntimeError("ffmpeg не найден в PATH")
    dest.parent.mkdir(parents=True, exist_ok=True)
    args = [exe, "-y", "-v", "error"]
    if start:
        args += ["-ss", f"{start:.3f}"]  # input seeking + re-encode = frame accurate
    args += ["-i", str(src)]
    if end is not None:
        args += ["-t", f"{end - (start or 0):.3f}"]
    if kind == "audio":
        args += ["-vn", "-c:a", "pcm_s16le"]
    else:
        if crop and width and height:
            x0, y0, x1, y1 = _crop_px(crop, width, height, even=True)
            args += ["-vf", f"crop={x1 - x0}:{y1 - y0}:{x0}:{y0}"]
        args += ["-c:v", "libx264", "-crf", "16", "-preset", "medium", "-pix_fmt", "yuv420p",
                 "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]
    args.append(str(dest))
    code, _, err = await _run(*args)
    if code != 0 or not dest.exists():
        raise RuntimeError(f"ffmpeg: {err.decode(errors='replace')[-300:]}")
    return dest


async def peaks(src: Path, n: int = 600) -> list[float]:
    """Waveform: max |amplitude| (0..1) per window over the whole file, mono 8 kHz."""
    import numpy as np

    exe = ffmpeg_bin("ffmpeg")
    if not exe:
        return []
    code, out, _ = await _run(exe, "-v", "error", "-i", str(src), "-vn", "-ac", "1", "-ar", "8000",
                              "-f", "s16le", "-")
    if code != 0 or not out:
        return []
    pcm = np.abs(np.frombuffer(out, dtype=np.int16).astype(np.float32)) / 32768.0
    if pcm.size < n:
        n = max(1, pcm.size)
    usable = pcm[: pcm.size // n * n].reshape(n, -1)
    return [round(float(v), 3) for v in usable.max(axis=1)]
