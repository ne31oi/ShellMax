"""Five-interval NVFP4 final, matching ShellMax_NVFP4_DualSampling_5.json.

The INT8 first pass is identical to the ten-interval recipe. Only node 106's
sigmas change: the five remaining base intervals replace their subdivisions.
The saved workflow fixes the schedule boundary; reject incompatible edits
instead of silently moving it and changing the initial latent noise level.
"""

from .builder_nvfp4 import (DRAFT_OUTPUT_NODE, FINAL_OUTPUT_NODE, SAMPLER_NODES,
                            STAGE_BY_NODE, build_nvfp4_prompt)
from .params import FullParams


def build_nvfp4_fast_prompt(p: FullParams) -> dict:
    x = p.expert
    if (x.steps, x.extend_steps, x.split_step) != (6, 2, 2):
        raise ValueError("Для NVFP4 на 5 интервалов нужны: шаги 6, расширение 2, разделение 2. "
                         "Верните эти значения в настройках эксперта профиля.")
    graph = build_nvfp4_prompt(p)
    graph["nvfp4_short_final"] = {"class_type": "SplitSigmas",
                                  "inputs": {"sigmas": ["71", 0], "step": 1}}
    graph["106"]["inputs"]["sigmas"] = ["nvfp4_short_final", 1]
    return graph
