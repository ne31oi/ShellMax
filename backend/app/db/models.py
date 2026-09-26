"""SQLite schema. Designed for the NLE from day one: projects own assets and a timeline document."""

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import JSON, Column
from sqlmodel import Field, Session, SQLModel, create_engine, select

from .. import settings


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Project(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str
    fps: int = 24
    width: int = 1440
    height: int = 832
    # {"tracks": [{"id", "kind": "video"|"audio", "clips": [{"id", "asset_id", "start", "in", "out", "speed", "volume"}]}]}
    timeline: dict[str, Any] = Field(default_factory=lambda: {"tracks": []}, sa_column=Column(JSON))
    created: datetime = Field(default_factory=utcnow)


class EngineProfileRow(SQLModel, table=True):
    __tablename__ = "engine_profile"
    id: int | None = Field(default=None, primary_key=True)
    name: str
    data: dict[str, Any] = Field(sa_column=Column(JSON))  # params.EngineProfile
    is_default: bool = False


class StyleLora(SQLModel, table=True):
    __tablename__ = "style_lora"
    id: int | None = Field(default=None, primary_key=True)
    name: str
    path: str
    default_strength: float = 1.0
    triggers: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    preview_asset_id: int | None = None


class Upload(SQLModel, table=True):
    """A reference file dropped into the generation panel."""
    id: str = Field(primary_key=True)
    kind: str  # image | video | audio
    orig_name: str
    path: str
    duration: float | None = None
    width: int | None = None
    height: int | None = None
    has_audio: bool = False
    comfy_name: str | None = None  # name in ComfyUI input dir once uploaded there
    created: datetime = Field(default_factory=utcnow)


class MediaAsset(SQLModel, table=True):
    __tablename__ = "media_asset"
    id: int | None = Field(default=None, primary_key=True)
    project_id: int = Field(index=True)
    kind: str  # video | image | audio
    name: str
    path: str
    duration: float | None = None
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    has_audio: bool = False
    source: str = "generated"  # generated | imported
    generation_id: int | None = Field(default=None, index=True)
    thumb: str | None = None
    created: datetime = Field(default_factory=utcnow)


class Generation(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    project_id: int = Field(index=True)
    # queued | running | done | draft_only | error | cancelled
    status: str = "queued"
    stage: str | None = None
    progress: float = 0.0
    ui_params: dict[str, Any] = Field(sa_column=Column(JSON))
    full_params: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    seed: int
    profile_name: str = ""
    comfy_prompt_id: str | None = None
    draft_asset_id: int | None = None
    output_asset_id: int | None = None
    error: str | None = None
    error_kind: str | None = None  # oom | missing_file | engine_down | generic
    work_units: float | None = None
    estimate_s: float | None = None
    created: datetime = Field(default_factory=utcnow)
    started: datetime | None = None
    finished: datetime | None = None
    elapsed_s: float | None = None


class KV(SQLModel, table=True):
    """Small persistent settings, e.g. sticky UI values."""
    key: str = Field(primary_key=True)
    value: Any = Field(sa_column=Column(JSON))


engine = create_engine(
    f"sqlite:///{settings.DB_PATH}",
    connect_args={"check_same_thread": False},
)


def init_db() -> None:
    settings.ensure_dirs()
    SQLModel.metadata.create_all(engine)


def session() -> Session:
    return Session(engine, expire_on_commit=False)


def kv_get(key: str, default: Any = None) -> Any:
    with session() as s:
        row = s.get(KV, key)
        return row.value if row else default


def kv_set(key: str, value: Any) -> None:
    with session() as s:
        row = s.get(KV, key)
        if row:
            row.value = value
        else:
            row = KV(key=key, value=value)
        s.add(row)
        s.commit()


__all__ = [
    "Project", "EngineProfileRow", "StyleLora", "Upload", "MediaAsset", "Generation", "KV",
    "engine", "init_db", "session", "kv_get", "kv_set", "select", "utcnow",
]
