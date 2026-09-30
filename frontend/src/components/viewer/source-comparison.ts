import type { Generation, MaskEditParams, MediaAsset } from "../../api/types";

/** Source lookup and trimming belong to the job, rather than the player UI. */
export function sourceComparison(gen: Generation, assets: Record<number, MediaAsset>) {
  if (!gen.source_asset_id || !["face", "enhance", "interpolate", "mask_edit", "sol_refine", "fidelity_upscale"].includes(gen.kind)) return null;
  const asset = assets[gen.source_asset_id];
  if (!asset) return null;
  if (gen.kind !== "mask_edit") return { asset, start: 0, duration: undefined };
  const full = gen.full_params;
  const ui = gen.ui_params as unknown as Partial<MaskEditParams>;
  const start = typeof full?.start === "number" ? full.start : ui.start ?? 0;
  const duration = typeof full?.frames === "number" ? full.frames / 24
    : typeof full?.end === "number" ? full.end - start : undefined;
  return { asset, start, duration };
}
