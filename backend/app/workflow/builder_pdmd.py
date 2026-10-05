"""PDMD 4-NFE DualSampling, matching ShellMax_PDMD4_DualSampling.api.json.

Preserves the base graph's IDs, reference conditioning, x0 latent upscale,
boundary re-noising and noisy audio handoff. PDMD is model-only at strength 1;
The default Euler schedule has four intervals split 2+2, with no subdivisions.
Sparse attention is bypassed for this unvalidated few-step adaptation.
Only the usual media/model paths, seed, prompt, size, duration, optional style
stacks, memory settings, adapter strength, attention and expert sampling settings
vary from the frozen workflow when explicitly selected in the profile.
Zero split selects the corresponding ShellMax_PDMD4_SinglePass workflow:
all steps run at the final canvas, with no draft or intermediate upscale.
"""

from . import builder
from .params import FullParams
from .single_pass import final_canvas_graph

STAGE_BY_NODE = {**builder.STAGE_BY_NODE, "pdmd_lora": "load"}
DRAFT_OUTPUT_NODE = builder.DRAFT_OUTPUT_NODE
FINAL_OUTPUT_NODE = builder.FINAL_OUTPUT_NODE
SAMPLER_NODES = builder.SAMPLER_NODES


def build_pdmd_prompt(p: FullParams) -> dict:
    graph = build_pdmd_graph(p)
    return final_canvas_graph(graph, p) if p.expert.split_step == 0 else graph


def build_pdmd_graph(p: FullParams) -> dict:
    """Build before choosing output topology so RefMods/continuation can add conditioning."""
    if not p.pdmd_lora:
        raise ValueError("Укажите PDMD 4 v6 LoRA в Настройках → Движок.")
    graph = builder.build_prompt(p)
    # Keep the frozen recipe dense, but honor an explicit attention override.
    if not p.pdmd_sparse:
        del graph["121"]
        graph["142" if p.low_vram else "143"]["inputs"]["model"] = ["119", 0]
    graph["pdmd_lora"] = {"class_type": "ShellMaxLoraModelOnlyByPath", "inputs": {
        "model": ["143", 0], "lora_path": p.pdmd_lora, "strength_model": p.pdmd_strength}}
    # Insert before optional creative stacks; the text encoder receives no PDMD delta.
    for node_id in ("118_0", "127_0", "57", "126", "71"):
        node = graph.get(node_id)
        if node and node["inputs"]["model"] == ["143", 0]:
            node["inputs"]["model"] = ["pdmd_lora", 0]
    return graph
