import type { Generation, MaskEditParams, MediaAsset } from "../../api/types";
import { isSupportedJobKind } from "../../lib/stages";

/** Source lookup and trimming belong to the job, rather than the player UI. */
export function sourceComparison(gen: Generation, assets: Record<number, MediaAsset>) {
  const comparable = !isSupportedJobKind(gen.kind) || ["face", "enhance", "interpolate", "mask_edit", "body_swap", "body_swap_singularity", "fidelity_upscale", "dlss5"].includes(gen.kind);
  if (!gen.source_asset_id || !comparable) return null;
  const asset = assets[gen.source_asset_id];
  if (!asset) return null;
  if (gen.kind !== "mask_edit" && gen.kind !== "body_swap" && gen.kind !== "body_swap_singularity") return { asset, start: 0, duration: undefined };
  const full = gen.full_params;
  const ui = gen.ui_params as unknown as Partial<MaskEditParams>;
  const start = typeof full?.start === "number" ? full.start : ui.start ?? 0;
  const duration = typeof full?.frames === "number" ? full.frames / 24
    : typeof full?.end === "number" ? full.end - start : undefined;
  return { asset, start, duration };
}
