"""Editable quality presets (megapixels + scale) with reset to workflow defaults."""

from app.db.models import kv_set
from app.workflow import quality as quality_cfg
from app.workflow.params import UIParams
from app.workflow.presets import expand, resolution_for
from tests.test_presets import profile


def setup_function():
    kv_set(quality_cfg.KV_KEY, {})


def test_defaults_match_workflow_json():
    qp = quality_cfg.quality_presets()
    assert qp["draft"] == {"label": "Черновик", "megapixels": 0.3, "scale": 1.5}
    assert qp["standard"]["megapixels"] == 0.5
    assert qp["high"]["megapixels"] == 0.9
    assert all(quality_cfg.is_workflow_value(k, v) for k, v in qp.items())


def test_save_overrides_affect_expand_and_resolution():
    quality_cfg.save_quality_presets({
        "draft": {"label": "Лёгкий", "megapixels": 0.2, "scale": 1.5},
        "standard": {"label": "Стандарт", "megapixels": 0.5, "scale": 1.5},
        "high": {"label": "Высокое", "megapixels": 1.0, "scale": 1.5},
    })
    qp = quality_cfg.quality_presets()
    assert qp["draft"]["label"] == "Лёгкий"
    assert qp["draft"]["megapixels"] == 0.2
    assert not quality_cfg.is_workflow_value("draft", qp["draft"])
    assert quality_cfg.is_workflow_value("standard", qp["standard"])

    full = expand(UIParams(prompt="p", quality="draft"), profile(), [], [], seed=1, filename_prefix="x")
    assert (full.megapixels, full.upscale) == (0.2, 1.5)
    # smaller megapixels than workflow draft (0.3) → smaller base
    assert resolution_for("16:9 (Widescreen)", "draft")["base"][0] < 704


def test_reset_restores_workflow():
    quality_cfg.save_quality_presets({
        "draft": {"label": "X", "megapixels": 0.15, "scale": 1.2},
        "standard": {"label": "Y", "megapixels": 0.6, "scale": 1.5},
        "high": {"label": "Z", "megapixels": 1.2, "scale": 2.0},
    })
    assert quality_cfg.reset_quality_presets() == quality_cfg.workflow_quality_presets()
    assert quality_cfg.quality_presets()["draft"]["megapixels"] == 0.3


def test_save_rejects_unknown_or_out_of_range():
    import pytest

    with pytest.raises(ValueError):
        quality_cfg.save_quality_presets({"draft": {"label": "A", "megapixels": 0.3, "scale": 1.5}})
    with pytest.raises(Exception):
        quality_cfg.save_quality_presets({
            "draft": {"label": "A", "megapixels": 9.0, "scale": 1.5},
            "standard": {"label": "B", "megapixels": 0.5, "scale": 1.5},
            "high": {"label": "C", "megapixels": 0.9, "scale": 1.5},
        })
