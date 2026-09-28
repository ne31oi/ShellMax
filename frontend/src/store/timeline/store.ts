/** Zustand timeline store and persistence. */
import { create } from "zustand";
import { api } from "../../api/client";
import { loadMontageView, saveMontageView } from "../../lib/montageView";
import type { Command, TimelineDoc } from "../../types/timeline";
import { useUI } from "../ui";
import { emptyDoc, findClip, normalizeLoaded } from "./queries";

interface TimelineState {
  doc: TimelineDoc;
  past: Command[];
  future: Command[];
  playhead: number;
  playing: boolean;
  selectedPlanId: string | null;
  selectedPlanIds: string[];
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
  togglePlanSelected: (id: string) => void;
  selectPlans: (ids: string[]) => void;
  selectClip: (id: string | null) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let playheadTimer: ReturnType<typeof setTimeout> | undefined;
let pendingDoc: TimelineDoc | null = null;

function persist(doc: TimelineDoc) {
  pendingDoc = doc;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const body = pendingDoc;
    pendingDoc = null;
    if (!body) return;
    api.saveTimeline(useUI.getState().projectId, body).catch(() => undefined);
  }, 500);
}

/** Flush debounced timeline save (reload / tab hide). Returns the in-flight save promise. */
export function flushTimelinePersist(): Promise<void> {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  clearTimeout(playheadTimer);
  playheadTimer = undefined;
  const projectId = useUI.getState().projectId;
  const body = pendingDoc ?? useTimeline.getState().doc;
  pendingDoc = null;
  saveMontageView(projectId, { playhead: useTimeline.getState().playhead });
  if (!body?.tracks?.length) return Promise.resolve();
  return api.saveTimeline(projectId, body).then(() => undefined).catch(() => undefined);
}

function persistPlayhead(t: number) {
  clearTimeout(playheadTimer);
  playheadTimer = setTimeout(() => {
    saveMontageView(useUI.getState().projectId, { playhead: t });
  }, 400);
}

export const useTimeline = create<TimelineState>((set, get) => ({
  doc: emptyDoc(),
  past: [],
  future: [],
  playhead: 0,
  playing: false,
  selectedPlanId: null,
  selectedPlanIds: [],
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
  load: (doc) => {
    const prefs = loadMontageView(useUI.getState().projectId);
    set({
      doc: normalizeLoaded(doc),
      past: [],
      future: [],
      playhead: prefs.playhead,
      playing: false,
      selectedPlanId: null,
      selectedPlanIds: [],
      selectedClipId: null,
    });
  },
  setPlayhead: (playhead) => {
    const t = Math.max(0, playhead);
    set({ playhead: t });
    persistPlayhead(t);
  },
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
  selectPlan: (selectedPlanId) =>
    set({
      selectedPlanId,
      selectedClipId: null,
      // selectedPlanIds — только чекбоксы / Shift-диапазон, обычный клик их не трогает
    }),
  togglePlanSelected: (id) =>
    set((s) => {
      const has = s.selectedPlanIds.includes(id);
      const selectedPlanIds = has ? s.selectedPlanIds.filter((x) => x !== id) : [...s.selectedPlanIds, id];
      return {
        selectedPlanIds,
        selectedClipId: null,
      };
    }),
  selectPlans: (ids) => {
    const selectedPlanIds = [...new Set(ids)];
    set({
      selectedPlanIds,
      selectedClipId: null,
    });
  },
  selectClip: (selectedClipId) => set({ selectedClipId, selectedPlanId: null }),
}));

/** Select a plan and open the right sidebar inspector (montage). */
export function openPlanInSidebar(planId: string) {
  useTimeline.getState().selectPlan(planId);
  useUI.getState().setPanelOpen(true);
}

