import { create } from "zustand";
import { api } from "../api/client";
import { snapToFrame } from "../lib/planH3";
import { useUI } from "./ui";

/**
 * Timeline document + command history.
 * Video clips stay magnetic; audio clips use absolute `start`;
 * plan tracks hold absolute Plan blocks (may overlap across tracks).
 */

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
  beats: number[];
  downbeats: number[];
  sourceAssetId?: number | null;
  bpm?: number | null;
  offset?: number;
}

export interface TimelineDoc {
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

const MIN_CLIP = 0.15;
const MIN_PLAN = 0.2;

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

interface TimelineState {
  doc: TimelineDoc;
  past: Command[];
  future: Command[];
  playhead: number;
  playing: boolean;
  selectedPlanId: string | null;
  selectedClipId: string | null;
  run: (cmd: Command) => void;
  undo: () => Command | undefined;
  redo: () => Command | undefined;
  load: (doc: TimelineDoc | null | undefined) => void;
  setPlayhead: (t: number) => void;
  setPlaying: (p: boolean) => void;
  seekToClip: (clipId: string) => void;
  patchDoc: (partial: Partial<TimelineDoc>) => void;
  selectPlan: (id: string | null) => void;
  selectClip: (id: string | null) => void;
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

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persist(doc: TimelineDoc) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api.saveTimeline(useUI.getState().projectId, doc).catch(() => undefined);
  }, 500);
}

export const useTimeline = create<TimelineState>((set, get) => ({
  doc: emptyDoc(),
  past: [],
  future: [],
  playhead: 0,
  playing: false,
  selectedPlanId: null,
  selectedClipId: null,
  run: (cmd) => {
    const doc = cmd.apply(get().doc);
    set((s) => ({ doc, past: [...s.past, cmd].slice(-200), future: [] }));
    persist(doc);
  },
  undo: () => {
    const cmd = get().past.at(-1);
    if (!cmd) return;
    const doc = cmd.revert(get().doc);
    set((s) => ({ doc, past: s.past.slice(0, -1), future: [cmd, ...s.future] }));
    persist(doc);
    return cmd;
  },
  redo: () => {
    const cmd = get().future[0];
    if (!cmd) return;
    const doc = cmd.apply(get().doc);
    set((s) => ({ doc, past: [...s.past, cmd], future: s.future.slice(1) }));
    persist(doc);
    return cmd;
  },
  load: (doc) =>
    set({
      doc: normalizeLoaded(doc),
      past: [],
      future: [],
      playhead: 0,
      playing: false,
      selectedPlanId: null,
      selectedClipId: null,
    }),
  setPlayhead: (playhead) => set({ playhead: Math.max(0, playhead) }),
  setPlaying: (playing) => set({ playing }),
  seekToClip: (clipId) => {
    const hit = findClip(get().doc, clipId);
    if (hit) set({ playhead: hit.trackStart, playing: false });
  },
  patchDoc: (partial) => {
    const doc = { ...get().doc, ...partial };
    set({ doc });
    persist(doc);
  },
  selectPlan: (selectedPlanId) => set({ selectedPlanId, selectedClipId: null }),
  selectClip: (selectedClipId) => set({ selectedClipId, selectedPlanId: null }),
}));

/** Select a plan and open the right sidebar inspector (montage). */
export function openPlanInSidebar(planId: string) {
  useTimeline.getState().selectPlan(planId);
  useUI.getState().setPanelOpen(true);
}

