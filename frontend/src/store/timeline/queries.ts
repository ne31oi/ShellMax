/** Timeline factories, queries, and snap helpers. */
import { snapToFrame } from "../../lib/planH3";
import type {
  Clip,
  ClipHit,
  Plan,
  TimelineDoc,
  Track,
} from "../../types/timeline";

export const MIN_CLIP = 0.15;
export const MIN_PLAN = 0.2;

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export const emptyDoc = (): TimelineDoc => ({
  tracks: [
    { id: "v1", kind: "video", name: "Видео", clips: [], plans: [], muted: false, solo: false },
    { id: "p1", kind: "plan", name: "Планы 1", clips: [], plans: [], muted: false, solo: false },
    { id: "a1", kind: "audio", name: "Аудио 1", clips: [], plans: [], muted: false, solo: false },
  ],
  masterMute: false,
  masterVolume: 1,
  markers: { beats: [], downbeats: [], bpm: null, offset: 0 },
  snapToBeats: true,
});

export function emptyPlan(partial?: Partial<Plan>): Plan {
  return {
    id: uid(),
    start: 0,
    duration: 2,
    prompt: "",
    refs: [],
    aspect: "16:9 (Widescreen)",
    quality: "standard",
    look: "cinema",
    light: "auto",
    styles: [],
    audio: {},
    lipsync: false,
    mode: "draft",
    status: "empty",
    name: "",
    ...partial,
  };
}

/** Fresh plan from an existing one — new id, no generation artifacts. */
export function clonePlanFresh(plan: Plan, patch?: Partial<Plan>): Plan {
  return emptyPlan({
    ...plan,
    refs: plan.refs.map((r) => ({ ...r })),
    styles: plan.styles.map((s) => ({ ...s })),
    audio: { ...plan.audio },
    status: "empty",
    generationId: null,
    draftAssetId: null,
    outputAssetId: null,
    error: null,
    ...patch,
    // Must win over `...plan` — otherwise paste shares the source id and
    // dragging one makes both blocks (same React key) jump together.
    id: uid(),
  });
}

type PlanClipboard = { plan: Plan; trackId: string };
let planClipboard: PlanClipboard | null = null;

export function copyPlanToClipboard(plan: Plan, trackId: string) {
  planClipboard = {
    trackId,
    plan: {
      ...plan,
      refs: plan.refs.map((r) => ({ ...r })),
      styles: plan.styles.map((s) => ({ ...s })),
      audio: { ...plan.audio },
    },
  };
}

export function peekPlanClipboard(): PlanClipboard | null {
  return planClipboard;
}

export function normalizeLoaded(doc: TimelineDoc | null | undefined): TimelineDoc {
  if (!doc?.tracks?.length) return emptyDoc();
  const tracks = doc.tracks.map((t) => ({
    id: t.id,
    kind: t.kind ?? "video",
    name: t.name ?? t.id,
    muted: !!t.muted,
    solo: !!t.solo,
    clips: (t.clips ?? []).map((c) => ({
      id: c.id,
      assetId: (c as Clip & { asset_id?: number }).assetId ?? (c as Clip & { asset_id?: number }).asset_id ?? 0,
      in: c.in ?? 0,
      out: c.out ?? 0,
      muted: !!c.muted,
      start: typeof c.start === "number" ? c.start : undefined,
    })),
    plans: (t.plans ?? []).map((p) => ({
      ...emptyPlan(),
      ...p,
      refs: p.refs ?? [],
      styles: p.styles ?? [],
      audio: p.audio ?? {},
    })),
  }));
  // Ensure at least one of each kind for editing UX
  const base = emptyDoc();
  for (const kind of ["video", "plan", "audio"] as const) {
    if (!tracks.some((t) => t.kind === kind)) {
      const tpl = base.tracks.find((t) => t.kind === kind)!;
      tracks.push({
        id: tpl.id,
        kind: tpl.kind,
        name: tpl.name ?? tpl.id,
        muted: !!tpl.muted,
        solo: !!tpl.solo,
        clips: [],
        plans: [],
      });
    }
  }
  return {
    masterMute: !!doc.masterMute,
    outputWidth: doc.outputWidth,
    outputHeight: doc.outputHeight,
    outputFps: doc.outputFps,
    masterVolume: typeof doc.masterVolume === "number" ? Math.max(0, Math.min(1, doc.masterVolume)) : 1,
    markers: doc.markers
      ? {
          beats: Array.isArray(doc.markers.beats) ? doc.markers.beats : [],
          downbeats: Array.isArray(doc.markers.downbeats) ? doc.markers.downbeats : [],
          bpm: doc.markers.bpm ?? null,
          offset: doc.markers.offset ?? 0,
          sourceAssetId: doc.markers.sourceAssetId ?? null,
          sourceClipId: doc.markers.sourceClipId ?? null,
          timespace: doc.markers.timespace === "file" || doc.markers.timespace === "timeline" ? doc.markers.timespace : null,
        }
      : { beats: [], downbeats: [], bpm: null, offset: 0 },
    snapToBeats: doc.snapToBeats !== false,
    tracks,
  };
}

