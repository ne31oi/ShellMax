/** Cached waveform peaks for media assets (A-track display). */
import { api } from "../api/client";

type PeaksPayload = { peaks: number[]; duration: number | null };

const cache = new Map<number, PeaksPayload>();
const inflight = new Map<number, Promise<PeaksPayload>>();

export function getCachedAssetPeaks(assetId: number): PeaksPayload | undefined {
  return cache.get(assetId);
}

export function loadAssetPeaks(assetId: number): Promise<PeaksPayload> {
  const hit = cache.get(assetId);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(assetId);
  if (pending) return pending;
  const p = api
    .assetPeaks(assetId)
    .then((r) => {
      const out = { peaks: r.peaks ?? [], duration: r.duration };
      cache.set(assetId, out);
      inflight.delete(assetId);
      return out;
    })
    .catch((e) => {
      inflight.delete(assetId);
      throw e;
    });
  inflight.set(assetId, p);
  return p;
}

/** Slice full-file peaks to the clip's in/out window. */
export function slicePeaks(peaks: number[], fileDuration: number, inn: number, out: number): number[] {
  if (!peaks.length) return [];
  if (!fileDuration || fileDuration <= 0) return peaks;
  const a = Math.max(0, Math.floor((inn / fileDuration) * peaks.length));
  const b = Math.min(peaks.length, Math.ceil((out / fileDuration) * peaks.length));
  return peaks.slice(a, Math.max(a + 1, b));
}

/** Downsample for the visible pixel width (one bar ~2px). */
export function downsamplePeaks(peaks: number[], maxBars: number): number[] {
  if (peaks.length <= maxBars || maxBars < 2) return peaks;
  const out: number[] = [];
  const step = peaks.length / maxBars;
  for (let i = 0; i < maxBars; i++) {
    const a = Math.floor(i * step);
    const b = Math.floor((i + 1) * step);
    let m = 0;
    for (let j = a; j < b; j++) m = Math.max(m, peaks[j] ?? 0);
    out.push(m);
  }
  return out;
}
