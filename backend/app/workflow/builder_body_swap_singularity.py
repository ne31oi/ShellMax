"""Body Swap A/B variant: only Ref2VA UNET is replaced by Singularity v1.3.

All conditioning and output handling match the selected base recipe. Historical
recipe 1 retains 16 steps and Turbo; full-character recipe 2 uses 40 steps without
Turbo. Neither substitutes the ordinary two-pass generation recipe.
"""
from .body_swap import BodySwapFull
from .builder_body_swap import (
    FINAL_OUTPUT_NODE, SAMPLER_NODES, STAGE_BY_NODE, _template, build_from_template,
)


def build_body_swap_singularity_prompt(p: BodySwapFull) -> dict:
    filename = {1: "ShellMax_BodySwap_Singularity.api.json", 2: "ShellMax_BodySwap_Full_Singularity.api.json",
                3: "ShellMax_BodySwap_Full_Reference_Singularity.api.json", 4: "ShellMax_BodySwap_Complete_Singularity.api.json",
                5: "ShellMax_BodySwap_Background_Singularity.api.json",6: "ShellMax_BodySwap_Fitted_Singularity.api.json"}[p.recipe_version]
    return build_from_template(p, _template(filename))
