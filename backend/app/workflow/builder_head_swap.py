"""Head Swap API recipe, preserving the upstream node IDs and sampler values.

ShellMax_HeadSwap.api.json resolves Set/Get links and bypasses UI-only previews.
Absolute-path model loaders delegate to the stock loaders; LoadVideoPath replaces
the FFmpeg upload loader without limiting/resampling the complete source.
Following head-swap.md, both passes use the source resolution. Pixel-edge padding
and repeated final frames satisfy H3's 32 / 17k+5 grids, then are removed. Source
FPS and audio are used at export. Vision generates the actual facial attributes.
The author's two sampler stages and sigma shift remain intact. At the user's
request, reuse ShellMax's Singularity, Qwen, Turbo 4-step, LMS and latent upscaler;
only the dedicated Head Swap LoRA is new. Node 85 uses our existing Qwen3-VL 4B
for image-aware text generation, while node 1 remains the native H3 encoder.

ShellMax_HeadSwap_Target.api.json additionally tracks the head explicitly selected
by the user. Both original sampling passes receive the complete tracked crop
sequence on an automatic canvas, capped at 768. Restore trims the grid padding.
Existing SAM 3 weights segment both heads and source foreground arms. MatAnyone 2
refines the hair alpha over time; ProPainter reconstructs the vacated silhouette.
The stitch delegates to H3FaceStitch, then restores original arm/hand pixels after
feathering. These approved compositor weights do not change the H3 samplers.
The legacy template remains available for previously saved full-frame jobs.
"""
import json
from functools import lru_cache

from .. import settings
from .head_swap import HeadSwapFull, composite_dir, model_paths

STAGE_BY_NODE = {"2": "load", "1": "load", "85": "load", "3": "load", "29": "load",
    "320": "load", "349": "load", "826": "describe", "400": "encode", "81": "encode",
    "14": "pass1", "530": "upscale", "587": "encode2", "548": "encode2", "537": "pass2",
    "538": "decode", "539": "save", "head_track": "track", "head_preview": "track",
    "head_report": "mask", "head_stitch": "stitch", "head_sam": "load", "head_masks": "mask",
    "head_composite": "mask"}
SAMPLER_NODES = ("14", "537")
FINAL_OUTPUT_NODE = "539"
TRACK_PREVIEW_NODE = "head_preview"
TRACK_REPORT_NODE = "head_report"


@lru_cache
def _template(selected: bool) -> dict:
    name = "ShellMax_HeadSwap_Target.api.json" if selected else "ShellMax_HeadSwap.api.json"
    return json.loads((settings.ROOT / "workflows" / name).read_text(encoding="utf-8"))


def build_head_swap_prompt(p: HeadSwapFull) -> dict:
    replacements = {"__SOURCE__": p.source_path, "__IDENTITY__": p.sources[0].file,
                    "__SEED__": p.seed, "__FPS__": p.frame_rate, "__PREFIX__": p.filename_prefix,
                    "__PREVIEW_PREFIX__": p.filename_prefix + "_track",
                    "__TARGET__": p.target.model_dump_json() if p.target else "",
                    "__COMPOSITE_WEIGHTS__": p.composite_weights_dir or str(composite_dir()),
                    **{f"__{key.upper()}__": value for key, value in p.models.items()}}
    graph = json.loads(json.dumps(_template(p.target is not None)))
    if p.target and "__SAM__" not in replacements:
        replacements["__SAM__"] = str(model_paths()["sam"])
    for node in graph.values():
        for key, value in list(node["inputs"].items()):
            if isinstance(value, str) and value in replacements:
                node["inputs"][key] = replacements[value]
    # Silent clips supply no AUDIO value to either conditioning or export.
    if not p.has_audio:
        for nid in ("81", "548", "539"):
            graph[nid]["inputs"].pop("audio", None)
    return graph
