"""Per job kind: stages (with their share of total time), node -> stage map and output nodes.

Stage lists are mirrored in frontend/src/lib/stages.ts - change both together.
"""

from dataclasses import dataclass, field

from ..workflow import builder, builder_enhance, builder_face, builder_interpolate, builder_nvfp4_fast, builder_nvfp4
from ..workflow import builder_refmods, builder_refmod_create, builder_mask_edit
from ..workflow import builder_mask_track
from ..workflow import builder_fidelity_upscale
from ..workflow import builder_memory
from ..workflow import builder_pdmd
from ..workflow import builder_head_swap
from ..workflow import builder_body_swap
from ..workflow import builder_dlss5


@dataclass(frozen=True)
class Pipeline:
    stages: list[tuple[str, float]]  # execution order, weights sum to 1
    stage_by_node: dict[str, str]
    sampler_nodes: tuple[str, ...]
    final_node: str
    draft_node: str | None = None  # early preview video (generation draft / face tracking preview)
    report_node: str | None = None  # text report saved to Generation.info
    stage_start: dict[str, float] = field(init=False)
    stage_weight: dict[str, float] = field(init=False)

    def __post_init__(self):
        start, acc = {}, 0.0
        for name, weight in self.stages:
            start[name] = acc
            acc += weight
        object.__setattr__(self, "stage_start", start)
        object.__setattr__(self, "stage_weight", dict(self.stages))


