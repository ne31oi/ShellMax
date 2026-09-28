import { create } from "zustand";
import { api } from "../api/client";
import type { Generation, RefItem, StyleChoice, Upload } from "../api/types";
import { fromModelPrompt, newUid, toModelPrompt } from "../lib/refs";
import { sortedGenerations, useLibrary } from "./library";

export type RecentRefKind = "image" | "video" | "audio";
export type RecentRefs = Record<RecentRefKind, Upload[]>;

const RECENT_LIMIT = 10;
export const emptyRecentRefs = (): RecentRefs => ({ image: [], video: [], audio: [] });

/** Same original, any edit, or a re-upload with the same filename. */
function sameRecentFamily(a: Upload, b: Upload): boolean {
  if (a.id === b.id) return true;
  const aRoot = a.source_id || a.id;
  const bRoot = b.source_id || b.id;
  if (aRoot === bRoot) return true;
  return !!a.orig_name && a.orig_name === b.orig_name;
}

function dedupeRecentList(list: Upload[]): Upload[] {
  const out: Upload[] = [];
  for (const u of list) {
    if (out.some((x) => sameRecentFamily(x, u))) continue;
    out.push(u);
  }
  return out;
}

function pushRecent(prev: RecentRefs, uploads: Upload[]): RecentRefs {
  const next: RecentRefs = {
    image: [...prev.image],
    video: [...prev.video],
    audio: [...prev.audio],
  };
  for (const upload of uploads) {
    const kind = upload.kind as RecentRefKind;
    if (kind !== "image" && kind !== "video" && kind !== "audio") continue;
    next[kind] = [upload, ...next[kind].filter((u) => !sameRecentFamily(u, upload))].slice(0, RECENT_LIMIT);
  }
  return next;
}

function normalizeRecent(raw: unknown): RecentRefs {
  const base = emptyRecentRefs();
  if (!raw || typeof raw !== "object") return base;
  const o = raw as Partial<RecentRefs>;
  for (const kind of ["image", "video", "audio"] as const) {
    const list = o[kind];
    if (Array.isArray(list)) {
      base[kind] = dedupeRecentList(
        list
          .filter((u) => u && typeof u === "object" && typeof (u as Upload).id === "string")
          .slice(0, RECENT_LIMIT * 3) as Upload[],
      ).slice(0, RECENT_LIMIT);
    }
  }
  return base;
}

function KINDS_EMPTY(r: RecentRefs): boolean {
  return r.image.length === 0 && r.video.length === 0 && r.audio.length === 0;
}

export function dedupeRecentRefs(r: RecentRefs): RecentRefs {
  return {
    image: dedupeRecentList(r.image).slice(0, RECENT_LIMIT),
    video: dedupeRecentList(r.video).slice(0, RECENT_LIMIT),
    audio: dedupeRecentList(r.audio).slice(0, RECENT_LIMIT),
  };
}

export function recentFamilyInUse(refs: RefItem[], upload: Upload): boolean {
  return refs.some((r) => sameRecentFamily(r.upload, upload));
}

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
  /** One selected technique per production-bible category. */
  cinematicTechniques: Record<string, string>;
  /** Former single-choice value, read only to migrate older saved UI state. */
  cinematicTechnique: string;
  styles: StyleChoice[];
  seedLocked: boolean;
  seed: number | null; // seed used when locked (last generation's seed)
  variants: number;
  profileId: number | null;
  promptHistory: string[];
  /** Last used uploads per kind (MRU, sticky). */
  recentRefs: RecentRefs;
  /** bumps when the prompt is replaced from outside (retry/history) so the editor reloads */
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
  rememberRecent: (uploads: Upload[]) => void;
  /** Fill empty MRU slots from past generate jobs (once per session if sticky list is empty). */
  seedRecentFromHistory: () => Promise<void>;
  loadFromGeneration: (g: Generation) => Promise<void>;
  rememberPrompt: () => void;
}

const LIMITS = { image: 9, video: 3, audio: 3 } as const;
const STICKY: (keyof FormState)[] = [
  "refs", "prompt", "aspect", "duration", "quality", "look", "cinematicTechniques", "styles",
  "seedLocked", "seed", "variants", "profileId", "promptHistory", "recentRefs",
];

