"""Timeline schema normalize / validate."""

from app.timeline_schema import empty_timeline, normalize_timeline, parse_timeline, video_clips


def test_empty_and_normalize():
    assert normalize_timeline(None) == empty_timeline()
    assert normalize_timeline({})["tracks"][0]["id"] == "v1"


def test_camel_case_roundtrip():
    raw = {
        "tracks": [{
            "id": "v1",
            "kind": "video",
            "clips": [{"id": "a", "assetId": 7, "in": 1.0, "out": 3.5}],
        }],
    }
    out = normalize_timeline(raw)
    assert out["tracks"][0]["clips"][0] == {"id": "a", "assetId": 7, "in": 1.0, "out": 3.5}


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
