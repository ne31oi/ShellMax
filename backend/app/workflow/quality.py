"""Quality presets (draft / standard / high): megapixels + upscale scale.

Workflow defaults live in config/defaults.json. User overrides are stored in KV
and merged on read — same pattern as assistant settings.
"""

from pydantic import BaseModel, Field

from .. import settings
from ..db.models import kv_get, kv_set

KV_KEY = "quality_presets"
PRESET_IDS = ("draft", "standard", "high")


class QualityPresetSpec(BaseModel):
    label: str = Field(min_length=1, max_length=40)
    megapixels: float = Field(ge=0.1, le=2.0)
    scale: float = Field(ge=1.0, le=2.5)


def workflow_quality_presets() -> dict[str, dict]:
    """Immutable defaults from config/defaults.json (workflow values)."""
    raw = settings.defaults()["quality_presets"]
    return {k: QualityPresetSpec(**raw[k]).model_dump() for k in PRESET_IDS}


def quality_presets() -> dict[str, dict]:
    """Active presets: workflow defaults overridden by any saved user values."""
    base = workflow_quality_presets()
    saved = kv_get(KV_KEY) or {}
    if not isinstance(saved, dict):
        return base
    out: dict[str, dict] = {}
    for k in PRESET_IDS:
        patch = saved.get(k)
        if isinstance(patch, dict):
            merged = {**base[k], **{kk: patch[kk] for kk in ("label", "megapixels", "scale") if kk in patch}}
            out[k] = QualityPresetSpec(**merged).model_dump()
        else:
            out[k] = dict(base[k])
    return out


def save_quality_presets(presets: dict[str, dict]) -> dict[str, dict]:
    cleaned: dict[str, dict] = {}
    for k in PRESET_IDS:
        if k not in presets:
            raise ValueError(f"missing quality preset {k!r}")
        cleaned[k] = QualityPresetSpec(**presets[k]).model_dump()
    kv_set(KV_KEY, cleaned)
    return quality_presets()


def reset_quality_presets() -> dict[str, dict]:
    kv_set(KV_KEY, {})
    return workflow_quality_presets()


def is_workflow_value(preset_id: str, preset: dict) -> bool:
    wf = workflow_quality_presets().get(preset_id)
    if not wf:
        return False
    return preset.get("megapixels") == wf["megapixels"] and preset.get("scale") == wf["scale"]