PIPELINES = {
    "dlss5": Pipeline(stages=[("load", 0.02), ("enhance", 0.93), ("save", 0.05)],
        stage_by_node=builder_dlss5.STAGE_BY_NODE, sampler_nodes=builder_dlss5.SAMPLER_NODES,
        final_node=builder_dlss5.FINAL_OUTPUT_NODE),
    "body_swap": Pipeline(stages=[("load", 0.05), ("mask", 0.12), ("pose", 0.08), ("encode", 0.15),
        ("sample", 0.50), ("decode", 0.04), ("stitch", 0.04), ("save", 0.02)],
        stage_by_node=builder_body_swap.STAGE_BY_NODE, sampler_nodes=builder_body_swap.SAMPLER_NODES,
        final_node=builder_body_swap.FINAL_OUTPUT_NODE),
    "head_swap": Pipeline(stages=[("load", 0.05), ("track", 0.10), ("describe", 0.05), ("encode", 0.10),
        ("pass1", 0.27), ("upscale", 0.05), ("encode2", 0.10), ("pass2", 0.13), ("decode", 0.04),
        ("mask", 0.05), ("stitch", 0.03), ("save", 0.03)],
        stage_by_node=builder_head_swap.STAGE_BY_NODE, sampler_nodes=builder_head_swap.SAMPLER_NODES,
        final_node=builder_head_swap.FINAL_OUTPUT_NODE, draft_node=builder_head_swap.TRACK_PREVIEW_NODE,
        report_node=builder_head_swap.TRACK_REPORT_NODE),
    "fidelity_upscale": Pipeline(stages=[("load", 0.05), ("upscale", 0.9), ("save", 0.05)],
                                 stage_by_node=builder_fidelity_upscale.STAGE_BY_NODE, sampler_nodes=(),
                                 final_node=builder_fidelity_upscale.FINAL_OUTPUT_NODE),
    "mask_track": Pipeline(stages=[("load", 0.1), ("track", 0.9)], stage_by_node=builder_mask_track.STAGE_BY_NODE,
        sampler_nodes=(), final_node=builder_mask_track.FINAL_OUTPUT_NODE),
    "refmod_create": Pipeline(stages=[("load", 0.1), ("encode", 0.9)],
        stage_by_node=builder_refmod_create.STAGE_BY_NODE, sampler_nodes=(), final_node=builder_refmod_create.FINAL_OUTPUT_NODE),
    "mask_edit": Pipeline(stages=[("load", 0.1), ("encode", 0.15), ("sample", 0.55), ("decode", 0.1), ("stitch", 0.05), ("save", 0.05)],
        stage_by_node=builder_mask_edit.STAGE_BY_NODE, sampler_nodes=builder_mask_edit.SAMPLER_NODES,
        final_node=builder_mask_edit.FINAL_OUTPUT_NODE),
    "generate": Pipeline(
        stages=[("load", 0.08), ("encode", 0.07), ("pass1", 0.25), ("draft", 0.05),
                ("upscale", 0.05), ("pass2", 0.05), ("final", 0.35), ("decode", 0.10)],
        stage_by_node=builder.STAGE_BY_NODE,
        sampler_nodes=builder.SAMPLER_NODES,
        final_node=builder.FINAL_OUTPUT_NODE,
        draft_node=builder.DRAFT_OUTPUT_NODE,
    ),
    "generate_nvfp4": Pipeline(
        stages=[("load", 0.08), ("encode", 0.07), ("pass1", 0.25), ("draft", 0.05),
                ("upscale", 0.05), ("pass2", 0.05), ("final", 0.35), ("decode", 0.10)],
        stage_by_node=builder_nvfp4.STAGE_BY_NODE,
        sampler_nodes=builder_nvfp4.SAMPLER_NODES,
        final_node=builder_nvfp4.FINAL_OUTPUT_NODE,
        draft_node=builder_nvfp4.DRAFT_OUTPUT_NODE,
    ),
    "generate_nvfp4_fast": Pipeline(
        stages=[("load", 0.08), ("encode", 0.07), ("pass1", 0.25), ("draft", 0.05),
                ("upscale", 0.05), ("pass2", 0.05), ("final", 0.35), ("decode", 0.10)],
        stage_by_node=builder_nvfp4_fast.STAGE_BY_NODE,
        sampler_nodes=builder_nvfp4_fast.SAMPLER_NODES,
        final_node=builder_nvfp4_fast.FINAL_OUTPUT_NODE,
        draft_node=builder_nvfp4_fast.DRAFT_OUTPUT_NODE,
    ),
    "face": Pipeline(
        stages=[("load", 0.05), ("track", 0.15), ("encode", 0.10), ("lipsync", 0.05),
                ("refine", 0.50), ("stitch", 0.10), ("save", 0.05)],
        stage_by_node=builder_face.STAGE_BY_NODE,
        sampler_nodes=builder_face.SAMPLER_NODES,
        final_node=builder_face.FINAL_OUTPUT_NODE,
        draft_node=builder_face.TRACK_PREVIEW_NODE,
        report_node=builder_face.TRACK_REPORT_NODE,
    ),
    "enhance": Pipeline(
        stages=[("load", 0.08), ("resize", 0.05), ("encode", 0.12),
                ("sample", 0.55), ("decode", 0.15), ("save", 0.05)],
        stage_by_node=builder_enhance.STAGE_BY_NODE,
        sampler_nodes=builder_enhance.SAMPLER_NODES,
        final_node=builder_enhance.FINAL_OUTPUT_NODE,
    ),
    "interpolate": Pipeline(
        stages=[("load", 0.10), ("interpolate", 0.80), ("save", 0.10)],
        stage_by_node=builder_interpolate.STAGE_BY_NODE,
        sampler_nodes=builder_interpolate.SAMPLER_NODES,
        final_node=builder_interpolate.FINAL_OUTPUT_NODE,
    ),
}

PIPELINES["generate_memory"] = Pipeline(stages=PIPELINES["generate"].stages,
    stage_by_node=builder_memory.STAGE_BY_NODE, sampler_nodes=builder_memory.SAMPLER_NODES,
    final_node=builder_memory.FINAL_OUTPUT_NODE, draft_node=builder_memory.DRAFT_OUTPUT_NODE)

PIPELINES["generate_pdmd"] = Pipeline(stages=PIPELINES["generate"].stages,
    stage_by_node=builder_pdmd.STAGE_BY_NODE, sampler_nodes=builder_pdmd.SAMPLER_NODES,
    final_node=builder_pdmd.FINAL_OUTPUT_NODE, draft_node=builder_pdmd.DRAFT_OUTPUT_NODE)

for _base in ("generate", "generate_memory", "generate_nvfp4", "generate_nvfp4_fast", "generate_pdmd"):
    _pipe = PIPELINES[_base]
    PIPELINES[_base + "_refmods"] = Pipeline(stages=_pipe.stages,
        stage_by_node={**_pipe.stage_by_node, **builder_refmods.STAGE_BY_NODE},
        sampler_nodes=_pipe.sampler_nodes, final_node=_pipe.final_node, draft_node=_pipe.draft_node)

# Body Swap variants share identical node IDs and stages.
PIPELINES["body_swap_singularity"] = PIPELINES["body_swap"]
