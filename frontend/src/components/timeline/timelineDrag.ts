/** Drag preview / commit payloads for plan and audio blocks on the rail. */

export type PlanDragState = {
  planId: string;
  fromTrackId: string;
  toTrackId: string;
  start: number;
  duration: number;
  mode: "move" | "in" | "out";
};

export type AudioDragState = {
  clipId: string;
  fromTrackId: string;
  toTrackId: string;
  start: number;
  in: number;
  out: number;
};
