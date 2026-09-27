"""DualSampling with a separate mixed NVFP4 model for final refinement.

Matches workflows/ShellMax_NVFP4_DualSampling.json. The original Singularity
graph remains the first-pass recipe. Only the final model chain is duplicated;
sampling, conditioning, latent upscale and LoRA strengths are preserved.
Reference slots and enabled LoRA stacks expand just as in builder.py.
"""

from copy import deepcopy

from . import builder
from .params import FullParams

DRAFT_OUTPUT_NODE = builder.DRAFT_OUTPUT_NODE
FINAL_OUTPUT_NODE = builder.FINAL_OUTPUT_NODE
SAMPLER_NODES = builder.SAMPLER_NODES
STAGE_BY_NODE = {**builder.STAGE_BY_NODE, "nvfp4_69": "final"}


def build_nvfp4_prompt(p: FullParams) -> dict:
    if not p.nvfp4_unet:
        raise ValueError("Укажите модель финального прохода в профиле NVFP4")
    graph = builder.build_prompt(p)
    chain = [n for n in ("69", "70", "119", "121", "142", "143") if n in graph]
    chain.extend(n for n in graph if n.startswith("118_"))
    remap = {n: "nvfp4_" + n for n in chain}
    for node in chain:
        duplicate = deepcopy(graph[node])
        for key, value in duplicate["inputs"].items():
            if isinstance(value, list) and len(value) == 2 and value[0] in remap:
                duplicate["inputs"][key] = [remap[value[0]], value[1]]
        graph[remap[node]] = duplicate
    graph["nvfp4_69"]["inputs"]["unet_path"] = p.nvfp4_unet
    # With no final LoRA, the guider connects directly to the main stack.
    target = "127_0" if "127_0" in graph else "126"
    model = graph[target]["inputs"]["model"]
    graph[target]["inputs"]["model"] = [remap[model[0]], model[1]]
    return graph
