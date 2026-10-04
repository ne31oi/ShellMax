"""Match ShellMax_DLSS5.json; replace source, controls, encoding and output name.

Split the queue's filename_prefix into directory/basename because DLSS5 forbids
path separators in its prefix. Settings and metadata links retain the golden IDs.
"""
import json
from pathlib import PurePosixPath

from .. import settings
from .dlss5 import DLSS5Full

STAGE_BY_NODE = {"1": "load", "2": "enhance", "3": "save", "4": "save"}
FINAL_OUTPUT_NODE = "4"
SAMPLER_NODES: tuple[str, ...] = ()


def build_dlss5_prompt(p: DLSS5Full) -> dict:
    graph = json.loads((settings.ROOT / "workflows/ShellMax_DLSS5.json").read_text(encoding="utf-8"))
    graph["1"]["inputs"].update(p.controls)
    prefix = PurePosixPath(p.filename_prefix.replace("\\", "/"))
    graph["2"]["inputs"].update(video_path=p.source_path, codec=p.codec, container=p.container,
        quality=p.quality, filename_prefix=prefix.name, output_directory=str(prefix.parent), max_frames=p.max_frames)
    graph["3"]["inputs"]["source_path"] = p.source_path
    return graph
