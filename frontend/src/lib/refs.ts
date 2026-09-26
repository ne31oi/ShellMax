import type { RefItem, RefKind } from "../api/types";

/**
 * The prompt is stored with stable reference tokens `{{ref:<uid>}}`, so reordering
 * reference cards renumbers the model-facing tags (<Picture 2> -> <Picture 1>)
 * without the user touching the text.
 */
export const REF_TOKEN = /\{\{ref:([a-z0-9]+)\}\}/gi;
const MODEL_TAG = /<(Picture|Video|Audio)\s+(\d+)>/g;

export const TAG_NAME: Record<RefKind, string> = { image: "Picture", video: "Video", audio: "Audio" };
export const KIND_LABEL: Record<RefKind, string> = { image: "Картинка", video: "Видео", audio: "Аудио" };
export const KIND_COLOR: Record<RefKind, string> = {
  image: "var(--color-image)",
  video: "var(--color-video)",
  audio: "var(--color-audio)",
};

/** 1-based index of a reference among references of the same kind (that's what the model sees). */
export function tagOf(refs: RefItem[], uid: string): string | null {
  const ref = refs.find((r) => r.uid === uid);
  if (!ref) return null;
  const n = refs.filter((r) => r.upload.kind === ref.upload.kind).findIndex((r) => r.uid === uid) + 1;
  return `${TAG_NAME[ref.upload.kind]} ${n}`;
}

/** Token prompt -> text sent to the model. */
export function toModelPrompt(prompt: string, refs: RefItem[]): string {
  return prompt.replace(REF_TOKEN, (whole, uid) => {
    const tag = tagOf(refs, uid);
    return tag ? `<${tag}>` : whole.replace(/\{\{ref:[a-z0-9]+\}\}/i, "");
  });
}

/** Model text (e.g. from a past generation) -> token prompt, mapping <Picture N> to the Nth image. */
export function fromModelPrompt(text: string, refs: RefItem[]): string {
  return text.replace(MODEL_TAG, (whole, name: string, num: string) => {
    const kind = (Object.keys(TAG_NAME) as RefKind[]).find((k) => TAG_NAME[k] === name)!;
    const ref = refs.filter((r) => r.upload.kind === kind)[Number(num) - 1];
    return ref ? `{{ref:${ref.uid}}}` : whole;
  });
}

export function mentionedUids(prompt: string): Set<string> {
  return new Set([...prompt.matchAll(REF_TOKEN)].map((m) => m[1]));
}

/** Raw <Picture N> tags typed by hand that point at nothing. */
export function danglingTags(prompt: string, refs: RefItem[]): string[] {
  const out: string[] = [];
  for (const m of prompt.matchAll(MODEL_TAG)) {
    const kind = (Object.keys(TAG_NAME) as RefKind[]).find((k) => TAG_NAME[k] === m[1])!;
    if (refs.filter((r) => r.upload.kind === kind).length < Number(m[2])) out.push(m[0]);
  }
  return out;
}

export function newUid(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Short human title for a clip: first meaningful prompt line without tags or the subject_definitions header. */
export function promptTitle(prompt: string): string {
  const lines = prompt.split("\n").map((l) => l.replace(/<[^>]+>/g, "").replace(/\{\{ref:[a-z0-9]+\}\}/gi, "").trim());
  const line = lines.find((l) => l.length > 3 && !/^subject_definitions/i.test(l)) ?? "";
  return line.length > 48 ? line.slice(0, 48) + "…" : line;
}
