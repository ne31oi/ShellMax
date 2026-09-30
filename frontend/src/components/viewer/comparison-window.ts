/** A comparison's time starts at zero, even when the source starts mid-clip. */
export function comparisonWindow(aDuration: number, bDuration: number, aStart = 0, bStart = 0, limit?: number) {
  const startA = Math.max(0, aStart);
  const startB = Math.max(0, bStart);
  const available = Math.min(aDuration - startA, bDuration - startB, limit ?? Infinity);
  return { startA, startB, duration: Number.isFinite(available) ? Math.max(0, available) : 0 };
}

export function comparisonTimes(time: number, window: ReturnType<typeof comparisonWindow>) {
  // The duration itself is past the last video frame; keep scrubbing on a decodable frame.
  const relative = Math.max(0, Math.min(time, Math.max(0, window.duration - 0.001)));
  return { relative, a: window.startA + relative, b: window.startB + relative };
}
