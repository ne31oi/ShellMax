"""Timeline schema normalize / validate — includes plans and markers."""

from app.timeline_schema import empty_timeline, find_plan, normalize_timeline, parse_timeline, video_clips


def test_empty_and_normalize():
    empty = empty_timeline()
    assert empty["tracks"][0]["id"] == "v1"
    assert any(t["kind"] == "plan" for t in empty["tracks"])
    assert empty["masterMute"] is False
    assert "markers" in empty
    assert normalize_timeline(None)["tracks"][0]["id"] == "v1"


def test_camel_case_roundtrip():
    raw = {
        "tracks": [{
            "id": "v1",
            "kind": "video",
            "clips": [{"id": "a", "assetId": 7, "in": 1.0, "out": 3.5, "muted": True}],
        }],
        "masterMute": True,
        "masterVolume": 0.5,
    }
    out = normalize_timeline(raw)
    assert out["tracks"][0]["clips"][0] == {"id": "a", "assetId": 7, "in": 1.0, "out": 3.5, "muted": True}
    assert out["masterMute"] is True
    assert out["masterVolume"] == 0.5


def test_snake_case_input():
    raw = {
        "tracks": [{
            "id": "v1",
            "kind": "video",
            "clips": [{"id": "b", "asset_id": 3, "in": 0, "out": 2}],
        }],
    }
    out = normalize_timeline(raw)
    assert out["tracks"][0]["clips"][0]["assetId"] == 3
    assert out["tracks"][0]["clips"][0]["muted"] is False
    assert out["masterMute"] is False
    assert out["masterVolume"] == 1.0


def test_rejects_inverted_range():
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        parse_timeline({
            "tracks": [{"id": "v1", "kind": "video", "clips": [{"id": "x", "assetId": 1, "in": 5, "out": 2}]}],
        })


def test_video_clips():
    doc = parse_timeline({
        "tracks": [
            {"id": "a1", "kind": "audio", "clips": []},
            {"id": "v1", "kind": "video", "clips": [{"id": "c", "assetId": 1, "in": 0, "out": 1}]},
        ],
    })
    assert len(video_clips(doc)) == 1
    assert video_clips(doc)[0].asset_id == 1


def test_plan_block_roundtrip():
    raw = {
        "tracks": [
            {"id": "v1", "kind": "video", "clips": [], "plans": []},
            {
                "id": "p1",
                "kind": "plan",
                "name": "Планы 1",
                "plans": [{
                    "id": "pl1",
                    "start": 0,
                    "duration": 2,
                    "prompt": "hello",
                    "lipsync": True,
                    "audio": {"a1": True},
                    "status": "empty",
                    "mode": "draft",
                }],
            },
            {"id": "a1", "kind": "audio", "clips": [
                {"id": "ac1", "assetId": 9, "in": 0, "out": 4, "start": 0},
            ]},
        ],
        "markers": {"beats": [0, 0.5, 1.0], "bpm": 120},
        "snapToBeats": True,
    }
    out = normalize_timeline(raw)
    plan = out["tracks"][1]["plans"][0]
    assert plan["prompt"] == "hello"
    assert plan["lipsync"] is True
    assert plan["audio"]["a1"] is True
    assert out["markers"]["bpm"] == 120
    doc = parse_timeline(out)
    hit = find_plan(doc, "pl1")
    assert hit is not None
    assert hit[1].duration == 2
