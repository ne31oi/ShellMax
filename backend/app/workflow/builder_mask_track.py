"""SAM tracking graph, matching ShellMax_MaskTrack.api.json.

Only source, model path, trim and the user's point/text prompts vary.
The artifact output stores masks; it does not sample or regenerate video.
"""

import json

from .fantastic import MaskTrackFull

STAGE_BY_NODE = {"sam_loader": "load", "sam_track": "track"}
SAMPLER_NODES = ()
FINAL_OUTPUT_NODE = "sam_track"


def build_mask_track_prompt(p: MaskTrackFull) -> dict:
    return {
        "sam_loader": {"class_type": "ShellMaxCheckpointLoaderByPath", "inputs": {"checkpoint_path": p.model_path}},
        "sam_track": {"class_type": "ShellMaxH3ObjectMask", "inputs": {
            "model": ["sam_loader", 0], "clip": ["sam_loader", 1], "video": p.sources[0].file,
            "text": p.text, "points": json.dumps({"frames": [frame.model_dump() for frame in p.points]}),
            "start": p.start, "end": p.end, "threshold": p.threshold, "max_objects": p.max_objects,
            "mode": "replace", "base": "", "every_frame": False}},
    }
