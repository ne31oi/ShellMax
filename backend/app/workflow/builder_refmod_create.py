"""Create RefMod graph; IDs/values match ShellMax_RefMod_Create.api.json.

Only the source media, unique file name, description, mode and VAE paths vary.
The save node is an artifact output, not a video output.
"""

import json

from .fantastic import RefModCreateFull

STAGE_BY_NODE = {"65": "load", "66": "load", "create_refmod": "encode"}
SAMPLER_NODES = ()
FINAL_OUTPUT_NODE = "create_refmod"


def build_create_refmod_prompt(p: RefModCreateFull) -> dict:
    return {
        "65": {"class_type": "ShellMaxVAELoaderByPath", "inputs": {"vae_path": p.vae_video}},
        "66": {"class_type": "ShellMaxVAELoaderByPath", "inputs": {"vae_path": p.vae_audio}},
        "create_refmod": {"class_type": "MiniMaxH3FantasticRefModCreate", "inputs": {
            "name": p.name, "subfolder": "ShellMax", "mode": p.mode,
            "ref_resolution": 768, "grid": 16, "latent_frames": 22,
            "refinement_steps": 500, "max_tokens": 5120, "audio_max_seconds": 30.0,
            "concept_type": "generic", "description": p.description, "write_preview": True,
            "source": json.dumps([s.model_dump(exclude={"path"}) for s in p.sources], ensure_ascii=False),
            "vae": ["65", 0], "audio_vae": ["66", 0]}}
    }
