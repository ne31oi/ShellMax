import { create } from "zustand";

export type Workspace = "generate" | "edit" | "assistant";
export type SettingsTab = "engine" | "quality" | "styles" | "assistant" | "system";

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

/** SeedVR2 enhance dialog. */
export interface EnhanceDialogState {
  assetId: number;
  fromGenerationId?: number;
}

/** Frame interpolation (RIFE / FILM) dialog. */
export interface InterpolateDialogState {
  assetId: number;
  fromGenerationId?: number;
}

interface UIState {
  workspace: Workspace;
  projectId: number;
  selectedGen: number | null;
  selectedAsset: number | null;
  compareWith: number | null; // generation id shown on the right side of the A/B wipe
  settings: SettingsTab | null;
  binOpen: boolean; // left media library
  panelOpen: boolean; // right generate panel
  binFilter: "all" | "video" | "draft" | "imported";
  toasts: Toast[];
  faceDialog: FaceDialogState | null;
  headSwapDialog: FaceDialogState | null;
  bodySwapDialog: FaceDialogState | null;
  enhanceDialog: EnhanceDialogState | null;
  fidelityUpscaleDialog: EnhanceDialogState | null;
  dlss5Dialog: EnhanceDialogState | null;
  maskEditDialog: EnhanceDialogState | null;
  refmodsOpen: boolean;
  interpolateDialog: InterpolateDialogState | null;
  refEditor: string | null; // uid of the reference card being edited
  viewingSequence: boolean; // montage: Viewer plays the timeline sequence
  /** After face/enhance/interpolate from the timeline, swap this clip's asset when the job finishes. */
  timelineReplace: { clipId: string; expectSourceAssetId: number } | null;

  setWorkspace: (w: Workspace) => void;
  setProjectId: (id: number) => void;
  selectGen: (id: number | null) => void;
  selectAsset: (id: number | null) => void;
  compare: (id: number | null) => void;
  openSettings: (tab: SettingsTab | null) => void;
  toggleBin: () => void;
  togglePanel: () => void;
  setPanelOpen: (open: boolean) => void;
  setBinFilter: (f: UIState["binFilter"]) => void;
  toast: (text: string, tone?: Toast["tone"], action?: Toast["action"]) => void;
  openFaceDialog: (state: FaceDialogState | null) => void;
  openHeadSwapDialog: (state: FaceDialogState | null) => void;
  openBodySwapDialog: (state: FaceDialogState | null) => void;
  openEnhanceDialog: (state: EnhanceDialogState | null) => void;
  openFidelityUpscaleDialog: (state: EnhanceDialogState | null) => void;
  openDLSS5Dialog: (state: EnhanceDialogState | null) => void;
  openMaskEditDialog: (state: EnhanceDialogState | null) => void;
  openRefmods: (open: boolean) => void;
  openInterpolateDialog: (state: InterpolateDialogState | null) => void;
  openRefEditor: (uid: string | null) => void;
  setViewingSequence: (v: boolean) => void;
  setTimelineReplace: (v: UIState["timelineReplace"]) => void;
  dismiss: (id: number) => void;
}

let toastId = 0;

function readBool(key: string, fallback: boolean): boolean {
  const v = localStorage.getItem(key);
  if (v === null) return fallback;
  return v === "1";
}

function readProjectId(): number {
  const n = Number(localStorage.getItem("sm.projectId"));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

export const useUI = create<UIState>((set) => ({
  workspace: (localStorage.getItem("sm.workspace") as Workspace) || "generate",
  projectId: readProjectId(),
  selectedGen: null,
  selectedAsset: null,
  compareWith: null,
  settings: null,
  binOpen: readBool("sm.binOpen", true),
  panelOpen: readBool("sm.panelOpen", true),
  binFilter: "all",
  toasts: [],
  faceDialog: null,
  headSwapDialog: null,
  bodySwapDialog: null,
  enhanceDialog: null,
  fidelityUpscaleDialog: null,
  dlss5Dialog: null,
  maskEditDialog: null,
  refmodsOpen: false,
  interpolateDialog: null,
  refEditor: null,
  viewingSequence: false,
  timelineReplace: null,

  setWorkspace: (workspace) => {
    localStorage.setItem("sm.workspace", workspace);
    // Montage starts with the generate panel tucked away; generation keeps last panel preference.
    if (workspace === "edit") {
      localStorage.setItem("sm.panelOpen", "0");
      set({ workspace, panelOpen: false, viewingSequence: true });
    } else {
      set({ workspace, viewingSequence: false });
    }
  },
  setProjectId: (projectId) => {
    localStorage.setItem("sm.projectId", String(projectId));
    set({
      projectId,
      selectedGen: null,
      selectedAsset: null,
      compareWith: null,
      viewingSequence: false,
      timelineReplace: null,
    });
  },
  selectGen: (selectedGen) => set({ selectedGen, selectedAsset: null, compareWith: null, viewingSequence: false }),
  selectAsset: (selectedAsset) => set({ selectedAsset, selectedGen: null, compareWith: null, viewingSequence: false }),
  compare: (compareWith) => set({ compareWith }),
  openSettings: (settings) => set({ settings }),
  toggleBin: () =>
    set((s) => {
      const binOpen = !s.binOpen;
      localStorage.setItem("sm.binOpen", binOpen ? "1" : "0");
      return { binOpen };
    }),
  togglePanel: () =>
    set((s) => {
      const panelOpen = !s.panelOpen;
      localStorage.setItem("sm.panelOpen", panelOpen ? "1" : "0");
      return { panelOpen };
    }),
  setPanelOpen: (panelOpen) => {
    localStorage.setItem("sm.panelOpen", panelOpen ? "1" : "0");
    set({ panelOpen });
  },
  setBinFilter: (binFilter) => set({ binFilter }),
  toast: (text, tone = "info", action) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, text, tone, action }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === "bad" ? 12000 : action ? 9000 : 4500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  openFaceDialog: (faceDialog) => set({ faceDialog }),
  openHeadSwapDialog: (headSwapDialog) => set({ headSwapDialog }),
  openBodySwapDialog: (bodySwapDialog) => set({ bodySwapDialog }),
  openEnhanceDialog: (enhanceDialog) => set({ enhanceDialog }),
  openFidelityUpscaleDialog: (fidelityUpscaleDialog) => set({ fidelityUpscaleDialog }),
  openDLSS5Dialog: (dlss5Dialog) => set({ dlss5Dialog }),
  openMaskEditDialog: (maskEditDialog) => set({ maskEditDialog }),
  openRefmods: (refmodsOpen) => set({ refmodsOpen }),
  openInterpolateDialog: (interpolateDialog) => set({ interpolateDialog }),
  openRefEditor: (refEditor) => set({ refEditor }),
  setViewingSequence: (viewingSequence) =>
    set(viewingSequence ? { viewingSequence, selectedGen: null, selectedAsset: null, compareWith: null } : { viewingSequence }),
  setTimelineReplace: (timelineReplace) => set({ timelineReplace }),
}));
