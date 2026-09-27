import { create } from "zustand";
import { api } from "../api/client";
import type { Generation, RefItem, StyleChoice, Upload } from "../api/types";
import { fromModelPrompt, newUid, toModelPrompt } from "../lib/refs";

/** The generation panel. Every value is sticky: restored from the last session. */
interface FormState {
  hydrated: boolean;
  refs: RefItem[];
  prompt: string; // with {{ref:uid}} tokens
  aspect: string;
  duration: number;
  quality: string;
  look: string;
  camera: string;
  light: string;
  styles: StyleChoice[];
  seedLocked: boolean;
  seed: number | null; // seed used when locked (last generation's seed)
  variants: number;
  profileId: number | null;
  promptHistory: string[];
  /** bumps when the prompt is replaced from outside (retry/template) so the editor reloads */
  promptRevision: number;

  hydrate: (defaults: { aspect: string; duration: number; quality: string; look?: string; camera?: string; light?: string }) => Promise<void>;
  set: (patch: Partial<FormState>) => void;
  setPrompt: (prompt: string, external?: boolean) => void;
  addRefs: (uploads: Upload[]) => { added: RefItem[]; rejected: string[] };
  removeRef: (uid: string) => void;
  moveRef: (from: number, to: number) => void;
  toggleRefAudio: (uid: string) => void;
  /** An edited (or reset) file for the same card: tag, order and 🔊 stay. */
  replaceRefUpload: (uid: string, upload: Upload) => void;
  loadFromGeneration: (g: Generation) => Promise<void>;
  rememberPrompt: () => void;
}

const LIMITS = { image: 9, video: 3, audio: 3 } as const;
const STICKY: (keyof FormState)[] = [
  "refs", "prompt", "aspect", "duration", "quality", "look", "camera", "light", "styles", "seedLocked", "seed", "variants", "profileId", "promptHistory",
];

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export const useForm = create<FormState>((set, get) => ({
  hydrated: false,
  refs: [],
  prompt: "",
  aspect: "16:9 (Widescreen)",
  duration: 2,
  quality: "standard",
  look: "cinema",
  camera: "auto",
  light: "auto",
  styles: [],
  seedLocked: false,
  seed: null,
  variants: 1,
  profileId: null,
  promptHistory: [],
  promptRevision: 0,

  hydrate: async (defaults) => {
    const saved = (await api.uiState().catch(() => ({}))) as Partial<FormState>;
    set({ ...defaults, ...saved, hydrated: true, promptRevision: get().promptRevision + 1 });
  },

  set: (patch) => set(patch),

  setPrompt: (prompt, external = false) =>
    set((s) => ({ prompt, promptRevision: external ? s.promptRevision + 1 : s.promptRevision })),

  addRefs: (uploads) => {
    const refs = [...get().refs];
    const added: RefItem[] = [];
    const rejected: string[] = [];
    for (const upload of uploads) {
      if (refs.filter((r) => r.upload.kind === upload.kind).length >= LIMITS[upload.kind]) {
        rejected.push(upload.orig_name);
        continue;
      }
      const item = { uid: newUid(), upload, withAudio: false };
      refs.push(item);
      added.push(item);
    }
    set({ refs });
    return { added, rejected };
  },

  removeRef: (uid) =>
    set((s) => ({
      refs: s.refs.filter((r) => r.uid !== uid),
      // drop the chip from the prompt as well
      prompt: s.prompt.replaceAll(`{{ref:${uid}}}`, "").replace(/ {2,}/g, " "),
      promptRevision: s.promptRevision + 1,
    })),

  moveRef: (from, to) =>
    set((s) => {
      const refs = [...s.refs];
      const [item] = refs.splice(from, 1);
      refs.splice(to, 0, item);
      // tokens reference uids, so the prompt stays correct; mention chips re-render their labels
      return { refs };
    }),

  toggleRefAudio: (uid) =>
    set((s) => ({ refs: s.refs.map((r) => (r.uid === uid ? { ...r, withAudio: !r.withAudio } : r)) })),

  replaceRefUpload: (uid, upload) =>
    set((s) => ({
      refs: s.refs.map((r) => (r.uid === uid ? { ...r, upload, withAudio: r.withAudio && upload.has_audio } : r)),
    })),

  loadFromGeneration: async (g) => {
    const p = g.ui_params;
    // face / enhance have no generate fields — don't wipe the panel
    if (g.kind === "face" || g.kind === "enhance" || !p.refs) return;
    const uploads = await Promise.all(p.refs.map((r) => api.uploadInfo(r.upload_id).catch(() => null)));
    const refs: RefItem[] = [];
    p.refs.forEach((r, i) => {
      const up = uploads[i];
      if (up) refs.push({ uid: newUid(), upload: up, withAudio: r.with_audio });
    });
    set((s) => ({
      refs,
      prompt: fromModelPrompt(p.prompt ?? "", refs),
      aspect: p.aspect ?? s.aspect,
      duration: p.duration ?? s.duration,
      quality: p.quality ?? s.quality,
      look: p.look ?? get().look,
      light: p.light ?? get().light,
      styles: (p.styles ?? []).map((st) => ({ style_id: st.style_id, strength: st.strength ?? 1 })),
      seed: g.seed,
      promptRevision: s.promptRevision + 1,
    }));
  },

  rememberPrompt: () => {
    const { prompt, refs, promptHistory } = get();
    const text = toModelPrompt(prompt, refs).trim();
    if (!text) return;
    set({ promptHistory: [prompt, ...promptHistory.filter((h) => h !== prompt)].slice(0, 30) });
  },
}));

// persist sticky values (debounced) once hydrated
useForm.subscribe((state) => {
  if (!state.hydrated) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const value = Object.fromEntries(STICKY.map((k) => [k, state[k]]));
    api.saveUiState(value).catch(() => undefined);
  }, 600);
});
