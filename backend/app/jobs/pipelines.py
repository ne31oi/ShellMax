"""Per job kind: stages (with their share of total time), node -> stage map and output nodes.

Stage lists are mirrored in frontend/src/lib/stages.ts - change both together.
"""

from dataclasses import dataclass, field

from ..workflow import builder, builder_face


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
    "generate": Pipeline(
        stages=[("load", 0.08), ("encode", 0.07), ("pass1", 0.25), ("draft", 0.05),
                ("upscale", 0.05), ("pass2", 0.05), ("final", 0.35), ("decode", 0.10)],
        stage_by_node=builder.STAGE_BY_NODE,
        sampler_nodes=builder.SAMPLER_NODES,
        final_node=builder.FINAL_OUTPUT_NODE,
        draft_node=builder.DRAFT_OUTPUT_NODE,
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
}
