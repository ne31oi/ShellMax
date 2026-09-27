"""Beat / onset analysis for timeline markers (Resolve-style grid).

Pipeline (no librosa):
1. Decode mono PCM with sample-accurate ffmpeg seek (-ss after -i).
2. Onset strength via spectral flux.
3. Global tempo via onset autocorrelation (70–180 BPM).
4. Phase alignment + optional local peak refine → regular beat grid.
5. Times are always **file-absolute** (seconds from media start).
"""

from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path

import numpy as np

from .. import settings

log = logging.getLogger("shellmax.beats")

SAMPLE_RATE = 22050
HOP = 512
# Cap decode length so long podcasts don't hang the UI (≈ 8 min).
MAX_ANALYZE_S = 480.0


def _extract_mono_wav(src: Path, dest: Path, start_s: float = 0.0, duration_s: float | None = None) -> None:
    """Accurate decode: -ss AFTER -i (decode then seek), not keyframe-approximate."""
    args = ["ffmpeg", "-y", "-i", str(src)]
    if start_s > 0:
        args += ["-ss", f"{start_s:.6f}"]
    if duration_s is not None and duration_s > 0:
        args += ["-t", f"{duration_s:.6f}"]
    args += [
        "-vn",
        "-ac", "1",
        "-ar", str(SAMPLE_RATE),
        "-f", "wav",
        str(dest),
    ]
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


def _onset_envelope(y: np.ndarray, hop: int = HOP) -> np.ndarray:
    """Spectral flux onset strength, lightly smoothed."""
    win = np.hanning(hop * 2).astype(np.float32)
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
    if env.size >= 3:
        # 3-tap smooth — reduces spurious micro-peaks without killing kicks
        env = np.convolve(env, np.array([0.25, 0.5, 0.25], dtype=np.float32), mode="same")
    mx = float(env.max()) if env.size else 1.0
    if mx > 1e-8:
        env /= mx
    return env


def _bpm_from_onset(env: np.ndarray, hop: int = HOP) -> float | None:
    """Autocorrelate onset envelope; pick best tempo in 70–180 BPM."""
    if env.size < 32:
        return None
    x = env.astype(np.float64) - float(env.mean())
    energy = float(np.dot(x, x)) + 1e-12
    min_lag = max(2, int(round((60.0 / 180.0) * SAMPLE_RATE / hop)))
    max_lag = min(len(x) - 1, int(round((60.0 / 70.0) * SAMPLE_RATE / hop)))
    if max_lag <= min_lag:
        return None

    acf = np.empty(max_lag + 1, dtype=np.float64)
    acf[:min_lag] = 0.0
    for lag in range(min_lag, max_lag + 1):
        acf[lag] = float(np.dot(x[:-lag], x[lag:])) / energy

    peak_lag = int(min_lag + np.argmax(acf[min_lag : max_lag + 1]))
    if acf[peak_lag] < 0.02:
        return None

    # Parabolic interpolation around the peak for sub-lag precision
    if min_lag < peak_lag < max_lag:
        y0, y1, y2 = acf[peak_lag - 1], acf[peak_lag], acf[peak_lag + 1]
        denom = y0 - 2 * y1 + y2
        if abs(denom) > 1e-12:
            peak_lag = peak_lag + 0.5 * (y0 - y2) / denom

    bpm = 60.0 / (peak_lag * hop / SAMPLE_RATE)
    # Fold into 70–180; prefer the octave nearer 100–130 when close
    while bpm < 70:
        bpm *= 2
    while bpm > 180:
        bpm /= 2
    for mul in (2.0, 0.5):
        alt = bpm * mul
        if 70 <= alt <= 180 and abs(alt - 120) + 3 < abs(bpm - 120):
            bpm = alt
    return round(bpm, 2)


