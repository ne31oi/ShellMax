import { create } from "zustand";
import { api } from "../api/client";
import type { ClipProject, ClipListItem } from "../api/clip-types";
import { useUI } from "./ui";

interface ClipState {
  list: ClipListItem[]; active: ClipProject | null;
  load: () => Promise<void>; open: (id: string) => Promise<void>; refresh: () => Promise<void>;
  setActive: (clip: ClipProject) => void; clear: () => void;
}
let requestSerial = 0;
export const useClip = create<ClipState>((set, get) => ({
  list: [], active: null,
  clear: () => { requestSerial++; set({ active: null, list: [] }); },
  setActive: (clip) => set({ active: clip }),
  load: async () => {
    const pid = useUI.getState().projectId;
    const list = await api.clipProjects(pid);
    if (pid !== useUI.getState().projectId) return;
    set({ list });
    if (get().active?.project_id !== pid) {
      set({ active: null });
      if (list[0]) await get().open(list[0].id);
    }
  },
  open: async (id) => {
    const serial = ++requestSerial;
    const clip = await api.clipProject(id);
    if (serial === requestSerial && clip.project_id === useUI.getState().projectId) set({ active: clip });
  },
  refresh: async () => {
    const active = get().active;
    if (!active) return;
    const updated = await api.clipProject(active.id);
    if (get().active?.id === updated.id && updated.project_id === useUI.getState().projectId && updated.revision >= (get().active?.revision ?? 0)) {
      set({ active: updated });
    }
  },
}));
