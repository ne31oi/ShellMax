/** Shared timeline document types (API DTOs + NLE store). Keep free of store imports. */

export interface Clip {
  id: string;
  assetId: number;
  in: number;
  out: number;
  muted?: boolean;
  /** Absolute start on master clock (audio tracks). */
  start?: number;
}

export interface PlanRef {
  kind: "image" | "video" | "audio";
  uploadId: string;
  withAudio?: boolean;
}

export interface PlanStyle {
  styleId: number;
  strength?: number | null;
}

export type PlanStatus = "empty" | "queued" | "running" | "draft" | "done" | "error";

export interface Plan {
  id: string;
  start: number;
  duration: number;
  renderDuration?: number | null;
  sourceIn?: number;
  prompt: string;
  refs: PlanRef[];
  aspect: string;
  quality: string;
  look: string;
  light: string;
  styles: PlanStyle[];
  audio: Record<string, boolean>;
  lipsync: boolean;
  mode: "draft" | "final";
  status: PlanStatus;
  generationId?: number | null;
  draftAssetId?: number | null;
  outputAssetId?: number | null;
  error?: string | null;
  reviewNotes?: string[];
  name?: string;
}

export interface Track {
  id: string;
  kind: "video" | "audio" | "plan";
  name?: string;
  muted?: boolean;
  solo?: boolean;
  clips: Clip[];
  plans: Plan[];
}

export interface TimelineMarkers {
  /** Beat times: file-absolute when timespace==="file", else timeline-absolute (legacy). */
  beats: number[];
  downbeats: number[];
  sourceAssetId?: number | null;
  /** Clip these beats belong to — display remaps via clip.start/in/out. */
  sourceClipId?: string | null;
  timespace?: "file" | "timeline" | null;
  bpm?: number | null;
  offset?: number;
}

export interface TimelineDoc {
  outputWidth?: number | null;
  outputHeight?: number | null;
  outputFps?: number | null;
  tracks: Track[];
  masterMute?: boolean;
  masterVolume?: number;
  markers?: TimelineMarkers;
  snapToBeats?: boolean;
}

export interface Command {
  label: string;
  apply: (doc: TimelineDoc) => TimelineDoc;
  revert: (doc: TimelineDoc) => TimelineDoc;
}

export interface ClipHit {
  clip: Clip;
  index: number;
  trackStart: number;
  local: number;
}
