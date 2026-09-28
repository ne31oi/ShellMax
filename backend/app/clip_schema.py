"""Persistent, validated directing documents. Model output is always a proposal."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Passport(StrictModel):
    concept: str = ""
    hero: str = ""
    costume: str = ""
    locations: str = ""
    palette: str = ""
    constraints: str = ""
    aspect: Literal["1:1 (Square)", "2:3 (Portrait Photo)", "3:2 (Photo)", "3:4 (Portrait Standard)",
                    "4:3 (Standard)", "9:16 (Portrait Widescreen)", "16:9 (Widescreen)", "21:9 (Ultrawide)"] = "16:9 (Widescreen)"
    lipsync: str = "Выборочно, после обсуждения"


class CameraCard(StrictModel):
    support: str = Field(min_length=1)
    start: str = Field(min_length=1)
    path: str = Field(min_length=1)
    orientation: str = Field(min_length=1)
    lens_focus: str = Field(min_length=1)
    speed: str = Field(min_length=1)
    anchor_parallax: str = Field(min_length=1)
    end: str = Field(min_length=1)


class Shot(StrictModel):
    id: str = ""
    name: str = Field(min_length=1)
    start: float = Field(ge=0)
    duration: float = Field(ge=0.2, le=150)
    idea: str = Field(min_length=1)
    action: str = Field(min_length=1)
    music: str = Field(min_length=1)
    subject_motion: str = Field(min_length=1)
    background_motion: str = Field(min_length=1)
    incoming_cut: str = Field(min_length=1)
    outgoing_cut: str = Field(min_length=1)
    camera: CameraCard
    light: str = Field(min_length=1)
    ref_ids: list[str] = Field(default_factory=list, max_length=12)
    lipsync: bool = False
    prompt: str = ""


class BlockOutline(StrictModel):
    id: str = ""
    name: str = Field(min_length=1)
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    intent: str = Field(min_length=1)

    @model_validator(mode="after")
    def check_range(self):
        if self.end <= self.start:
            raise ValueError("Конец блока должен быть позже начала")
        return self


class BlockDraft(StrictModel):
    shots: list[Shot] = Field(min_length=1, max_length=32)


class Treatment(StrictModel):
    passport: Passport
    blocks: list[BlockOutline] = Field(min_length=1, max_length=100)


class EditorialReview(StrictModel):
    approved: bool
    notes: list[str]


class Section(StrictModel):
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    label: str
    tentative: bool = True


class Word(StrictModel):
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    word: str
    probability: float = Field(ge=0, le=1)


class AudioAnalysis(StrictModel):
    version: int = 1
    fingerprint: str
    start: float
    end: float
    timespace: Literal["file"] = "file"
    beats: list[float] = Field(default_factory=list)
    energy: list[list[float]] = Field(default_factory=list)
    changes: list[list[float]] = Field(default_factory=list)
    pauses: list[list[float]] = Field(default_factory=list)
    repetitions: list[list[float]] = Field(default_factory=list)
    sections: list[Section] = Field(default_factory=list)
    words: list[Word] = Field(default_factory=list)
    lyrics: str = ""
    warnings: list[str] = Field(default_factory=list)


class BlockVersion(StrictModel):
    version: int
    shots: list[Shot]
    review: list[str] = Field(default_factory=list)
    draft_approved: bool = False
    final_approved: bool = False
    selected_draft: dict[str, int] = Field(default_factory=dict)
    selected_final: dict[str, int] = Field(default_factory=dict)


class ClipBlock(BlockOutline):
    versions: list[BlockVersion] = Field(default_factory=list)
    stale: bool = False


class ClipDocument(StrictModel):
    name: str
    idea: str
    audio_asset_id: int
    audio_start: float = Field(ge=0)
    audio_end: float = Field(gt=0)
    ref_ids: list[str] = Field(default_factory=list, max_length=12)
    passport: Passport = Field(default_factory=Passport)
    passport_approved: bool = False
    analysis: AudioAnalysis | None = None
    blocks: list[ClipBlock] = Field(default_factory=list)
    quality: Literal["draft", "standard", "high"] = "standard"
    messages: list[dict[str, str]] = Field(default_factory=list)

    @model_validator(mode="after")
    def valid_audio(self):
        if self.audio_end <= self.audio_start:
            raise ValueError("Конец аудио должен быть позже начала")
        return self


def check_coverage(spans: list[tuple[float, float]], start: float, end: float) -> None:
    cursor = round(start * 24)
    for a, b in spans:
        if round(a * 24) != cursor or round(b * 24) <= cursor:
            raise ValueError(f"Пропуск или наложение около {cursor / 24:.2f} с — поправьте границы кадров")
        cursor = round(b * 24)
    if cursor != round(end * 24):
        raise ValueError(f"Кадры должны закрывать интервал до {end:.2f} с")
