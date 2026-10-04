"""Singularity with bounded activation buffers, matching ShellMax_Singularity_Memory.json.

The sampling steps and native checkpoint precision remain unchanged. Replace
the KJ block-forward patches (70/142/143) with one H3-owned memory provider;
stacking them would silently prevent its bounded MLP implementation from running.
Reference conditioning remains dense. Native H3 sparse attention replaces Sol
so attention can consume streamed QKV; the first two and last steps retain all
video connections, while the middle steps retain a 30% video attention budget.
DualSampling's final pass starts sparse: its lower-noise latents already came
through the protected initial pass. Only its last step restores full connectivity.
"""

from . import builder
from .params import FullParams

STAGE_BY_NODE = {**builder.STAGE_BY_NODE, "memory_opt": "load", "memory_residency": "load",
                 "memory_final_attention": "final"}
SAMPLER_NODES = builder.SAMPLER_NODES
DRAFT_OUTPUT_NODE = builder.DRAFT_OUTPUT_NODE
FINAL_OUTPUT_NODE = builder.FINAL_OUTPUT_NODE


def build_memory_prompt(p: FullParams) -> dict:
    graph = builder.build_prompt(p)
    for node in ("70", "142", "143"):
        graph.pop(node, None)
    graph["119"]["inputs"]["model"] = ["69", 0]
    graph["memory_opt"] = {
        "class_type": "H3MemoryOptimization",
        "inputs": {"model": ["119", 0], "fused_qkv": "auto", "mlp_memory": "auto",
                   "chunk_rows": 4096, "preserve_precision": True,
                   "precision_mode": "Preserve native", "qkv_streaming_mode": "Forced",
                   "embedding_memory_mode": "Auto", "kitchen_v_memory_mode": "Lower VRAM (slower)"},
    }
    graph["memory_residency"] = {"class_type": "H3AIMDOResidencyLimiter",
                                 "inputs": {"model": ["memory_opt", 0], "residency": "stock"}}
    graph["121"] = {
        "class_type": "H3SparseAttentionAdvanced",
        "inputs": {"model": ["memory_residency", 0], "video_budget": 0.3,
                   "early_steps": 2, "early_kv": 1.0, "late_steps": 1, "late_kv": 1.0,
                   "backend": "Kitchen INT8 64Q x 64KV (Quality)",
                   "early_schedule": "Hold", "video_token_order": "Raster (stock H3 order)"},
    }
    for node in graph.values():
        for key, value in node["inputs"].items():
            if value == ["143", 0]:
                node["inputs"][key] = ["121", 0]
    # The native pack refuses two different sparse plans on the same branch.
    # Fork before sparse attention; conditioning still uses the shared main CLIP.
    final_model = ["memory_residency", 0]
    for i, _ in enumerate(builder._active(p.loras_main)):
        source = graph[f"118_{i}"]["inputs"]
        name = f"memory_final_main_{i}"
        graph[name] = {
            "class_type": "ShellMaxLoraModelOnlyByPath",
            "inputs": {"model": final_model, "lora_path": source["lora_path"],
                       "strength_model": source["strength_model"]},
        }
        final_model = [name, 0]
    final_loras = builder._active(p.loras_final)
    if final_loras:
        graph["127_0"]["inputs"]["model"] = final_model
        final_model = [f"127_{len(final_loras) - 1}", 0]
    graph["memory_final_attention"] = {
        "class_type": "H3SparseAttentionAdvanced",
        "inputs": {**graph["121"]["inputs"],
                   "model": final_model, "early_steps": 0},
    }
    graph["126"]["inputs"]["model"] = ["memory_final_attention", 0]
    return graph
