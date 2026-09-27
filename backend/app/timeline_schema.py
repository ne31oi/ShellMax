"""Timeline document: normalize camelCase/snake_case blobs and validate clips/plans."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import AliasChoices, BaseModel, Field, field_validator, model_validator


class TimelineClip(BaseModel):
    id: str
    asset_id: int = Field(validation_alias=AliasChoices("assetId", "asset_id"))
    in_: float = Field(validation_alias=AliasChoices("in", "in_"), ge=0)
    out: float = Field(ge=0)
    muted: bool = False
    # Absolute start on master clock (audio tracks). Video track ignores this (magnetic).
    start: float | None = Field(default=None, ge=0)

    model_config = {"populate_by_name": True}

    @model_validator(mode="after")
    def _range(self) -> TimelineClip:
        if self.out <= self.in_:
            raise ValueError(f"clip {self.id}: out must be > in")
        return self


class PlanRef(BaseModel):
    kind: Literal["image", "video", "audio"]
    upload_id: str = Field(validation_alias=AliasChoices("uploadId", "upload_id"))
    with_audio: bool = Field(default=False, validation_alias=AliasChoices("withAudio", "with_audio"))

    model_config = {"populate_by_name": True}


class PlanStyle(BaseModel):
    style_id: int = Field(validation_alias=AliasChoices("styleId", "style_id"))
    strength: float | None = None

    model_config = {"populate_by_name": True}


class PlanBlock(BaseModel):
    id: str
    start: float = Field(ge=0)
    duration: float = Field(ge=0.2, le=150)
    prompt: str = ""
    refs: list[PlanRef] = Field(default_factory=list)
    aspect: str = "16:9 (Widescreen)"
    quality: str = "standard"
    look: str = "cinema"
    light: str = "auto"
    styles: list[PlanStyle] = Field(default_factory=list)
    # trackId -> enabled for auto-wiring audio into this plan
    audio: dict[str, bool] = Field(default_factory=dict)
    lipsync: bool = False
    mode: Literal["draft", "final"] = "draft"
    status: Literal["empty", "queued", "running", "draft", "done", "error"] = "empty"
    generation_id: int | None = Field(default=None, validation_alias=AliasChoices("generationId", "generation_id"))
    draft_asset_id: int | None = Field(default=None, validation_alias=AliasChoices("draftAssetId", "draft_asset_id"))
    output_asset_id: int | None = Field(default=None, validation_alias=AliasChoices("outputAssetId", "output_asset_id"))
    error: str | None = None
    name: str = ""

    model_config = {"populate_by_name": True}


class TimelineTrack(BaseModel):
    id: str
    kind: Literal["video", "audio", "plan"] = "video"
    name: str = ""
    muted: bool = False
    solo: bool = False
    clips: list[TimelineClip] = Field(default_factory=list)
    plans: list[PlanBlock] = Field(default_factory=list)


class TimelineMarkers(BaseModel):
    beats: list[float] = Field(default_factory=list)
    downbeats: list[float] = Field(default_factory=list)
    source_asset_id: int | None = Field(default=None, validation_alias=AliasChoices("sourceAssetId", "source_asset_id"))
    bpm: float | None = None
    offset: float = 0.0

    model_config = {"populate_by_name": True}


class TimelineDoc(BaseModel):
    tracks: list[TimelineTrack] = Field(default_factory=list)
    master_mute: bool = Field(default=False, validation_alias=AliasChoices("masterMute", "master_mute"))
    master_volume: float = Field(default=1.0, ge=0, le=1, validation_alias=AliasChoices("masterVolume", "master_volume"))
    markers: TimelineMarkers | None = None
    snap_to_beats: bool = Field(default=True, validation_alias=AliasChoices("snapToBeats", "snap_to_beats"))

    @field_validator("tracks", mode="before")
    @classmethod
    def _ensure_list(cls, v: Any) -> Any:
        return v if isinstance(v, list) else []


def empty_timeline() -> dict[str, Any]:
    return {
        "tracks": [
            {"id": "v1", "kind": "video", "name": "Видео", "clips": [], "plans": [], "muted": False, "solo": False},
            {"id": "p1", "kind": "plan", "name": "Планы 1", "clips": [], "plans": [], "muted": False, "solo": False},
            {"id": "a1", "kind": "audio", "name": "Аудио 1", "clips": [], "plans": [], "muted": False, "solo": False},
        ],
        "masterMute": False,
        "masterVolume": 1,
        "markers": {"beats": [], "downbeats": [], "bpm": None, "offset": 0},
        "snapToBeats": True,
    }


def _dump_clip(c: TimelineClip) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": c.id,
        "assetId": c.asset_id,
        "in": c.in_,
        "out": c.out,
        "muted": c.muted,
    }
    if c.start is not None:
        out["start"] = c.start
    return out


def _dump_plan(p: PlanBlock) -> dict[str, Any]:
    return {
        "id": p.id,
        "start": p.start,
        "duration": p.duration,
        "prompt": p.prompt,
        "refs": [
            {"kind": r.kind, "uploadId": r.upload_id, "withAudio": r.with_audio}
            for r in p.refs
        ],
        "aspect": p.aspect,
        "quality": p.quality,
        "look": p.look,
        "light": p.light,
        "styles": [{"styleId": s.style_id, "strength": s.strength} for s in p.styles],
        "audio": p.audio,
        "lipsync": p.lipsync,
        "mode": p.mode,
        "status": p.status,
        "generationId": p.generation_id,
        "draftAssetId": p.draft_asset_id,
        "outputAssetId": p.output_asset_id,
        "error": p.error,
        "name": p.name,
    }


def normalize_timeline(raw: dict[str, Any] | None) -> dict[str, Any]:
    """Accept frontend camelCase or legacy snake_case; return camelCase for the UI."""
    if not raw or not isinstance(raw, dict):
        return empty_timeline()
    # Legacy docs without plan/audio tracks still validate.
    doc = TimelineDoc.model_validate(raw)
    if not doc.tracks:
        return empty_timeline()
    out_tracks = []
    for t in doc.tracks:
        out_tracks.append({
            "id": t.id,
            "kind": t.kind,
            "name": t.name or t.id,
            "muted": t.muted,
            "solo": t.solo,
            "clips": [_dump_clip(c) for c in t.clips],
            "plans": [_dump_plan(p) for p in t.plans],
        })
    has_video = any(t["kind"] == "video" for t in out_tracks)
    if not has_video:
        base = empty_timeline()
        out_tracks = base["tracks"][:1] + out_tracks
    markers = doc.markers or TimelineMarkers()
    return {
        "tracks": out_tracks,
        "masterMute": doc.master_mute,
        "masterVolume": doc.master_volume,
        "markers": {
            "beats": list(markers.beats),
            "downbeats": list(markers.downbeats),
            "sourceAssetId": markers.source_asset_id,
            "bpm": markers.bpm,
            "offset": markers.offset,
        },
        "snapToBeats": doc.snap_to_beats,
    }


def parse_timeline(raw: dict[str, Any] | None) -> TimelineDoc:
    normalized = normalize_timeline(raw)
    return TimelineDoc.model_validate(normalized)


def video_clips(doc: TimelineDoc) -> list[TimelineClip]:
    for t in doc.tracks:
        if t.kind == "video":
            return list(t.clips)
    return list(doc.tracks[0].clips) if doc.tracks else []


def plan_tracks(doc: TimelineDoc) -> list[TimelineTrack]:
    return [t for t in doc.tracks if t.kind == "plan"]


def audio_tracks(doc: TimelineDoc) -> list[TimelineTrack]:
    return [t for t in doc.tracks if t.kind == "audio"]


def find_plan(doc: TimelineDoc, plan_id: str) -> tuple[TimelineTrack, PlanBlock] | None:
    for t in doc.tracks:
        if t.kind != "plan":
            continue
        for p in t.plans:
            if p.id == plan_id:
                return t, p
    return None


def all_plans(doc: TimelineDoc) -> list[tuple[TimelineTrack, PlanBlock]]:
    out: list[tuple[TimelineTrack, PlanBlock]] = []
    for t in doc.tracks:
        if t.kind == "plan":
            for p in t.plans:
                out.append((t, p))
    return out