// ---------------------------------------------------------------- queries
export const clipDuration = (c: Clip) => Math.max(0, c.out - c.in);

export function videoTrack(doc: TimelineDoc): Track {
  return doc.tracks.find((t) => t.kind === "video") ?? doc.tracks[0] ?? emptyDoc().tracks[0];
}

export function planTracks(doc: TimelineDoc): Track[] {
  return doc.tracks.filter((t) => t.kind === "plan");
}

export function audioTracks(doc: TimelineDoc): Track[] {
  return doc.tracks.filter((t) => t.kind === "audio");
}

export function totalDuration(doc: TimelineDoc): number {
  const video = videoTrack(doc).clips.reduce((s, c) => s + clipDuration(c), 0);
  let maxT = video;
  for (const t of planTracks(doc)) {
    for (const p of t.plans) maxT = Math.max(maxT, p.start + p.duration);
  }
  for (const t of audioTracks(doc)) {
    for (const c of t.clips) {
      const start = c.start ?? 0;
      maxT = Math.max(maxT, start + clipDuration(c));
    }
  }
  return maxT;
}

/** Visible plan covering `time` with a draft/final asset (top track wins). */
export function planVisualAtTime(
  doc: TimelineDoc,
  time: number,
): { plan: Plan; track: Track; local: number; assetId: number } | null {
  const pts = planTracks(doc).filter((t) => !t.muted);
  const solos = pts.filter((t) => t.solo);
  const visible = solos.length ? solos : pts;
  for (const track of visible) {
    for (const plan of track.plans) {
      if (time < plan.start || time >= plan.start + plan.duration) continue;
      const assetId = plan.outputAssetId ?? plan.draftAssetId;
      if (assetId == null) continue;
      return { plan, track, local: time - plan.start, assetId };
    }
  }
  return null;
}

export function audioClipsAtTime(
  doc: TimelineDoc,
  time: number,
): { track: Track; clip: Clip; local: number }[] {
  const out: { track: Track; clip: Clip; local: number }[] = [];
  for (const track of audioTracks(doc)) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      if (clip.muted) continue;
      const start = clip.start ?? 0;
      const dur = clipDuration(clip);
      if (time >= start && time < start + dur) {
        out.push({ track, clip, local: time - start });
      }
    }
  }
  return out;
}

export type SequenceVisual = {
  key: string;
  assetId: number;
  /** Seek time inside the media file. */
  sourceTime: number;
  /** Clip mute for V-track audio; plans keep their generated audio unless master mute. */
  clipMuted: boolean;
};

/** Picture under the playhead: plan result first, else magnetic V clip. */
export function sequenceVisualAtTime(doc: TimelineDoc, time: number): SequenceVisual | null {
  const plan = planVisualAtTime(doc, time);
  if (plan) {
    return {
      key: `p:${plan.plan.id}`,
      assetId: plan.assetId,
      sourceTime: Math.max(0, plan.local),
      clipMuted: false,
    };
  }
  const vDur = videoTrack(doc).clips.reduce((s, c) => s + clipDuration(c), 0);
  if (vDur > 0 && time < vDur) {
    const hit = clipAtTime(doc, time);
    if (hit) {
      return {
        key: `v:${hit.clip.id}`,
        assetId: hit.clip.assetId,
        sourceTime: hit.clip.in + hit.local,
        clipMuted: !!hit.clip.muted,
      };
    }
  }
  return null;
}

