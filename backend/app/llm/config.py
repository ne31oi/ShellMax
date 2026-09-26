"""Assistant settings (persisted in KV). Defaults = Minimax Studio V6 config.ini [llm]."""

from typing import Literal

from pydantic import BaseModel, Field

from ..db.models import kv_get, kv_set
from .registry import CHOICES, DEFAULT_CHOICE

KV_KEY = "assistant_settings"


class AssistantSettings(BaseModel):
    model: str = DEFAULT_CHOICE
    device: Literal["gpu", "cpu"] = "gpu"  # studio 'auto' resolves to GPU once ComfyUI is unloaded
    context_size: int = Field(25600, ge=8192, le=102400)  # studio (правка 119)
    max_output_tokens: int = Field(4096, ge=256, le=16384)
    kv_cache: Literal["off", "q8_0", "q5_1", "q4_0"] = "q4_0"  # studio (правка 119)
    video_vision: bool = False  # studio (правка 53): video refs are tags only, saves context
    sampling_override: bool = False
    temperature: float = 0.7
    top_p: float = 0.95
    top_k: int = 40
    min_p: float = 0.05
    presence_penalty: float = 0.0
    frequency_penalty: float = 0.0
    repeat_penalty: float = 1.0


def load() -> AssistantSettings:
    s = AssistantSettings(**(kv_get(KV_KEY, {}) or {}))
    if s.model not in CHOICES:
        s.model = DEFAULT_CHOICE
    return s


def save(s: AssistantSettings) -> None:
    kv_set(KV_KEY, s.model_dump())
