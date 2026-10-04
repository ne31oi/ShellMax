"""API adapter for H3_BODY_SWAP_MATCHED_HANDS, keeping operative upstream IDs.

Set/Get/Reroute wires are resolved and reference-background preview subgraphs omitted.
The demo's duration subgraph is replaced by a validated 24 fps, 17k+5 fragment:
its exact length is shown before submission (no duplicate tail frames). VHS reads
absolute paths. Path model loaders delegate to stock loaders. The author's crop,
mask cleanup, DWPose, ControlNet 0.8, sigma shifts and 16-step sampler are retained.
New required MaskVid inputs use its pinned defaults (resize_method=auto,
grow_temp_mode=both with zero temporal growth).
Source audio replaces generated export audio. Silent sources condition on silence
and export without audio. A final restore locks original hand pixels after feathering.
Only files, fragment, subject text, replacement description, seed and prefix vary.

Recipe 2 is the explicitly requested full-character replacement. It has separate
workflow files: no Turbo or protected-source-hands branch; 40 steps; ControlNet
1.0 with pose, source video and regeneration mask; original/generated silhouette
union at composite. Historical FullParams without a version still use recipe 1.
Recipe 3 retains full replacement and source context, but restores Turbo/16 steps,
disables source facial landmarks and stops pose control at 70% so reference
identity can resolve in the last steps. Each recipe has a frozen workflow.
Recipe 4 expands the regeneration mask by 48 source pixels before crop, ControlNet
and composite. SAM's soft-edge cleanup alone does not grow beyond its detection,
so source hair outside that detection would otherwise survive as background.
Recipe 5 reconstructs a temporal clean plate with ProPainter and pastes only the
new BiRefNet silhouette over it. The expanded old silhouette supplies the hole;
generated background and old-hair echoes never enter the subject composite.
Recipe 6 registers head height/center to the source track, transfers broad face
illumination separately from clothing and reconstructs only vacated source pixels.
It uses the source BiRefNet matte and local source-pixel extension, avoiding the
checkerboard produced by the whole-person ProPainter clean plate in this scene.
"""
import json
from functools import lru_cache

from .. import settings
from .body_swap import BodySwapFull

STAGE_BY_NODE = {"1191": "load", "1199": "load", "1188": "load", "1117": "load", "1118": "load",
    "1190": "load", "1442": "load", "1280": "load", "1134": "mask", "1434": "mask", "1211": "mask",
    "1446": "pose", "1443": "pose", "1154": "encode", "1206": "encode", "1207": "encode",
    "1423": "encode", "1150": "encode", "1198": "sample", "1216": "decode", "1281": "stitch",
    "1273": "stitch", "body_restore": "stitch", "body_background": "stitch",
    "body_fit": "stitch", "body_old_alpha": "stitch", "1277": "save"}
SAMPLER_NODES = ("1198",)
FINAL_OUTPUT_NODE = "1277"


@lru_cache
def _template(filename: str = "ShellMax_BodySwap.api.json") -> dict:
    return json.loads((settings.ROOT / "workflows" / filename).read_text(encoding="utf-8"))


def build_body_swap_prompt(p: BodySwapFull) -> dict:
    filename = {1: "ShellMax_BodySwap.api.json", 2: "ShellMax_BodySwap_Full.api.json",
                3: "ShellMax_BodySwap_Full_Reference.api.json", 4: "ShellMax_BodySwap_Complete.api.json",
                5: "ShellMax_BodySwap_Background.api.json",6: "ShellMax_BodySwap_Fitted.api.json"}[p.recipe_version]
    return build_from_template(p, _template(filename))


def build_from_template(p: BodySwapFull, template: dict) -> dict:
    values = {"__SOURCE__": p.source_path, "__FRONT__": p.sources[0].file, "__SIDE__": p.sources[1].file,
        "__START__": p.start, "__FRAMES__": p.frames, "__HAS_AUDIO__": p.has_audio,
        "__SUBJECT__": p.subject, "__PROMPT__": p.prompt, "__SEED__": p.seed, "__PREFIX__": p.filename_prefix,
        "__SINGULARITY_UNET__": p.models["unet"],
        "__COMPOSITE_WEIGHTS__": p.composite_weights_dir,
        "__FACE_DETECTOR__": p.face_detector_path,
        **{f"__{key.upper()}__": path for key, path in p.models.items()}}
    graph = json.loads(json.dumps(template))
    for node in graph.values():
        for key, value in list(node["inputs"].items()):
            if isinstance(value, str) and value in values:
                node["inputs"][key] = values[value]
    if not p.has_audio:
        graph["1277"]["inputs"].pop("audio")
    return graph
