/** MiniMax H3 frame grid helpers (FPS=24, length ≡ 5 mod 17). */

export const H3_FPS = 24;

export function snapToFrame(t: number, fps = H3_FPS): number {
  if (!Number.isFinite(t) || t <= 0) return 0;
  return Math.round(t * fps) / fps;
}

export function h3FrameCount(duration: number): number {
  const n = Math.max(5, Math.round(duration * H3_FPS));
  return n + ((5 - (n % 17)) % 17);
}

export function h3DurationFromFrames(frames: number): number {
  return frames / H3_FPS;
}

/** Nearest duration whose frame_count lands on the 17k+5 grid. */
export function nearestH3Duration(duration: number): number {
  const target = Math.max(5, Math.round(duration * H3_FPS));
  let bestFrames = 5;
  let bestDiff = Infinity;
  for (let f = 5; f <= Math.max(target + 34, 150 * H3_FPS); f++) {
    if (f % 17 !== 5) continue;
    const diff = Math.abs(f - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestFrames = f;
    }
  }
  return h3DurationFromFrames(bestFrames);
}

export function isH3Aligned(duration: number, eps = 0.04): boolean {
  return Math.abs(nearestH3Duration(duration) - duration) < eps;
}