export function selectedCinematicTechniqueIds(state: Pick<FormState, "cinematicTechniques" | "cinematicTechnique">): string[] {
  const selected = Object.values(state.cinematicTechniques).filter((id) => id && id !== "auto");
  return selected.length ? selected : state.cinematicTechnique !== "auto" ? [state.cinematicTechnique] : [];
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Write sticky form fields now (call on unload / profile switch — debounce alone loses the last pick). */
export function flushFormPersist() {
  clearTimeout(saveTimer);
  const state = useForm.getState();
  if (!state.hydrated) return;
  const value = Object.fromEntries(STICKY.map((k) => [k, state[k]]));
  return api.saveUiState(value).catch(() => undefined);
}

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
    cinematicTechniques: {},
    cinematicTechnique: "auto",
  styles: [],
  seedLocked: false,
  seed: null,
  variants: 1,
  profileId: null,
  promptHistory: [],
  recentRefs: emptyRecentRefs(),
  promptRevision: 0,

  hydrate: async (defaults) => {
    const saved = (await api.uiState().catch(() => ({}))) as Partial<FormState>;
    let recentRefs = normalizeRecent(saved.recentRefs);
    // Bootstrap MRU from sticky refs so existing sessions get a starting list
    const stickyRefs = Array.isArray(saved.refs) ? (saved.refs as RefItem[]) : [];
    if (stickyRefs.length && KINDS_EMPTY(recentRefs)) {
      recentRefs = pushRecent(
        recentRefs,
        stickyRefs.map((r) => r.upload).filter((u) => u && typeof u.id === "string"),
      );
    }
    set({
      ...defaults,
      ...saved,
      camera: "auto",
      light: "auto",
      cinematicTechniques: saved.cinematicTechniques && typeof saved.cinematicTechniques === "object"
        ? saved.cinematicTechniques : {},
      recentRefs,
      hydrated: true,
      promptRevision: get().promptRevision + 1,
    });
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
    set({ refs, recentRefs: pushRecent(get().recentRefs, added.map((a) => a.upload)) });
    return { added, rejected };
  },

  removeRef: (uid) =>
    set((s) => ({
      refs: s.refs.filter((r) => r.uid !== uid),
      prompt: s.prompt.replaceAll(`{{ref:${uid}}}`, "").replace(/ {2,}/g, " "),
      promptRevision: s.promptRevision + 1,
    })),

  moveRef: (from, to) =>
    set((s) => {
      const refs = [...s.refs];
      const [item] = refs.splice(from, 1);
      refs.splice(to, 0, item);
      return { refs };
    }),

  toggleRefAudio: (uid) =>
    set((s) => ({ refs: s.refs.map((r) => (r.uid === uid ? { ...r, withAudio: !r.withAudio } : r)) })),

  replaceRefUpload: (uid, upload) =>
    set((s) => ({
      refs: s.refs.map((r) => (r.uid === uid ? { ...r, upload, withAudio: r.withAudio && upload.has_audio } : r)),
      recentRefs: pushRecent(s.recentRefs, [upload]),
    })),

  rememberRecent: (uploads) => {
    if (!uploads.length) return;
    set((s) => ({ recentRefs: pushRecent(s.recentRefs, uploads) }));
  },

  seedRecentFromHistory: async () => {
    const { recentRefs } = get();
    const need = (["image", "video", "audio"] as const).filter((k) => recentRefs[k].length === 0);
    if (!need.length) return;

    const gens = sortedGenerations(useLibrary.getState().generations).filter(
      (g) => (g.kind === "generate" || g.kind === "generate_nvfp4" || g.kind === "generate_nvfp4_fast") && Array.isArray(g.ui_params?.refs) && g.ui_params.refs.length,
    );

    const want = new Set(need);
    const idsByKind: Record<RecentRefKind, string[]> = { image: [], video: [], audio: [] };
    const seen = new Set<string>();
    for (const g of gens) {
      for (const r of g.ui_params.refs) {
        const kind = r.kind as RecentRefKind;
        if (!want.has(kind) || seen.has(r.upload_id)) continue;
        if (idsByKind[kind].length >= RECENT_LIMIT) continue;
        seen.add(r.upload_id);
        idsByKind[kind].push(r.upload_id);
      }
      if (need.every((k) => idsByKind[k].length >= RECENT_LIMIT)) break;
    }

    // Oldest-first so pushRecent leaves newest at the front
    const ids = need.flatMap((k) => [...idsByKind[k]].reverse());
    if (!ids.length) return;
    const uploads = (await Promise.all(ids.map((id) => api.uploadInfo(id).catch(() => null)))).filter(
      (u): u is Upload => !!u,
    );
    if (uploads.length) set((s) => ({ recentRefs: pushRecent(s.recentRefs, uploads) }));
  },

  loadFromGeneration: async (g) => {
    const p = g.ui_params;
    if (g.kind === "face" || g.kind === "enhance" || g.kind === "interpolate" || !p.refs) return;
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
      light: "auto",
      styles: (p.styles ?? []).map((st) => ({ style_id: st.style_id, strength: st.strength ?? 1 })),
      seed: g.seed,
      recentRefs: pushRecent(s.recentRefs, refs.map((r) => r.upload)),
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
    void flushFormPersist();
  }, 600);
});
