"""Beat / onset analysis for timeline markers (Resolve-style grid)."""

from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path

import numpy as np

from .. import settings

log = logging.getLogger("shellmax.beats")

SAMPLE_RATE = 22050


def _extract_mono_wav(src: Path, dest: Path, start_s: float = 0.0, duration_s: float | None = None) -> None:
    args = ["ffmpeg", "-y"]
    if start_s > 0:
        args += ["-ss", f"{start_s:.4f}"]
    args += ["-i", str(src)]
    if duration_s is not None and duration_s > 0:
        args += ["-t", f"{duration_s:.4f}"]
    args += ["-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "wav", str(dest)]
    subprocess.run(args, check=True, capture_output=True)


def _read_wav_mono(path: Path) -> np.ndarray:
    import wave

    with wave.open(str(path), "rb") as w:
        n = w.getnframes()
        raw = w.readframes(n)
        ch = w.getnchannels()
        sw = w.getsampwidth()
    if sw == 2:
        data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sw == 4:
        data = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        data = np.frombuffer(raw, dtype=np.uint8).astype(np.float32) / 128.0 - 1.0
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1)
    return data


def _onset_envelope(y: np.ndarray, hop: int = 512) -> np.ndarray:
    """Spectral flux onset strength (no librosa dependency)."""
    win = np.hanning(hop * 2)
    n_fft = hop * 2
    frames = max(1, (len(y) - n_fft) // hop + 1)
    prev = np.zeros(n_fft // 2 + 1, dtype=np.float32)
    env = np.zeros(frames, dtype=np.float32)
    for i in range(frames):
        start = i * hop
        chunk = y[start : start + n_fft]
        if len(chunk) < n_fft:
            chunk = np.pad(chunk, (0, n_fft - len(chunk)))
        spec = np.abs(np.fft.rfft(chunk * win))
        diff = np.maximum(0.0, spec - prev)
        env[i] = float(diff.sum())
        prev = spec
    mx = float(env.max()) if env.size else 1.0
    if mx > 1e-8:
        env /= mx
    return env


def _pick_peaks(env: np.ndarray, hop: int, min_gap_s: float = 0.28) -> list[float]:
    if env.size < 3:
        return []
    med = float(np.median(env))
    thr = med + 0.35 * (float(env.max()) - med)
    min_gap = max(1, int(min_gap_s * SAMPLE_RATE / hop))
    peaks: list[int] = []
    last = -min_gap
    for i in range(1, len(env) - 1):
        if env[i] >= thr and env[i] >= env[i - 1] and env[i] >= env[i + 1] and i - last >= min_gap:
            peaks.append(i)
            last = i
    return [i * hop / SAMPLE_RATE for i in peaks]


def _estimate_bpm(beats: list[float]) -> float | None:
    if len(beats) < 4:
        return None
    gaps = np.diff(np.array(beats, dtype=np.float64))
    gaps = gaps[(gaps > 0.25) & (gaps < 2.0)]
    if gaps.size == 0:
        return None
    med = float(np.median(gaps))
    bpm = 60.0 / med
    while bpm < 70:
        bpm *= 2
    while bpm > 180:
        bpm /= 2
    return round(bpm, 2)


def _downbeats(beats: list[float], bpm: float | None) -> list[float]:
    if not beats:
        return []
    if not bpm or bpm < 40:
        return beats[::4]
    bar = 4 * (60.0 / bpm)
    out = [beats[0]]
    for t in beats[1:]:
        if abs((t - out[0]) % bar) < 0.08 or abs((t - out[0]) % bar - bar) < 0.08:
            if t - out[-1] > bar * 0.6:
                out.append(t)
    return out if len(out) > 1 else beats[::4]


def analyze_beats(
    media_path: str | Path,
    start_s: float = 0.0,
    end_s: float | None = None,
) -> dict:
    """Return {beats, downbeats, bpm, offset} for an audio or video file.

    Times are **relative to start_s** (0 = beginning of the analyzed window),
    so the client maps them as `timelineStart + beat`.
    """
    src = Path(media_path)
    if not src.is_file():
        raise FileNotFoundError(str(src))
    start_s = max(0.0, float(start_s))
    duration_s: float | None = None
    if end_s is not None and end_s > start_s:
        duration_s = float(end_s) - start_s
    with tempfile.TemporaryDirectory(dir=settings.DATA_DIR) as tmp:
        wav = Path(tmp) / "mono.wav"
        try:
            _extract_mono_wav(src, wav, start_s=start_s, duration_s=duration_s)
        except subprocess.CalledProcessError as e:
            err = (e.stderr or b"").decode("utf-8", errors="replace")[:400]
            raise RuntimeError(f"Не удалось извлечь аудио: {err}") from e
        y = _read_wav_mono(wav)
    if y.size < SAMPLE_RATE // 2:
        return {"beats": [], "downbeats": [], "bpm": None, "offset": 0.0, "windowStart": start_s}
    hop = 512
    env = _onset_envelope(y, hop=hop)
    beats = _pick_peaks(env, hop=hop)
    bpm = _estimate_bpm(beats)
    if len(beats) < 4 and bpm:
        duration = len(y) / SAMPLE_RATE
        step = 60.0 / bpm
        t0 = beats[0] if beats else 0.0
        beats = []
        t = t0
        while t < duration:
            beats.append(round(t, 4))
            t += step
    downbeats = _downbeats(beats, bpm)
    offset = beats[0] if beats else 0.0
    return {
        "beats": [round(t, 4) for t in beats],
        "downbeats": [round(t, 4) for t in downbeats],
        "bpm": bpm,
        "offset": round(offset, 4),
        "windowStart": round(start_s, 4),
    }


def nearest_beat(t: float, beats: list[float]) -> float:
    if not beats:
        return t
    return min(beats, key=lambda b: abs(b - t))


def snap_range(start: float, duration: float, beats: list[float]) -> tuple[float, float]:
    """Snap start and end to nearest beats; keep duration >= 0.2."""
    if not beats:
        return start, duration
    end = start + duration
    s = nearest_beat(start, beats)
    e = nearest_beat(end, beats)
    if e <= s + 0.2:
        later = [b for b in beats if b >= s + 0.2]
        e = later[0] if later else s + duration
    return s, max(0.2, e - s)