def _align_phase(env: np.ndarray, bpm: float, hop: int = HOP) -> float:
    """Return best phase offset in seconds from window start.

    Candidates are prominent onset peaks (not every hop), scored by how well a
    regular grid from that peak lands on the envelope — prefers early peaks
    when scores are close so we lock to the first bar, not a later alias.
    """
    period_s = 60.0 / bpm
    duration_s = len(env) * hop / SAMPLE_RATE
    thr = max(0.35, float(np.percentile(env, 70)))
    peak_idx = [
        i
        for i in range(1, len(env) - 1)
        if env[i] >= thr and env[i] >= env[i - 1] and env[i] >= env[i + 1]
    ]
    if not peak_idx:
        # Fallback: brute phase search
        period_i = max(1, int(round(period_s * SAMPLE_RATE / hop)))
        best_phase = 0
        best_score = -1.0
        step = max(1, period_i // 32)
        for phase in range(0, period_i, step):
            score = float(env[phase::period_i].sum())
            if score > best_score:
                best_score = score
                best_phase = phase
        return best_phase * hop / SAMPLE_RATE

    best_phase = peak_idx[0] * hop / SAMPLE_RATE
    best_score = -1.0
    # Only need unique phases modulo the beat period
    seen: set[int] = set()
    for idx in peak_idx[:40]:
        phase_s = (idx * hop / SAMPLE_RATE) % period_s
        key = int(round(phase_s * 1000))
        if key in seen:
            continue
        seen.add(key)
        score = 0.0
        t = phase_s
        # Walk back so we cover from 0
        while t > 0:
            t -= period_s
        if t < -1e-9:
            t += period_s
        n = 0
        while t < duration_s:
            fi = int(round(t * SAMPLE_RATE / hop))
            if 0 <= fi < len(env):
                score += float(env[fi])
                n += 1
            t += period_s
        if n:
            score /= n
        # Slight preference for earlier phase (first click, not +1 beat)
        score -= phase_s * 0.02
        if score > best_score:
            best_score = score
            best_phase = phase_s
    return best_phase


def _refine_to_peaks(times: list[float], env: np.ndarray, bpm: float, hop: int = HOP) -> list[float]:
    """Snap each grid beat to the strongest local onset within ±30% of a beat."""
    if not times or env.size == 0:
        return times
    half = max(1, int(round(0.3 * (60.0 / bpm) * SAMPLE_RATE / hop)))
    out: list[float] = []
    n = len(env)
    for t in times:
        center = int(round(t * SAMPLE_RATE / hop))
        a = max(0, center - half)
        b = min(n, center + half + 1)
        if a >= b:
            out.append(t)
            continue
        local = env[a:b]
        peak = int(a + np.argmax(local))
        out.append(peak * hop / SAMPLE_RATE)
    return out


def _grid_beats(duration_s: float, bpm: float, phase_s: float) -> list[float]:
    step = 60.0 / bpm
    t0 = phase_s
    while t0 > 0:
        t0 -= step
    if t0 < -1e-6:
        t0 += step
    beats: list[float] = []
    t = t0
    while t < duration_s - 1e-4:
        if t >= -1e-6:
            beats.append(t)
        t += step
    return beats


def _downbeats(beats: list[float], bpm: float | None, phase_s: float = 0.0) -> list[float]:
    if not beats:
        return []
    if not bpm or bpm < 40:
        return beats[::4]
    bar = 4 * (60.0 / bpm)
    out = [b for b in beats if abs((b - phase_s) % bar) < 0.06 or abs((b - phase_s) % bar - bar) < 0.06]
    if len(out) >= 2:
        return out
    return beats[::4]


def _pick_peaks_fallback(env: np.ndarray, hop: int = HOP, min_gap_s: float = 0.28) -> list[float]:
    """Legacy onset peaks when tempo estimation fails."""
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


def analyze_beats(
    media_path: str | Path,
    start_s: float = 0.0,
    end_s: float | None = None,
) -> dict:
    """Return beat markers as **file-absolute** seconds.

    Tempo is estimated from file start (capped) so short clip trims still get a
    stable BPM/phase. Returned beats are filtered to ``[start_s, end_s]`` when
    a window is requested.
    """
    src = Path(media_path)
    if not src.is_file():
        raise FileNotFoundError(str(src))
    start_s = max(0.0, float(start_s))
    end_s_f = float(end_s) if end_s is not None and end_s > start_s else None

    decode_end = end_s_f if end_s_f is not None else MAX_ANALYZE_S
    decode_end = min(max(decode_end, start_s + 1.0), MAX_ANALYZE_S)
    decode_dur = decode_end

    with tempfile.TemporaryDirectory(dir=settings.DATA_DIR) as tmp:
        wav = Path(tmp) / "mono.wav"
        try:
            _extract_mono_wav(src, wav, start_s=0.0, duration_s=decode_dur)
        except subprocess.CalledProcessError as e:
            err = (e.stderr or b"").decode("utf-8", errors="replace")[:400]
            raise RuntimeError(f"Не удалось извлечь аудио: {err}") from e
        y = _read_wav_mono(wav)

    if y.size < SAMPLE_RATE // 2:
        return {
            "beats": [],
            "downbeats": [],
            "bpm": None,
            "offset": 0.0,
            "windowStart": start_s,
            "timespace": "file",
        }

    duration = len(y) / SAMPLE_RATE
    env = _onset_envelope(y, hop=HOP)
    bpm = _bpm_from_onset(env, hop=HOP)

    if bpm:
        phase = _align_phase(env, bpm, hop=HOP)
        rel = _grid_beats(duration, bpm, phase)
        rel = _refine_to_peaks(rel, env, bpm, hop=HOP)
        beats = [round(t, 4) for t in rel]
        downbeats = [round(t, 4) for t in _downbeats(beats, bpm, phase)]
        offset = beats[0] if beats else 0.0
    else:
        rel = _pick_peaks_fallback(env, hop=HOP)
        beats = [round(t, 4) for t in rel]
        downbeats = [round(t, 4) for t in _downbeats(beats, None)]
        offset = beats[0] if beats else 0.0

    if end_s_f is not None:
        lo, hi = start_s, end_s_f
        beats = [t for t in beats if lo - 1e-3 <= t <= hi + 1e-3]
        downbeats = [t for t in downbeats if lo - 1e-3 <= t <= hi + 1e-3]
    elif start_s > 0:
        beats = [t for t in beats if t >= start_s - 1e-3]
        downbeats = [t for t in downbeats if t >= start_s - 1e-3]

    return {
        "beats": beats,
        "downbeats": downbeats,
        "bpm": bpm,
        "offset": round(offset, 4),
        "windowStart": round(start_s, 4),
        "timespace": "file",
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
