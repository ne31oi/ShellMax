"""Plan audio overlap + beat helpers."""

import numpy as np

from app.media.beats import SAMPLE_RATE, _estimate_bpm, _onset_envelope, _pick_peaks
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


def test_beat_detect_on_clicks():
    sr = SAMPLE_RATE
    y = np.zeros(sr * 4, dtype=np.float32)
    for t in (0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0):
        i = int(t * sr)
        y[i : i + 200] = 1.0
    hop = 512
    env = _onset_envelope(y, hop=hop)
    beats = _pick_peaks(env, hop=hop)
    assert len(beats) >= 4
    bpm = _estimate_bpm(beats)
    assert bpm is None or 100 < bpm < 140
