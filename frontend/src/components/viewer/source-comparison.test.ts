import { describe, expect, it } from "vitest";
import type { Generation, MediaAsset } from "../../api/types";
import { sourceComparison } from "./source-comparison";

const source = { id: 7 } as MediaAsset;
const assets = { 7: source };
const job = (kind: string, full_params: Generation["full_params"] = null) =>
  ({ kind, source_asset_id: 7, full_params, ui_params: {} }) as Generation;

describe("source comparison for saved jobs", () => {
  it("keeps the original available when the processing workflow has been removed", () => {
    expect(sourceComparison(job("retired_workflow"), assets)).toEqual({ asset: source, start: 0, duration: undefined });
  });

  it("preserves the original timing of a mask edit", () => {
    expect(sourceComparison(job("mask_edit", { start: 4, frames: 48 }), assets)).toEqual({ asset: source, start: 4, duration: 2 });
  });

  it("aligns body swap to the actual fragment instead of the beginning of the source", () => {
    expect(sourceComparison(job("body_swap", { start: 3, frames: 39, end: 4.625 }), assets))
      .toEqual({ asset: source, start: 3, duration: 39 / 24 });
  });

  it("does not compare non-video artifacts or missing sources", () => {
    expect(sourceComparison(job("mask_track"), assets)).toBeNull();
    expect(sourceComparison(job("refmod_create"), assets)).toBeNull();
    expect(sourceComparison(job("retired_workflow"), {})).toBeNull();
  });
});
