"""Sample directly at the final canvas when the initial pass has zero steps."""

from .graph_util import reachable_nodes
from .params import FullParams, base_resolution, upscaled_resolution


def final_canvas_graph(graph: dict, p: FullParams, *, latent: list | None = None,
                       conditioning: list | None = None) -> dict:
    # Zero-step output at sigma=1 cannot be decoded as a clean draft or upscaled
    # as x0. Start from fresh full-resolution AV noise with the selected final model.
    width, height = upscaled_resolution(*base_resolution(p.aspect, p.megapixels), p.upscale)
    graph["56"]["inputs"].update(width=width, height=height)
    graph["126"]["inputs"]["conditioning"] = conditioning or ["56", 0]
    graph["106"]["inputs"].update(noise=["63", 0], sigmas=["94", 0],
                                 latent_image=latent or ["56", 1])
    return reachable_nodes(graph, ("141",))
