"""ShellMax_H3_Continuation.api.json: DualSampling with a protected AV motion prefix.

The frozen graph uses the PDMD default recipe. Explicit profile overrides select
the existing base builder (including RefMods), paths, references, expert values,
adapter strengths, duration, resolution, prefix length and source offset.
Both passes encode their own prefix at their actual latent resolution. Output
nodes retain their IDs and save only new frames/audio; the source stays intact.
An explicit split of zero selects ShellMax_H3_Continuation_SinglePass.api.json:
sample at the final canvas directly, avoiding a noise-only draft and zero-step
audio handoff at sigma=1. There is no draft or latent upscale in that variant.
"""

from . import builder, builder_refmods, builder_memory, builder_nvfp4
from .continuation import ContinuationFull
from .single_pass import final_canvas_graph

STAGE_BY_NODE = {**builder.STAGE_BY_NODE, **builder_refmods.STAGE_BY_NODE,
                 **builder_memory.STAGE_BY_NODE, **builder_nvfp4.STAGE_BY_NODE,
                 "pdmd_lora": "load", "continue_source": "encode",
                 "continue_prefix": "encode", "continue_prefix_final": "final",
                 "continue_draft": "draft", "continue_final": "decode"}
SAMPLER_NODES = builder.SAMPLER_NODES
FINAL_OUTPUT_NODE = builder.FINAL_OUTPUT_NODE
DRAFT_OUTPUT_NODE = builder.DRAFT_OUTPUT_NODE


def build_continuation_prompt(p: ContinuationFull) -> dict:
    refmods = any(r.refmod_file for r in p.refs)
    g = (builder_refmods.build_refmod_prompt(p, p.base_pipeline) if refmods
         else builder_refmods.BASE_BUILDERS[p.base_pipeline](p))
    g["continue_source"] = {"class_type": "VHS_LoadVideoPath", "inputs": {
        "video": p.source_path, "force_rate": 24, "custom_width": 0, "custom_height": 0,
        "frame_load_cap": p.context_frames, "skip_first_frames": p.source_skip,
        "select_every_nth": 1, "format": "AnimateDiff"}}
    prefix = {"positive": ["56", 0], "vae": ["65", 0], "audio_vae": ["66", 0],
              "images": ["continue_source", 0], "context_frames": p.context_frames}
    if p.source_audio:
        prefix["audio"] = ["continue_source", 2]
    g["continue_prefix"] = {"class_type": "ShellMaxH3ContinuationPrefix", "inputs": {
        **prefix, "latent": ["56", 2 if refmods else 1]}}
    g["57"]["inputs"]["conditioning"] = ["continue_prefix", 0]
    g["108"]["inputs"]["latent_image"] = ["continue_prefix", 1]
    g["continue_prefix_final"] = {"class_type": "ShellMaxH3ContinuationPrefix", "inputs": {
        **prefix, "latent": ["105", 0]}}
    g["126"]["inputs"]["conditioning"] = ["continue_prefix_final", 0]
    g["106"]["inputs"]["latent_image"] = ["continue_prefix_final", 1]
    for name, output, images, audio in (("continue_draft", "135", "138", "139"),
                                        ("continue_final", "141", "109", "110")):
        g[name] = {"class_type": "ShellMaxContinuationOutput", "inputs": {
            "images": [images, 0], "audio": [audio, 0], "context_frames": p.context_frames,
            "added_frames": p.added_frames}}
        g[output]["inputs"].update(images=[name, 0], audio=[name, 1])
    if p.expert.split_step == 0:
        g = final_canvas_graph(g, p, latent=["continue_prefix", 1], conditioning=["continue_prefix", 0])
    return g
