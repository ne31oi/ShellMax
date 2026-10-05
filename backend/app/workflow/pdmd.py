"""Pinned PDMD 4-NFE DualSampling recipe and its opt-in profile."""

from .. import settings
from .params import EngineProfile, ExpertParams

KIND = "generate_pdmd"


def default_profile() -> EngineProfile:
    from .presets import default_profile as base_profile

    recipe = settings.defaults()["pdmd"]
    return base_profile().model_copy(update={
        "name": recipe["name"], "pipeline": KIND,
        "pdmd_lora": str((settings.ROOT / recipe["lora"]).resolve()),
        "pdmd_strength": recipe["strength"], "pdmd_sparse": recipe["sparse"],
        "loras_main": [], "loras_final": [],
        "expert": ExpertParams(**recipe["expert"]),
    })


def ensure_profile() -> None:
    """Offer the installed recipe without replacing the user's selected profile."""
    from ..db.models import EngineProfileRow, select, session
    from pathlib import Path

    profile = default_profile()
    if not Path(profile.pdmd_lora).is_file():
        return
    with session() as s:
        if any(row.data.get("pipeline") == KIND for row in s.exec(select(EngineProfileRow)).all()):
            return
        s.add(EngineProfileRow(name=profile.name, data=profile.model_dump(), is_default=False))
        s.commit()