function normalizeLoaded(doc: TimelineDoc | null | undefined): TimelineDoc {
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
    masterVolume: typeof doc.masterVolume === "number" ? Math.max(0, Math.min(1, doc.masterVolume)) : 1,
    markers: doc.markers ?? { beats: [], downbeats: [], bpm: null, offset: 0 },
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

export function snapTime(doc: TimelineDoc, t: number): number {
  if (!doc.snapToBeats) return t;
  const beats = doc.markers?.beats ?? [];
  return nearestBeat(t, beats);
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

// ---------------------------------------------------------------- commands helpers
const mapTrack = (doc: TimelineDoc, trackId: string, fn: (t: Track) => Track): TimelineDoc => ({
  ...doc,
  tracks: doc.tracks.map((t) => (t.id === trackId ? fn(t) : t)),
});

const mapClips = (doc: TimelineDoc, trackId: string, fn: (clips: Clip[]) => Clip[]): TimelineDoc =>
  mapTrack(doc, trackId, (t) => ({ ...t, clips: fn(t.clips) }));

const mapPlans = (doc: TimelineDoc, trackId: string, fn: (plans: Plan[]) => Plan[]): TimelineDoc =>
  mapTrack(doc, trackId, (t) => ({ ...t, plans: fn(t.plans) }));

export const commands = {
  addClip(clip: Clip, trackId = "v1", index?: number): Command {
    return {
      label: "Добавить клип",
      apply: (d) =>
        mapClips(d, trackId, (c) => {
          const next = [...c];
          next.splice(index ?? next.length, 0, clip);
          return next;
        }),
      revert: (d) => mapClips(d, trackId, (c) => c.filter((x) => x.id !== clip.id)),
    };
  },
  removeClip(doc: TimelineDoc, clipId: string, trackId = "v1"): Command {
    const track = doc.tracks.find((t) => t.id === trackId)!;
    const index = track.clips.findIndex((c) => c.id === clipId);
    const clip = track.clips[index];
    return {
      label: "Удалить клип",
      apply: (d) => mapClips(d, trackId, (c) => c.filter((x) => x.id !== clipId)),
      revert: (d) =>
        mapClips(d, trackId, (c) => {
          const next = [...c];
          next.splice(index, 0, clip);
          return next;
        }),
    };
  },
  moveClip(from: number, to: number, trackId = "v1"): Command {
    const move = (c: Clip[], a: number, b: number) => {
      const next = [...c];
      const [x] = next.splice(a, 1);
      next.splice(b, 0, x);
      return next;
    };
    return {
      label: "Переместить клип",
      apply: (d) => mapClips(d, trackId, (c) => move(c, from, to)),
      revert: (d) => mapClips(d, trackId, (c) => move(c, to, from)),
    };
  },
  trimClip(doc: TimelineDoc, clipId: string, nextIn: number, nextOut: number, trackId = "v1"): Command {
    const track = doc.tracks.find((t) => t.id === trackId)!;
    const prev = track.clips.find((c) => c.id === clipId)!;
    const inn = Math.max(0, Math.min(nextIn, nextOut - MIN_CLIP));
    const out = Math.max(inn + MIN_CLIP, nextOut);
    const next: Clip = { ...prev, in: inn, out };
    return {
      label: "Обрезать клип",
      apply: (d) => mapClips(d, trackId, (clips) => clips.map((c) => (c.id === clipId ? next : c))),
      revert: (d) => mapClips(d, trackId, (clips) => clips.map((c) => (c.id === clipId ? prev : c))),
    };
  },
  splitClip(doc: TimelineDoc, clipId: string, atSequenceTime: number, trackId = "v1"): Command | null {
    const hit = findClip(doc, clipId);
    if (!hit) return null;
    const local = atSequenceTime - hit.trackStart;
    if (local < MIN_CLIP || local > clipDuration(hit.clip) - MIN_CLIP) return null;
    const cutSource = hit.clip.in + local;
    const left: Clip = { ...hit.clip, out: cutSource };
    const right: Clip = {
      id: uid(),
      assetId: hit.clip.assetId,
      in: cutSource,
      out: hit.clip.out,
      muted: hit.clip.muted,
    };
    return {
      label: "Разрезать клип",
      apply: (d) =>
        mapClips(d, trackId, (clips) => {
          const next = [...clips];
          const i = next.findIndex((c) => c.id === clipId);
          if (i < 0) return clips;
          next.splice(i, 1, left, right);
          return next;
        }),
      revert: (d) =>
        mapClips(d, trackId, (clips) => {
          const i = clips.findIndex((c) => c.id === left.id);
          if (i < 0) return clips;
          const next = [...clips];
          next.splice(i, 2, hit.clip);
          return next;
        }),
    };
  },
  setClipMuted(doc: TimelineDoc, clipId: string, muted: boolean, trackId = "v1"): Command {
    const prev = doc.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId);
    const was = !!prev?.muted;
    return {
      label: muted ? "Выключить звук клипа" : "Включить звук клипа",
      apply: (d) => mapClips(d, trackId, (clips) => clips.map((c) => (c.id === clipId ? { ...c, muted } : c))),
      revert: (d) => mapClips(d, trackId, (clips) => clips.map((c) => (c.id === clipId ? { ...c, muted: was } : c))),
    };
  },
  setMasterMute(doc: TimelineDoc, muted: boolean): Command {
    const was = !!doc.masterMute;
    return {
      label: muted ? "Выключить звук последовательности" : "Включить звук последовательности",
      apply: (d) => ({ ...d, masterMute: muted }),
      revert: (d) => ({ ...d, masterMute: was }),
    };
  },
  setMasterVolume(doc: TimelineDoc, volume: number): Command {
    const was = doc.masterVolume ?? 1;
    const next = Math.max(0, Math.min(1, volume));
    return {
      label: "Громкость последовательности",
      apply: (d) => ({ ...d, masterVolume: next }),
      revert: (d) => ({ ...d, masterVolume: was }),
    };
  },
  replaceClipAsset(doc: TimelineDoc, clipId: string, assetId: number, trackId = "v1"): Command {
    const prev = doc.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId);
    const was = prev?.assetId ?? assetId;
    return {
      label: "Заменить клип на таймлайне",
      apply: (d) => mapClips(d, trackId, (clips) => clips.map((c) => (c.id === clipId ? { ...c, assetId } : c))),
      revert: (d) => mapClips(d, trackId, (clips) => clips.map((c) => (c.id === clipId ? { ...c, assetId: was } : c))),
    };
  },

  // ---- plans
  addPlan(plan: Plan, trackId: string): Command {
    return {
      label: "Добавить план",
      apply: (d) => mapPlans(d, trackId, (ps) => [...ps, plan]),
      revert: (d) => mapPlans(d, trackId, (ps) => ps.filter((p) => p.id !== plan.id)),
    };
  },
  removePlan(doc: TimelineDoc, planId: string, trackId: string): Command {
    const prev = doc.tracks.find((t) => t.id === trackId)?.plans.find((p) => p.id === planId);
    return {
      label: "Удалить план",
      apply: (d) => mapPlans(d, trackId, (ps) => ps.filter((p) => p.id !== planId)),
      revert: (d) =>
        mapPlans(d, trackId, (ps) => (prev ? [...ps, prev] : ps)),
    };
  },
  updatePlan(doc: TimelineDoc, planId: string, trackId: string, patch: Partial<Plan>): Command {
    const prev = doc.tracks.find((t) => t.id === trackId)?.plans.find((p) => p.id === planId);
    return {
      label: "Изменить план",
      apply: (d) =>
        mapPlans(d, trackId, (ps) => ps.map((p) => (p.id === planId ? { ...p, ...patch } : p))),
      revert: (d) =>
        mapPlans(d, trackId, (ps) => ps.map((p) => (p.id === planId && prev ? prev : p))),
    };
  },
  movePlan(doc: TimelineDoc, planId: string, trackId: string, start: number, duration?: number): Command {
    const prev = doc.tracks.find((t) => t.id === trackId)?.plans.find((p) => p.id === planId);
    const nextStart = Math.max(0, start);
    const nextDur = Math.max(MIN_PLAN, duration ?? prev?.duration ?? 2);
    return {
      label: "Сдвинуть план",
      apply: (d) =>
        mapPlans(d, trackId, (ps) =>
          ps.map((p) => (p.id === planId ? { ...p, start: nextStart, duration: nextDur } : p)),
        ),
      revert: (d) =>
        mapPlans(d, trackId, (ps) => ps.map((p) => (p.id === planId && prev ? prev : p))),
    };
  },
  /** Move a plan in time and/or to another plan track (no overlap on the destination). */
  relocatePlan(
    doc: TimelineDoc,
    planId: string,
    fromTrackId: string,
    toTrackId: string,
    start: number,
    duration?: number,
  ): Command | null {
    const from = doc.tracks.find((t) => t.id === fromTrackId);
    const to = doc.tracks.find((t) => t.id === toTrackId);
    if (!from || !to || from.kind !== "plan" || to.kind !== "plan") return null;
    const prev = from.plans.find((p) => p.id === planId);
    if (!prev) return null;
    const dur = Math.max(MIN_PLAN, snapToFrame(duration ?? prev.duration));
    const peers = toTrackId === fromTrackId ? from.plans : to.plans;
    const placed = resolvePlanPlacement(peers, start, dur, planId);
    if (placed == null) return null;
    const next: Plan = { ...prev, start: placed, duration: dur };
    if (toTrackId === fromTrackId) {
      return {
        label: "Сдвинуть план",
        apply: (d) => mapPlans(d, fromTrackId, (ps) => ps.map((p) => (p.id === planId ? next : p))),
        revert: (d) => mapPlans(d, fromTrackId, (ps) => ps.map((p) => (p.id === planId ? prev : p))),
      };
    }
    return {
      label: "Перенести план на дорожку",
      apply: (d) => {
        let out = mapPlans(d, fromTrackId, (ps) => ps.filter((p) => p.id !== planId));
        out = mapPlans(out, toTrackId, (ps) => [...ps, next]);
        return out;
      },
      revert: (d) => {
        let out = mapPlans(d, toTrackId, (ps) => ps.filter((p) => p.id !== planId));
        out = mapPlans(out, fromTrackId, (ps) => [...ps, prev]);
        return out;
      },
    };
  },
  addPlanTrack(doc: TimelineDoc): Command {
    const n = planTracks(doc).length + 1;
    const track: Track = {
      id: `p${n}_${uid()}`,
      kind: "plan",
      name: `Планы ${n}`,
      clips: [],
      plans: [],
      muted: false,
      solo: false,
    };
    return {
      label: "Добавить дорожку планов",
      apply: (d) => ({ ...d, tracks: [...d.tracks, track] }),
      revert: (d) => ({ ...d, tracks: d.tracks.filter((t) => t.id !== track.id) }),
    };
  },
  addAudioTrack(doc: TimelineDoc): Command {
    const n = audioTracks(doc).length + 1;
    const track: Track = {
      id: `a${n}_${uid()}`,
      kind: "audio",
      name: `Аудио ${n}`,
      clips: [],
      plans: [],
      muted: false,
      solo: false,
    };
    return {
      label: "Добавить аудиодорожку",
      apply: (d) => ({ ...d, tracks: [...d.tracks, track] }),
      revert: (d) => ({ ...d, tracks: d.tracks.filter((t) => t.id !== track.id) }),
    };
  },
  removeTrack(doc: TimelineDoc, trackId: string): Command | null {
    const track = doc.tracks.find((t) => t.id === trackId);
    if (!track || track.kind === "video") return null;
    const same = doc.tracks.filter((t) => t.kind === track.kind);
    if (same.length <= 1) return null; // keep at least one plan / audio lane
    const index = doc.tracks.findIndex((t) => t.id === trackId);
    return {
      label: "Удалить дорожку",
      apply: (d) => ({ ...d, tracks: d.tracks.filter((t) => t.id !== trackId) }),
      revert: (d) => {
        const next = [...d.tracks];
        next.splice(Math.min(index, next.length), 0, track);
        return { ...d, tracks: next };
      },
    };
  },
  addAudioClip(clip: Clip, trackId: string): Command {
    return {
      label: "Добавить аудио",
      apply: (d) => mapClips(d, trackId, (c) => [...c, clip]),
      revert: (d) => mapClips(d, trackId, (c) => c.filter((x) => x.id !== clip.id)),
    };
  },
  /** Move / trim an absolute audio clip (optionally to another A-track). */
  relocateAudioClip(
    doc: TimelineDoc,
    clipId: string,
    fromTrackId: string,
    toTrackId: string,
    patch: { start: number; in: number; out: number },
  ): Command | null {
    const from = doc.tracks.find((t) => t.id === fromTrackId);
    const prev = from?.clips.find((c) => c.id === clipId);
    if (!prev || from?.kind !== "audio") return null;
    const to = doc.tracks.find((t) => t.id === toTrackId);
    if (!to || to.kind !== "audio") return null;
    const inn = Math.max(0, Math.min(patch.in, patch.out - MIN_CLIP));
    const out = Math.max(inn + MIN_CLIP, patch.out);
    const start = snapToFrame(Math.max(0, patch.start));
    const next: Clip = { ...prev, start, in: inn, out };
    const same = fromTrackId === toTrackId;
    return {
      label: same ? "Сдвинуть аудио" : "Перенести аудио",
      apply: (d) => {
        if (same) {
          return mapClips(d, fromTrackId, (clips) => clips.map((c) => (c.id === clipId ? next : c)));
        }
        let d2 = mapClips(d, fromTrackId, (clips) => clips.filter((c) => c.id !== clipId));
        d2 = mapClips(d2, toTrackId, (clips) => [...clips, next]);
        return d2;
      },
      revert: (d) => {
        if (same) {
          return mapClips(d, fromTrackId, (clips) => clips.map((c) => (c.id === clipId ? prev : c)));
        }
        let d2 = mapClips(d, toTrackId, (clips) => clips.filter((c) => c.id !== clipId));
        d2 = mapClips(d2, fromTrackId, (clips) => [...clips, prev]);
        return d2;
      },
    };
  },
  splitAudioClip(doc: TimelineDoc, clipId: string, trackId: string, atMasterTime: number): Command | null {
    const track = doc.tracks.find((t) => t.id === trackId);
    const clip = track?.clips.find((c) => c.id === clipId);
    if (!clip || track?.kind !== "audio") return null;
    const start = clip.start ?? 0;
    const local = atMasterTime - start;
    if (local < MIN_CLIP || local > clipDuration(clip) - MIN_CLIP) return null;
    const cutSource = clip.in + local;
    const left: Clip = { ...clip, out: cutSource };
    const right: Clip = {
      id: uid(),
      assetId: clip.assetId,
      in: cutSource,
      out: clip.out,
      start: snapToFrame(atMasterTime),
      muted: clip.muted,
    };
    return {
      label: "Разрезать аудио",
      apply: (d) =>
        mapClips(d, trackId, (clips) => {
          const next = [...clips];
          const i = next.findIndex((c) => c.id === clipId);
          if (i < 0) return clips;
          next.splice(i, 1, left, right);
          return next;
        }),
      revert: (d) =>
        mapClips(d, trackId, (clips) => {
          const i = clips.findIndex((c) => c.id === left.id);
          if (i < 0) return clips;
          const next = [...clips];
          next.splice(i, 2, clip);
          return next;
        }),
    };
  },
  setMarkers(doc: TimelineDoc, markers: TimelineMarkers): Command {
    const was = doc.markers;
    return {
      label: "Маркеры битов",
      apply: (d) => ({ ...d, markers }),
      revert: (d) => ({ ...d, markers: was }),
    };
  },
  setSnapToBeats(doc: TimelineDoc, on: boolean): Command {
    const was = doc.snapToBeats !== false;
    return {
      label: on ? "Привязка к битам" : "Свободное время",
      apply: (d) => ({ ...d, snapToBeats: on }),
      revert: (d) => ({ ...d, snapToBeats: was }),
    };
  },
  duplicatePlanToTrack(doc: TimelineDoc, planId: string, fromTrackId: string, toTrackId: string): Command {
    const prev = doc.tracks.find((t) => t.id === fromTrackId)?.plans.find((p) => p.id === planId);
    const copy: Plan = { ...emptyPlan(), ...prev, id: uid(), status: "empty", generationId: null, draftAssetId: null, outputAssetId: null, error: null };
    return {
      label: "Дублировать план на дорожку",
      apply: (d) => mapPlans(d, toTrackId, (ps) => [...ps, copy]),
      revert: (d) => mapPlans(d, toTrackId, (ps) => ps.filter((p) => p.id !== copy.id)),
    };
  },
  setTrackMuted(doc: TimelineDoc, trackId: string, muted: boolean): Command {
    const was = !!doc.tracks.find((t) => t.id === trackId)?.muted;
    return {
      label: muted ? "Выключить дорожку" : "Включить дорожку",
      apply: (d) => mapTrack(d, trackId, (t) => ({ ...t, muted })),
      revert: (d) => mapTrack(d, trackId, (t) => ({ ...t, muted: was })),
    };
  },
  /** Flatten visible plan results onto the video track (top plan-track wins overlaps). */
  compilePlansToVideo(doc: TimelineDoc): Command {
    const vId = videoTrack(doc).id;
    const prevClips = [...videoTrack(doc).clips];
    const pts = planTracks(doc).filter((t) => !t.muted);
    const solos = pts.filter((t) => t.solo);
    const visible = solos.length ? solos : pts;
    // Gather intervals; higher track (earlier in list) wins
    type Seg = { start: number; end: number; assetId: number };
    const segs: Seg[] = [];
    for (const t of visible) {
      for (const p of [...t.plans].sort((a, b) => a.start - b.start)) {
        const assetId = p.outputAssetId ?? p.draftAssetId;
        if (!assetId) continue;
        const start = p.start;
        const end = p.start + p.duration;
        // Subtract overlaps already claimed by higher tracks
        let pieces: [number, number][] = [[start, end]];
        for (const s of segs) {
          const next: [number, number][] = [];
          for (const [a, b] of pieces) {
            if (b <= s.start || a >= s.end) {
              next.push([a, b]);
              continue;
            }
            if (a < s.start) next.push([a, s.start]);
            if (b > s.end) next.push([s.end, b]);
          }
          pieces = next;
        }
        for (const [a, b] of pieces) {
          if (b - a >= MIN_CLIP) segs.push({ start: a, end: b, assetId });
        }
      }
    }
    segs.sort((a, b) => a.start - b.start);
    const clips: Clip[] = segs.map((s) => ({
      id: uid(),
      assetId: s.assetId,
      in: 0,
      out: s.end - s.start,
      muted: false,
    }));
    return {
      label: "Собрать планы на видео",
      apply: (d) => mapClips(d, vId, () => clips),
      revert: (d) => mapClips(d, vId, () => prevClips),
    };
  },
};
