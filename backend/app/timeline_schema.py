"""Timeline document: normalize camelCase/snake_case blobs and validate clips."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import AliasChoices, BaseModel, Field, field_validator, model_validator


class TimelineClip(BaseModel):
    id: str
    asset_id: int = Field(validation_alias=AliasChoices("assetId", "asset_id"))
    in_: float = Field(validation_alias=AliasChoices("in", "in_"), ge=0)
    out: float = Field(ge=0)

    model_config = {"populate_by_name": True}

    @model_validator(mode="after")
    def _range(self) -> TimelineClip:
        if self.out <= self.in_:
            raise ValueError(f"clip {self.id}: out must be > in")
        return self


class TimelineTrack(BaseModel):
    id: str
    kind: Literal["video", "audio"] = "video"
    clips: list[TimelineClip] = Field(default_factory=list)


class TimelineDoc(BaseModel):
    tracks: list[TimelineTrack] = Field(default_factory=list)

    @field_validator("tracks", mode="before")
    @classmethod
    def _ensure_list(cls, v: Any) -> Any:
        return v if isinstance(v, list) else []


def empty_timeline() -> dict[str, Any]:
    return {"tracks": [{"id": "v1", "kind": "video", "clips": []}]}


def normalize_timeline(raw: dict[str, Any] | None) -> dict[str, Any]:
    """Accept frontend camelCase or legacy snake_case; return camelCase for the UI."""
    if not raw or not isinstance(raw, dict):
        return empty_timeline()
    doc = TimelineDoc.model_validate(raw)
    if not doc.tracks:
        return empty_timeline()
    out_tracks = []
    for t in doc.tracks:
        out_tracks.append({
            "id": t.id,
            "kind": t.kind,
            "clips": [
                {"id": c.id, "assetId": c.asset_id, "in": c.in_, "out": c.out}
                for c in t.clips
            ],
        })
    return {"tracks": out_tracks}


def parse_timeline(raw: dict[str, Any] | None) -> TimelineDoc:
    normalized = normalize_timeline(raw)
    return TimelineDoc.model_validate(normalized)


def video_clips(doc: TimelineDoc) -> list[TimelineClip]:
    for t in doc.tracks:
        if t.kind == "video":
            return list(t.clips)
    return list(doc.tracks[0].clips) if doc.tracks else []
