"""Masked-edit recipe, fixed by ShellMax_MaskEdit*.api.json.

Uses the selected profile's model/LoRA chain, one full sampling pass with a
native H3 noise mask, then Fantastic's original-pixel composite. No upscale
or dual-pass sampling: those paths discard the source's noise mask.
Only source, mask geometry, prompt, seed, profile and documented UI values vary.
"""

import json

from .builder import _video_combine
from .builder_refmods import build_refmod_prompt
from .fantastic import MaskEditFull

STAGE_BY_NODE = {"64": "load", "65": "load", "66": "load", "69": "load",
                 "nvfp4_69": "load", "edit_bundle": "encode", "ref_bundle": "encode",
                 "refmod_stack": "encode", "56": "encode", "108": "sample",
                 "109": "decode", "110": "decode", "composite": "stitch", "141": "save"}
SAMPLER_NODES = ("108",)
FINAL_OUTPUT_NODE = "141"


def build_mask_edit_prompt(p: MaskEditFull) -> dict:
    g = build_refmod_prompt(p.base, p.pipeline)
    model = g["126"]["inputs"]["model"]
    g["edit_bundle"] = {"class_type": "ShellMaxH3MaskEditBundle", "inputs": {
        "source": p.sources[0].file, "layers": json.dumps([l.model_dump() for l in p.layers]),
        "start": p.start, "end": p.end, "grow": p.grow, "feather": p.feather,
        "invert": p.invert, "crop_to_mask": p.crop_to_mask, "keep_audio": p.keep_audio,
        "has_audio": p.sources[0].has_audio, "references": ["ref_bundle", 0]}}
    g["56"]["inputs"].update(references=["edit_bundle", 0], length=p.frames)
    g["57"]["inputs"]["model"] = model
    g["71"]["inputs"].update(model=model, denoise=p.strength)
    g["108"]["inputs"].update(sigmas=["71", 0], latent_image=["56", 2])
    g["109"]["inputs"]["samples"] = ["108", 1]
    g["110"]["inputs"]["samples"] = ["108", 1]
    g["composite"] = {"class_type": "MiniMaxH3FantasticEditComposite", "inputs": {
        "images": ["109", 0], "references": ["edit_bundle", 0], "blend": 8, "max_size": 0}}
    audio = ["edit_bundle", 1] if p.keep_audio and p.sources[0].has_audio else ["110", 0]
    g["141"] = _video_combine(["composite", 0], audio, p.filename_prefix, p.base.expert.crf, True)
    # Keep only nodes reachable from the final output, including its model chain.
    used = set()
    def visit(nid: str):
        if nid in used:
            return
        used.add(nid)
        for value in g[nid]["inputs"].values():
            if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str) and value[0] in g:
                visit(value[0])
    visit("141")
    return {nid: node for nid, node in g.items() if nid in used}
