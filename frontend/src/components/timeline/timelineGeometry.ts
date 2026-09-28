/** Timeline rail geometry helpers. */

import type { PointerEvent as ReactPointerEvent } from "react";
import { snapToFrame } from "../../lib/planH3";
import { snapTime, useTimeline } from "../../store/timeline";
import { LABEL_W } from "./timelineConstants";

export type ScrubLayout = { scale: number; total: number; snapBeats: boolean };

export function buildTimeMarks(total: number, scale: number, minPx = 56): number[] {
  const minSec = minPx / Math.max(scale, 0.001);
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find((s) => s >= minSec) ?? 600;
  const out: number[] = [];
  for (let t = 0; t <= total + 1e-6; t += step) out.push(Math.round(t * 1000) / 1000);
  return out;
}

/** Convert client X on the rail to timeline time (frame + optional beat snap). */
export function timeAtClientX(
  rail: HTMLElement | null,
  clientX: number,
  layout: ScrubLayout,
  opts?: { altKey?: boolean },
): number {
  if (!rail) return 0;
  const { scale, total, snapBeats } = layout;
  const r = rail.getBoundingClientRect();
  const x = clientX - r.left + rail.scrollLeft - LABEL_W;
  let t = Math.max(0, Math.min(total, x / Math.max(scale, 0.001)));
  t = snapToFrame(t);
  if (snapBeats && !opts?.altKey) t = snapTime(useTimeline.getState().doc, t, { force: true });
  return t;
}

/** Drag playhead from empty rail / ruler / handle. */
export function beginPlayheadScrub(opts: {
  event: ReactPointerEvent;
  rail: HTMLElement | null;
  scrubLayout: () => ScrubLayout;
  setPlayhead: (t: number) => void;
  onStart?: () => void;
}): void {
  const { event, rail, scrubLayout, setPlayhead, onStart } = opts;
  // Don't steal plan/clip drags — only empty rail / ruler / playhead handle.
  event.preventDefault();
  event.stopPropagation();
  onStart?.();
  setPlayhead(timeAtClientX(rail, event.clientX, scrubLayout(), { altKey: event.altKey }));
  const move = (ev: PointerEvent) => {
    setPlayhead(timeAtClientX(rail, ev.clientX, scrubLayout(), { altKey: ev.altKey }));
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
