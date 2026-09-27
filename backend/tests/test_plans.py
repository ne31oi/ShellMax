"""Plan audio overlap + beat helpers."""

import wave
from pathlib import Path

import numpy as np

from app.media.beats import (
    SAMPLE_RATE,
    _bpm_from_onset,
    _onset_envelope,
    analyze_beats,
)
from app.plans import overlapping_audio
from app.timeline_schema import parse_timeline


def test_overlapping_audio_trims_to_plan():
    doc = parse_timeline({
        "tracks": [
            {"id": "v1", "kind": "video", "clips": [], "plans": []},
            {
                "id": "p1",
                "kind": "plan",
                "plans": [{
                    "id": "pl1",
                    "start": 1.0,
                    "duration": 2.0,
                    "prompt": "x",
                    "audio": {"a1": True},
                }],
            },
            {
                "id": "a1",
                "kind": "audio",
                "clips": [{"id": "ac1", "assetId": 1, "in": 0.5, "out": 5.0, "start": 0.0}],
            },
        ],
    })
    plan = doc.tracks[1].plans[0]
    hits = overlapping_audio(doc, plan)
    assert len(hits) == 1
    _t, _c, src_in, src_out = hits[0]
    assert abs(src_in - 1.5) < 1e-6
    assert abs(src_out - 3.5) < 1e-6


def test_overlapping_respects_disabled_track():
    doc = parse_timeline({
        "tracks": [
            {"id": "v1", "kind": "video", "clips": [], "plans": []},
            {
                "id": "p1",
                "kind": "plan",
                "plans": [{
                    "id": "pl1",
                    "start": 0,
                    "duration": 2,
                    "audio": {"a1": False},
                }],
            },
            {
                "id": "a1",
                "kind": "audio",
                "clips": [{"id": "ac1", "assetId": 1, "in": 0, "out": 3, "start": 0}],
            },
        ],
    })
    assert overlapping_audio(doc, doc.tracks[1].plans[0]) == []


def _click_train(bpm: float, duration_s: float, phase_s: float = 0.0) -> np.ndarray:
    sr = SAMPLE_RATE
    y = np.zeros(int(sr * duration_s), dtype=np.float32)
    step = 60.0 / bpm
    t = phase_s
    while t < duration_s:
        i = int(t * sr)
        if 0 <= i < len(y):
            # Short decaying click — strong spectral onset
            n = min(800, len(y) - i)
            y[i : i + n] = np.linspace(1.0, 0.0, n, dtype=np.float32)
        t += step
    return y


def test_tempo_from_120bpm_clicks():
    y = _click_train(120.0, 8.0, phase_s=0.1)
    env = _onset_envelope(y)
    bpm = _bpm_from_onset(env)
    assert bpm is not None
    assert abs(bpm - 120.0) <= 4.0


def test_analyze_beats_file_absolute_and_window(tmp_path: Path):
    """Beats are file-absolute; a mid-file window keeps media timestamps."""
    bpm = 120.0
    phase = 0.05
    y = _click_train(bpm, 6.0, phase_s=phase)
    wav = tmp_path / "metro.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        pcm = (np.clip(y, -1, 1) * 32767).astype(np.int16)
        w.writeframes(pcm.tobytes())

    # Full file
    full = analyze_beats(wav)
    assert full["timespace"] == "file"
    assert full["bpm"] is not None
    assert abs(full["bpm"] - 120) <= 4
    assert len(full["beats"]) >= 8
    # First beat near phase
    assert abs(full["beats"][0] - phase) < 0.08

    # Window in the middle of the file (simulates clip.in / clip.out)
    win = analyze_beats(wav, start_s=2.0, end_s=4.0)
    assert win["timespace"] == "file"
    assert all(2.0 - 0.05 <= b <= 4.0 + 0.05 for b in win["beats"])
    # Still file-absolute — NOT relative to window start
    assert win["beats"][0] >= 1.9
    # Gaps ≈ 0.5 s
    if len(win["beats"]) >= 3:
        gaps = np.diff(win["beats"])
        assert abs(float(np.median(gaps)) - 0.5) < 0.08
