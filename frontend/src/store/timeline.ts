import { create } from "zustand";

/**
 * Timeline document + command history. Every mutation is a Command so undo/redo
 * works from day one; the NLE phases add commands (trim, split, tracks) without
 * touching the history mechanics.
 */

export interface Clip {
  id: string;
  assetId: number;
  in: number; // seconds into the source
  out: number;
}

export interface Track {
  id: string;
  kind: "video" | "audio";
  clips: Clip[]; // magnetic: clips play back to back in order
}

export interface TimelineDoc {
  tracks: Track[];
}

export interface Command {
  label: string;
  apply: (doc: TimelineDoc) => TimelineDoc;
  revert: (doc: TimelineDoc) => TimelineDoc;
}

interface TimelineState {
  doc: TimelineDoc;
  past: Command[];
  future: Command[];
  run: (cmd: Command) => void;
  undo: () => Command | undefined;
  redo: () => Command | undefined;
  load: (doc: TimelineDoc | null | undefined) => void;
}

const emptyDoc = (): TimelineDoc => ({ tracks: [{ id: "v1", kind: "video", clips: [] }] });

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persist(doc: TimelineDoc) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch("/api/projects/1/timeline", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    }).catch(() => undefined);
  }, 500);
}

export const useTimeline = create<TimelineState>((set, get) => ({
  doc: emptyDoc(),
  past: [],
  future: [],
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
  load: (doc) => set({ doc: doc?.tracks?.length ? doc : emptyDoc(), past: [], future: [] }),
}));

// ---------------------------------------------------------------- commands
const mapTrack = (doc: TimelineDoc, trackId: string, fn: (clips: Clip[]) => Clip[]): TimelineDoc => ({
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
};

export const clipDuration = (c: Clip) => Math.max(0, c.out - c.in);
