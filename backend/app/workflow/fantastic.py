"""Parameters for opt-in Fantastic H3 references and masked edits."""

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from .params import FullParams


class MediaSource(BaseModel):
    path: str
    file: str = ""
    kind: Literal["picture", "video", "audio"]
    has_audio: bool = False
    audio_mode: str = "off"


class RefModCreateUI(BaseModel):
    upload_ids: list[str] = Field(min_length=1, max_length=15)
    name: str = Field(min_length=1, max_length=100)
    mode: Literal["Full Reference", "Compressed Reference"] = "Compressed Reference"
    include_audio: bool = False
    description: str = Field(default="", max_length=2000)
    profile_id: int | None = None
    source_refmod_file: str = ""


class RefModCreateFull(BaseModel):
    sources: list[MediaSource]
    name: str
    label: str
    mode: str = "Compressed Reference"
    description: str = ""
    vae_video: str
    vae_audio: str
    seed: int = 0
    filename_prefix: str = "ShellMax/refmod"


class MaskKey(BaseModel):
    t: float = Field(ge=0, le=150)
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(gt=0, le=1)
    h: float = Field(gt=0, le=1)
    rot: float = Field(default=0, ge=-180, le=180)


class MaskLayer(BaseModel):
    kind: Literal["ellipse", "rect"] = "ellipse"
    keys: list[MaskKey] = Field(min_length=1, max_length=100)
    motion: Literal["linear", "smooth"] = "linear"
    mode: Literal["add", "cut"] = "add"
    visible: bool = True

    @model_validator(mode="after")
    def unique_keys(self):
        times = [k.t for k in self.keys]
        if times != sorted(set(times)):
            raise ValueError("Ключевые кадры маски должны идти по времени без повторов")
        return self


class AutoMaskLayer(BaseModel):
    kind: Literal["auto"] = "auto"
    result: str
    track_generation_id: int
    mode: Literal["add", "cut"] = "add"
    visible: bool = True


class MaskPoint(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)


class MaskPointFrame(BaseModel):
    time: float = Field(ge=0, le=150)
    positive: list[MaskPoint] = Field(default_factory=list, max_length=64)
    negative: list[MaskPoint] = Field(default_factory=list, max_length=64)


class MaskTrackUI(BaseModel):
    source_asset_id: int
    start: float = Field(default=0, ge=0, le=150)
    end: float = Field(gt=0, le=150)
    text: str = Field(default="", max_length=500)
    points: list[MaskPointFrame] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def has_selection(self):
        if not self.text.strip() and not any(frame.positive for frame in self.points):
            raise ValueError("Щёлкните по объекту или укажите его название")
        if self.end <= self.start or any(p.time < self.start or p.time >= self.end for p in self.points):
            raise ValueError("Точки должны находиться внутри выбранного фрагмента")
        times = [p.time for p in self.points]
        if times != sorted(set(times)):
            raise ValueError("Кадры с точками должны идти по времени без повторов")
        if any(p.negative and not p.positive for p in self.points):
            raise ValueError("На кадре с красными точками нужна зелёная точка внутри объекта")
        return self


class MaskTrackFull(BaseModel):
    sources: list[MediaSource]
    model_path: str
    start: float
    end: float
    text: str = ""
    points: list[MaskPointFrame] = Field(default_factory=list)
    threshold: float = 0.5
    max_objects: int = 4
    seed: int = 0
    filename_prefix: str = "ShellMax/mask_track"


class MaskEditUI(BaseModel):
    source_asset_id: int
    prompt: str = Field(min_length=1, max_length=40000)
    layers: list[MaskLayer | AutoMaskLayer] = Field(min_length=1, max_length=16)
    start: float = Field(default=0, ge=0, le=150)
    end: float | None = Field(default=None, gt=0, le=150)
    strength: float = Field(default=0.8, ge=0.05, le=1)
    invert: bool = False
    grow: int = Field(default=16, ge=0, le=64)
    feather: int = Field(default=12, ge=0, le=64)
    crop_to_mask: bool = False
    keep_audio: bool = True
    quality: str = "standard"
    seed: int | None = None
    profile_id: int | None = None
    reference_upload_ids: list[str] = Field(default_factory=list, max_length=15)


class MaskEditFull(BaseModel):
    base: FullParams
    pipeline: str = "generate"
    sources: list[MediaSource]
    layers: list[MaskLayer | AutoMaskLayer]
    start: float = 0
    end: float
    strength: float = 0.8
    invert: bool = False
    grow: int = 16
    feather: int = 12
    crop_to_mask: bool = False
    keep_audio: bool = True
    frames: int
    seed: int
    filename_prefix: str = "ShellMax/mask"
