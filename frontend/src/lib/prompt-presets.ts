import type { RefItem, StyleChoice } from "../api/types";

export interface PromptSnapshot {
  prompt: string;
  refs: RefItem[];
  aspect: string;
  duration: number;
  quality: string;
  look: string;
  styles: StyleChoice[];
  cinematicTechniques: Record<string, string>;
}

export type PromptCategory = "scene" | "character" | "dialogue" | "clip" | "other";
export const PROMPT_CATEGORIES: Record<PromptCategory, string> = {
  scene: "Сцена", character: "Персонаж", dialogue: "Диалог", clip: "Клип", other: "Другое",
};
export interface PromptPreset {
  id: string;
  name: string;
  category: PromptCategory;
  favorite: boolean;
  updated: string;
  snapshot: PromptSnapshot;
}

/** Freeze the prompt with its actual reference cards, including derived crops. */
export function capturePrompt(state: PromptSnapshot): PromptSnapshot {
  const { prompt, refs, aspect, duration, quality, look, styles, cinematicTechniques } = state;
  return structuredClone({ prompt, refs, aspect, duration, quality, look, styles, cinematicTechniques });
}

/** A small bounded library lives alongside the panel's existing server-backed state. */
export function normalizePromptLibrary(raw: unknown): PromptPreset[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is PromptPreset => !!p && typeof p.id === "string" && typeof p.name === "string"
    && p.category in PROMPT_CATEGORIES && !!p.snapshot && typeof p.snapshot.prompt === "string"
    && Array.isArray(p.snapshot.refs) && Array.isArray(p.snapshot.styles)
    && Number.isFinite(p.snapshot.duration) && typeof p.snapshot.aspect === "string"
    && typeof p.snapshot.quality === "string" && typeof p.snapshot.look === "string"
    && !!p.snapshot.cinematicTechniques).slice(0, 100).map((p) => ({ ...p, favorite: !!p.favorite, updated: typeof p.updated === "string" ? p.updated : "" }));
}

export function shotMarker(prompt: string, seconds: number): string {
  const next = Math.max(0, ...[...prompt.matchAll(/\[Shot\s+(\d+)\]/gi)].map((m) => Number(m[1]))) + 1;
  if (next === 1) return "[Shot 1] ";
  const ms = Math.max(1, Math.round(seconds * 1000));
  const minutes = String(Math.floor(ms / 60000)).padStart(2, "0");
  const rest = String(Math.floor(ms % 60000 / 1000)).padStart(2, "0");
  return `\n[Shot ${next}] At ${minutes}:${rest}.${String(ms % 1000).padStart(3, "0")}, `;
}