export function hasSequenceContent(doc: TimelineDoc): boolean {
  if (videoTrack(doc).clips.length > 0) return true;
  if (audioTracks(doc).some((t) => t.clips.length > 0)) return true;
  return planTracks(doc).some((t) => t.plans.some((p) => p.outputAssetId || p.draftAssetId));
}

export function findClip(doc: TimelineDoc, clipId: string): ClipHit | null {
  let t = 0;
  for (let i = 0; i < videoTrack(doc).clips.length; i++) {
    const clip = videoTrack(doc).clips[i];
    const d = clipDuration(clip);
    if (clip.id === clipId) return { clip, index: i, trackStart: t, local: 0 };
    t += d;
  }
  return null;
}

/** Any track that holds clips (video magnetic or audio absolute). */
export function findClipTrack(doc: TimelineDoc, clipId: string): { track: Track; clip: Clip; index: number } | null {
  for (const track of doc.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  return null;
}

export function findPlan(doc: TimelineDoc, planId: string): { track: Track; plan: Plan } | null {
  for (const track of planTracks(doc)) {
    const plan = track.plans.find((p) => p.id === planId);
    if (plan) return { track, plan };
  }
  return null;
}

export function clipAtTime(doc: TimelineDoc, time: number): ClipHit | null {
  const clips = videoTrack(doc).clips;
  if (!clips.length) return null;
  let t = 0;
  const total = videoTrack(doc).clips.reduce((s, c) => s + clipDuration(c), 0);
  const clamped = Math.max(0, Math.min(time, Math.max(0, total - 0.001)));
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const d = clipDuration(clip);
    if (clamped < t + d || i === clips.length - 1) {
      return { clip, index: i, trackStart: t, local: Math.min(d, Math.max(0, clamped - t)) };
    }
    t += d;
  }
  return null;
}

export function clipSilent(doc: TimelineDoc, clip: Clip): boolean {
  return !!doc.masterMute || !!clip.muted;
}

export function effectiveVolume(doc: TimelineDoc, clip: Clip): number {
  if (clipSilent(doc, clip)) return 0;
  const v = doc.masterVolume ?? 1;
  return Math.max(0, Math.min(1, v));
}

export function nearestBeat(t: number, beats: number[]): number {
  if (!beats.length) return t;
  return beats.reduce((best, b) => (Math.abs(b - t) < Math.abs(best - t) ? b : best), beats[0]);
}

/** Resolve the timeline placement of the clip that owns beat markers. */
export function markerClipPlacement(
  doc: TimelineDoc,
  clipId: string | null | undefined,
): { start: number; in: number; out: number; clip: Clip } | null {
  if (!clipId) return null;
  for (const t of audioTracks(doc)) {
    const clip = t.clips.find((c) => c.id === clipId);
    if (clip) return { start: clip.start ?? 0, in: clip.in, out: clip.out, clip };
  }
  const hit = findClip(doc, clipId);
  if (hit) return { start: hit.trackStart, in: hit.clip.in, out: hit.clip.out, clip: hit.clip };
  return null;
}

/**
 * Timeline-absolute beat times for ruler / snap.
 * When timespace==="file", remap via the source clip's start/in/out so markers
 * follow move/trim without re-analysis.
 * 0:00 is always included as a snap/downbeat so plans can dock to the start.
 */
export function timelineBeats(doc: TimelineDoc): { beats: number[]; downbeats: number[] } {
  const m = doc.markers;
  if (!m?.beats?.length) return { beats: [], downbeats: [] };

  let beats: number[];
  let downbeats: number[];
  if (m.timespace !== "file" || !m.sourceClipId) {
    beats = [...m.beats];
    downbeats = [...(m.downbeats ?? [])];
  } else {
    const place = markerClipPlacement(doc, m.sourceClipId);
    if (!place) return { beats: [], downbeats: [] };
    const map = (fileT: number) => {
      if (fileT < place.in - 1e-3 || fileT > place.out + 1e-3) return null;
      return snapToFrame(place.start + (fileT - place.in));
    };
    beats = m.beats.map(map).filter((t): t is number => t != null);
    downbeats = (m.downbeats ?? []).map(map).filter((t): t is number => t != null);
  }

  const hasZero = (list: number[]) => list.some((b) => Math.abs(b) < 1e-3);
  if (!hasZero(beats)) beats = [0, ...beats];
  if (!hasZero(downbeats)) downbeats = [0, ...downbeats];
  return { beats, downbeats };
}

