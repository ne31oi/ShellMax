"""PDMD 4-NFE DualSampling, matching ShellMax_PDMD4_DualSampling.api.json.

Preserves the base graph's IDs, reference conditioning, x0 latent upscale,
boundary re-noising and noisy audio handoff. PDMD is model-only at strength 1;
The default Euler schedule has four intervals split 2+2, with no subdivisions.
Sparse attention is bypassed for this unvalidated few-step adaptation.
Only the usual media/model paths, seed, prompt, size, duration, optional style
stacks, memory settings and expert step counts vary from the frozen workflow.
Additional Euler steps are experimental: the adapter was trained at four NFE.
"""

from . import builder
from .params import FullParams

STAGE_BY_NODE = {**builder.STAGE_BY_NODE, "pdmd_lora": "load"}
DRAFT_OUTPUT_NODE = builder.DRAFT_OUTPUT_NODE
FINAL_OUTPUT_NODE = builder.FINAL_OUTPUT_NODE
SAMPLER_NODES = builder.SAMPLER_NODES


def build_pdmd_prompt(p: FullParams) -> dict:
    x = p.expert
    if x.sampler != "euler" or x.scheduler != "simple":
        raise ValueError("Для PDMD используйте сэмплер euler и планировщик simple в Настройки → Движок → Эксперт.")
    if x.steps < 4 or x.extend_steps < 1:
        raise ValueError("Для PDMD задайте не менее 4 шагов и расширение сигм не менее 1 в Настройки → Движок → Эксперт.")
    if not 0 < x.split_step < x.steps * x.extend_steps:
        raise ValueError("Разделение DualSampling должно оставлять шаги обоим проходам. "
                         "Для 8 шагов без расширения выберите разделение 4.")
    if not p.pdmd_lora:
        raise ValueError("Укажите PDMD 4 v6 LoRA в Настройках → Движок.")
    if any(l.enabled and l.strength and ("turbo" in l.path.lower() or "pdmd" in l.path.lower())
           for l in [*p.loras_main, *p.loras_final]):
        raise ValueError("PDMD уже заменяет Turbo: уберите Turbo/PDMD из дополнительных технических LoRA.")
    graph = builder.build_prompt(p)
    # The few-step student is first validated with full attention.
    del graph["121"]
    graph["142" if p.low_vram else "143"]["inputs"]["model"] = ["119", 0]
    graph["pdmd_lora"] = {"class_type": "ShellMaxLoraModelOnlyByPath", "inputs": {
        "model": ["143", 0], "lora_path": p.pdmd_lora, "strength_model": 1.0}}
    # Insert before optional creative stacks; the text encoder receives no PDMD delta.
    for node_id in ("118_0", "127_0", "57", "126", "71"):
        node = graph.get(node_id)
        if node and node["inputs"]["model"] == ["143", 0]:
            node["inputs"]["model"] = ["pdmd_lora", 0]
    return graph
