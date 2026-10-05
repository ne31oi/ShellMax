"""Opt-in RefMod workflows. The original three generation graphs stay intact.

Each source .api.json fixes the recipe and IDs. Only refs, prompt, model paths,
seed, resolution, duration, expert values and filename are substituted, exactly
as in its base builder. Node 56 uses Fantastic Text Encode (latent output 2).
"""

import json

from . import builder, builder_memory, builder_nvfp4, builder_nvfp4_fast
from .params import FullParams
from .builder_pdmd import build_pdmd_graph
from .single_pass import final_canvas_graph

BASE_BUILDERS = {"generate": builder.build_prompt,
                 "generate_memory": builder_memory.build_memory_prompt,
                 "generate_nvfp4": builder_nvfp4.build_nvfp4_prompt,
                 "generate_nvfp4_fast": builder_nvfp4_fast.build_nvfp4_fast_prompt,
                 "generate_pdmd": build_pdmd_graph}
STAGE_BY_NODE = {**builder.STAGE_BY_NODE, "refmod_stack": "encode", "ref_bundle": "encode"}
SAMPLER_NODES = builder.SAMPLER_NODES
FINAL_OUTPUT_NODE = builder.FINAL_OUTPUT_NODE
DRAFT_OUTPUT_NODE = builder.DRAFT_OUTPUT_NODE


def refmod_inputs(p: FullParams) -> dict:
    picks = []
    for ref in p.refs:
        if ref.refmod_file:
            channel = "audio" if ref.kind == "audio" else "visual"
            picks.append({channel: {"file": ref.refmod_file, "w": ref.strength}})
    return {"class_type": "MiniMaxH3RefModStack",
            "inputs": {"stack_state": json.dumps({"picks": picks}, ensure_ascii=False)}}


def build_refmod_prompt(p: FullParams, pipeline: str = "generate") -> dict:
    plain = p.model_copy(update={"refs": [r for r in p.refs if not r.refmod_file]})
    g = BASE_BUILDERS[pipeline](plain)
    inputs = g["56"]["inputs"]
    media = {k.replace("ref_images.", "").replace("ref_videos.", "").replace("ref_audios.", "")
             .replace("ref_video_audios.", ""): v for k, v in inputs.items() if k.startswith("ref_") and "." in k}
    g["ref_bundle"] = {"class_type": "ShellMaxH3ReferenceBundle", "inputs": media}
    g["refmod_stack"] = refmod_inputs(p)
    g["56"] = {"class_type": "MiniMaxH3FantasticRefModTextEncode", "inputs": {
        **{k: v for k, v in inputs.items() if k in ("clip", "vae", "audio_vae", "prompt", "width", "height", "length", "ref_image_size")},
        "reference_fps": 24.0, "max_total_tokens": 0,
        "mods": ["refmod_stack", 0], "references": ["ref_bundle", 0],
        "voice_description_at_label": False, "stack_pictures": "every 4th"}}
    g["108"]["inputs"]["latent_image"] = ["56", 2]
    return g


def build_nvfp4_refmod_prompt(p: FullParams) -> dict:
    return build_refmod_prompt(p, "generate_nvfp4")


def build_memory_refmod_prompt(p: FullParams) -> dict:
    return build_refmod_prompt(p, "generate_memory")


def build_fast_refmod_prompt(p: FullParams) -> dict:
    return build_refmod_prompt(p, "generate_nvfp4_fast")


def build_pdmd_refmod_prompt(p: FullParams) -> dict:
    graph = build_refmod_prompt(p, "generate_pdmd")
    return final_canvas_graph(graph, p, latent=["56", 2]) if p.expert.split_step == 0 else graph
