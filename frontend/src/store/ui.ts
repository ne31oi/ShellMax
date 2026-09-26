import { create } from "zustand";

export type Workspace = "generate" | "edit" | "assistant";
export type SettingsTab = "engine" | "styles" | "assistant" | "system";

interface Toast {
  id: number;
  text: string;
  tone: "info" | "ok" | "bad";
  action?: { label: string; run: () => void };
}

/** Face refine dialog: which clip, optionally a past face job to start from ("edit and retry"). */
export interface FaceDialogState {
  assetId: number;
  fromGenerationId?: number;
}

interface UIState {
  workspace: Workspace;
  selectedGen: number | null;
  selectedAsset: number | null;
  compareWith: number | null; // generation id shown on the right side of the A/B wipe
  settings: SettingsTab | null;
  genDrawer: boolean; // generation panel in the Edit workspace
  binFilter: "all" | "video" | "draft" | "imported";
  toasts: Toast[];
  faceDialog: FaceDialogState | null;
  refEditor: string | null; // uid of the reference card being edited

  setWorkspace: (w: Workspace) => void;
  selectGen: (id: number | null) => void;
  selectAsset: (id: number | null) => void;
  compare: (id: number | null) => void;
  openSettings: (tab: SettingsTab | null) => void;
  toggleGenDrawer: () => void;
  setBinFilter: (f: UIState["binFilter"]) => void;
  toast: (text: string, tone?: Toast["tone"], action?: Toast["action"]) => void;
  openFaceDialog: (state: FaceDialogState | null) => void;
  openRefEditor: (uid: string | null) => void;
  dismiss: (id: number) => void;
}

let toastId = 0;

export const useUI = create<UIState>((set) => ({
  workspace: (localStorage.getItem("sm.workspace") as Workspace) || "generate",
  selectedGen: null,
  selectedAsset: null,
  compareWith: null,
  settings: null,
  genDrawer: false,
  binFilter: "all",
  toasts: [],
  faceDialog: null,
  refEditor: null,

  setWorkspace: (workspace) => {
    localStorage.setItem("sm.workspace", workspace);
    set({ workspace, genDrawer: false });
  },
  selectGen: (selectedGen) => set({ selectedGen, selectedAsset: null, compareWith: null }),
  selectAsset: (selectedAsset) => set({ selectedAsset, selectedGen: null, compareWith: null }),
  compare: (compareWith) => set({ compareWith }),
  openSettings: (settings) => set({ settings }),
  toggleGenDrawer: () => set((s) => ({ genDrawer: !s.genDrawer })),
  setBinFilter: (binFilter) => set({ binFilter }),
  toast: (text, tone = "info", action) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, text, tone, action }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), action ? 9000 : 4500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  openFaceDialog: (faceDialog) => set({ faceDialog }),
  openRefEditor: (refEditor) => set({ refEditor }),
}));
