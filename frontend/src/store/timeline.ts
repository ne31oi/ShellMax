import { create } from "zustand";
import { api } from "../api/client";
import { useUI } from "./ui";

/**
 * Timeline document + command history. Every mutation is a Command so undo/redo
 * works from day one; trim/split/export build on the same mechanics.
 */

export interface Clip {
  id: string;
  assetId: number;
  in: number; // seconds into the source
  out: number;
  /** Per-clip mute (audio lane). */
  muted?: boolean;
}

export interface Track {
  id: string;
  kind: "video" | "audio";
  clips: Clip[]; // magnetic: clips play back to back in order
}

export interface TimelineDoc {
  tracks: Track[];
  masterMute?: boolean;
  /** 0…1 sequence volume (preview + export). */
  masterVolume?: number;
}

export interface Command {
  label: string;
  apply: (doc: TimelineDoc) => TimelineDoc;
  revert: (doc: TimelineDoc) => TimelineDoc;
}

export interface ClipHit {
  clip: Clip;
  index: number;
  trackStart: number; // sequence time where this clip begins
  local: number; // seconds into the clip's trimmed range (0 … duration)
}

const MIN_CLIP = 0.15;

interface TimelineState {
  doc: TimelineDoc;
  past: Command[];
  future: Command[];
  playhead: number;
  playing: boolean;
  run: (cmd: Command) => void;
  undo: () => Command | undefined;
  redo: () => Command | undefined;
  load: (doc: TimelineDoc | null | undefined) => void;
  setPlayhead: (t: number) => void;
  setPlaying: (p: boolean) => void;
  seekToClip: (clipId: string) => void;
  /** Soft update (no undo) — for continuous controls like volume. */
  patchDoc: (partial: Partial<TimelineDoc>) => void;
}

export const emptyDoc = (): TimelineDoc => ({
  tracks: [{ id: "v1", kind: "video", clips: [] }],
  masterMute: false,
  masterVolume: 1,
});

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
  load: (doc) => set({ doc: normalizeLoaded(doc), past: [], future: [], playhead: 0, playing: false }),
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
}));

function normalizeLoaded(doc: TimelineDoc | null | undefined): TimelineDoc {
  if (!doc?.tracks?.length) return emptyDoc();
  return {
    masterMute: !!doc.masterMute,
    masterVolume: typeof doc.masterVolume === "number" ? Math.max(0, Math.min(1, doc.masterVolume)) : 1,
    tracks: doc.tracks.map((t) => ({
      ...t,
      clips: (t.clips ?? []).map((c) => ({
        id: c.id,
        assetId: (c as Clip & { asset_id?: number }).assetId ?? (c as Clip & { asset_id?: number }).asset_id ?? 0,
        in: c.in ?? 0,
        out: c.out ?? 0,
        muted: !!c.muted,
      })),
    })),
  };
}

// ---------------------------------------------------------------- queries
export const clipDuration = (c: Clip) => Math.max(0, c.out - c.in);

export function videoTrack(doc: TimelineDoc): Track {
  return doc.tracks.find((t) => t.kind === "video") ?? doc.tracks[0] ?? emptyDoc().tracks[0];
}

export function totalDuration(doc: TimelineDoc): number {
  return videoTrack(doc).clips.reduce((s, c) => s + clipDuration(c), 0);
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

export function clipAtTime(doc: TimelineDoc, time: number): ClipHit | null {
  const clips = videoTrack(doc).clips;
  if (!clips.length) return null;
  let t = 0;
  const total = totalDuration(doc);
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

// ---------------------------------------------------------------- commands
const mapTrack = (doc: TimelineDoc, trackId: string, fn: (clips: Clip[]) => Clip[]): TimelineDoc => ({
  ...doc,
  tracks: doc.tracks.map((t) => (t.id === trackId ? { ...t, clips: fn(t.clips) } : t)),
});

export const commands = {
  addClip(clip: Clip, trackId = "v1", index?: number): Command {
    return {
      label: "Добавить клип",
      apply: (d) =>
        mapTrack(d, trackId, (c) => {
          const next = [...c];
          next.splice(index ?? next.length, 0, clip);
          return next;
        }),
      revert: (d) => mapTrack(d, trackId, (c) => c.filter((x) => x.id !== clip.id)),
    };
  },
  removeClip(doc: TimelineDoc, clipId: string, trackId = "v1"): Command {
    const track = doc.tracks.find((t) => t.id === trackId)!;
    const index = track.clips.findIndex((c) => c.id === clipId);
    const clip = track.clips[index];
    return {
      label: "Удалить клип",
      apply: (d) => mapTrack(d, trackId, (c) => c.filter((x) => x.id !== clipId)),
      revert: (d) =>
        mapTrack(d, trackId, (c) => {
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
      apply: (d) => mapTrack(d, trackId, (c) => move(c, from, to)),
      revert: (d) => mapTrack(d, trackId, (c) => move(c, to, from)),
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
      apply: (d) => mapTrack(d, trackId, (clips) => clips.map((c) => (c.id === clipId ? next : c))),
      revert: (d) => mapTrack(d, trackId, (clips) => clips.map((c) => (c.id === clipId ? prev : c))),
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
      id: Math.random().toString(36).slice(2, 10),
      assetId: hit.clip.assetId,
      in: cutSource,
      out: hit.clip.out,
      muted: hit.clip.muted,
    };
    return {
      label: "Разрезать клип",
      apply: (d) =>
        mapTrack(d, trackId, (clips) => {
          const next = [...clips];
          const i = next.findIndex((c) => c.id === clipId);
          if (i < 0) return clips;
          next.splice(i, 1, left, right);
          return next;
        }),
      revert: (d) =>
        mapTrack(d, trackId, (clips) => {
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
      apply: (d) =>
        mapTrack(d, trackId, (clips) => clips.map((c) => (c.id === clipId ? { ...c, muted } : c))),
      revert: (d) =>
        mapTrack(d, trackId, (clips) => clips.map((c) => (c.id === clipId ? { ...c, muted: was } : c))),
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
      apply: (d) =>
        mapTrack(d, trackId, (clips) => clips.map((c) => (c.id === clipId ? { ...c, assetId } : c))),
      revert: (d) =>
        mapTrack(d, trackId, (clips) => clips.map((c) => (c.id === clipId ? { ...c, assetId: was } : c))),
    };
  },
};