export function snapEnabled(doc: TimelineDoc): boolean {
  return doc.snapToBeats !== false;
}

/**
 * Snap a time to the nearest beat when snap is on.
 * - force: always (scrub / explicit "to beat")
 * - with scale: magnetic — only if within thresholdPx of a beat (drag)
 * - otherwise: magnetic in seconds (~1/8 s)
 */
export function snapTime(
  doc: TimelineDoc,
  t: number,
  opts?: { scale?: number; thresholdPx?: number; force?: boolean },
): number {
  if (!snapEnabled(doc)) return t;
  const { beats } = timelineBeats(doc);
  if (!beats.length) return t;
  const nearest = nearestBeat(t, beats);
  // Default: always snap when enabled (Resolve "snap on").
  // Pass force:false + scale for soft magnetic pull only.
  if (opts?.force === false && opts.scale && opts.scale > 0) {
    const px = opts.thresholdPx ?? 14;
    if (Math.abs(nearest - t) * opts.scale > px) return t;
  }
  return nearest;
}

/** True if [a0,a1) overlaps [b0,b1). */
export function rangesOverlap(a0: number, a1: number, b0: number, b1: number, eps = 1e-4): boolean {
  return a0 < b1 - eps && b0 < a1 - eps;
}

/**
 * Place a plan of `duration` near `start` on a track without overlapping peers.
 * Returns null if no free slot exists (does not erase others).
 */
export function resolvePlanPlacement(
  peers: Plan[],
  start: number,
  duration: number,
  excludeId?: string,
): number | null {
  const dur = Math.max(MIN_PLAN, snapToFrame(duration));
  const want = snapToFrame(Math.max(0, start));
  const others = peers
    .filter((p) => p.id !== excludeId)
    .map((p) => ({ id: p.id, start: p.start, end: p.start + p.duration }))
    .sort((a, b) => a.start - b.start);

  const fits = (at: number) =>
    others.every((o) => !rangesOverlap(at, at + dur, o.start, o.end));

  if (fits(want)) return want;

  const candidates = new Set<number>([0, want]);
  for (const o of others) {
    candidates.add(snapToFrame(o.end));
    candidates.add(snapToFrame(o.start - dur));
  }
  let best: number | null = null;
  let bestDist = Infinity;
  for (const raw of candidates) {
    const at = Math.max(0, snapToFrame(raw));
    if (!fits(at)) continue;
    const dist = Math.abs(at - want);
    if (dist < bestDist) {
      bestDist = dist;
      best = at;
    }
  }
  return best;
}

/** Clamp resize so the plan doesn't invade neighbours on the same track. */
export function clampPlanResize(
  peers: Plan[],
  planId: string,
  start: number,
  duration: number,
  mode: "in" | "out",
): { start: number; duration: number } | null {
  const dur = Math.max(MIN_PLAN, snapToFrame(duration));
  let s = snapToFrame(Math.max(0, start));
  let d = dur;
  const end = s + d;
  const others = peers
    .filter((p) => p.id !== planId)
    .map((p) => ({ start: p.start, end: p.start + p.duration }))
    .sort((a, b) => a.start - b.start);

  if (mode === "in") {
    const left = [...others].reverse().find((o) => o.end <= end + 1e-4);
    const minStart = left ? left.end : 0;
    s = Math.max(minStart, Math.min(s, end - MIN_PLAN));
    d = end - s;
  } else {
    const right = others.find((o) => o.start >= s - 1e-4);
    const maxEnd = right ? right.start : Infinity;
    d = Math.max(MIN_PLAN, Math.min(d, maxEnd - s));
  }
  d = snapToFrame(d);
  s = snapToFrame(s);
  if (d < MIN_PLAN) return null;
  if (others.some((o) => rangesOverlap(s, s + d, o.start, o.end))) return null;
  return { start: s, duration: d };
}

