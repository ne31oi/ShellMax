"""Build workflows/ShellMax_SoL_Refiner.json with only paths, prompt, geometry and seeds substituted.

The worker uses NVIDIA's fixed one-step sigma. Padding/trimming preserves the source frame count;
the source audio is remuxed. These are media wrappers, not sampler changes.
"""
from .sol_refiner import SoLRefinerFull

STAGE_BY_NODE = {"1": "refine"}
FINAL_OUTPUT_NODE = "1"
SAMPLER_NODES: tuple[str, ...] = ()


def build_sol_refiner_prompt(p: SoLRefinerFull) -> dict:
    return {"1": {"class_type": "ShellMaxSoLRefinerByPath", "inputs": p.model_dump()}}
