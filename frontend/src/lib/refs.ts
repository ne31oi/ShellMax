import type { RefItem, RefKind } from "../api/types";

/**
 * The prompt is stored with stable reference tokens `{{ref:<uid>}}`, so reordering
 * reference cards renumbers the model-facing tags (<Picture 2> -> <Picture 1>)
 * without the user touching the text.
 */
export const REF_TOKEN = /\{\{ref:([a-z0-9]+)(:audio)?\}\}/gi;
const MODEL_TAG = /<(Picture|Video|Audio)\s+(\d+)>/g;

export const TAG_NAME: Record<RefKind, string> = { image: "Picture", video: "Video", audio: "Audio" };
export const KIND_LABEL: Record<RefKind, string> = { image: "Картинка", video: "Видео", audio: "Аудио" };
export const KIND_COLOR: Record<RefKind, string> = {
  image: "var(--color-image)",
  video: "var(--color-video)",
  audio: "var(--color-audio)",
};

/** 1-based index of a reference among references of the same kind (that's what the model sees). */
export function tagOf(refs: RefItem[], uid: string, channel?: "audio"): string | null {
  const ref = refs.find((r) => r.uid === uid);
  if (!ref) return null;
  const ordered = [...refs.filter((r) => !r.upload.refmod_file), ...refs.filter((r) => r.upload.refmod_file)];
  const paired = ordered.filter((r) => r.upload.kind === "video" && r.withAudio && !r.upload.refmod_file);
  if (channel === "audio") {
    const index = paired.findIndex((r) => r.uid === uid);
    return index < 0 ? null : `Audio ${index + 1}`;
  }
  const n = ordered.filter((r) => r.upload.kind === ref.upload.kind).findIndex((r) => r.uid === uid) + 1;
  return `${TAG_NAME[ref.upload.kind]} ${n + (ref.upload.kind === "audio" ? paired.length : 0)}`;
}

/** Native H3 labels video soundtracks before standalone audio references. */
export function referenceTargets(refs: RefItem[]) {
  return refs.flatMap((ref) => [
    { uid: ref.uid, tag: tagOf(refs, ref.uid)!, kind: ref.upload.kind, channel: undefined as "audio" | undefined, ref },
    ...(ref.upload.kind === "video" && ref.withAudio
      ? [{ uid: ref.uid, tag: tagOf(refs, ref.uid, "audio")!, kind: "audio" as const, channel: "audio" as const, ref }]
      : []),
  ]);
}

/** Token prompt -> text sent to the model. */
export function toModelPrompt(prompt: string, refs: RefItem[]): string {
  return prompt.replace(REF_TOKEN, (_whole, uid, audio) => {
    const tag = tagOf(refs, uid, audio ? "audio" : undefined);
    return tag ? `<${tag}>` : "";
  });
}

/** Model text (e.g. from a past generation) -> token prompt, mapping <Picture N> to the Nth image. */
export function fromModelPrompt(text: string, refs: RefItem[]): string {
  return text.replace(MODEL_TAG, (whole, name: string, num: string) => {
    const target = referenceTargets(refs).find((r) => r.tag === `${name} ${Number(num)}`);
    return target ? `{{ref:${target.uid}${target.channel ? ":audio" : ""}}}` : whole;
  });
}

export function mentionedUids(prompt: string): Set<string> {
  return new Set([...prompt.matchAll(REF_TOKEN)].map((m) => m[1]));
}

/** Rename links in one pass, so swapping two references cannot collapse them. */
export function replacePromptReferences(prompt: string, refs: RefItem[], from: string, to: string, swap = false): { prompt: string; count: number } {
  if (from === to) return { prompt, count: 0 };
  const source = refs.find((r) => r.uid === from), target = refs.find((r) => r.uid === to);
  if (!source || !target || source.upload.kind !== target.upload.kind) return { prompt, count: 0 };
  const stored = fromModelPrompt(prompt, refs);
  if ([...stored.matchAll(REF_TOKEN)].some((m) => m[2] &&
    ((m[1] === from && !target.withAudio) || (swap && m[1] === to && !source.withAudio)))) return { prompt, count: 0 };
  let count = 0;
  const replaced = stored.replace(REF_TOKEN, (whole, uid: string, audio: string | undefined) => {
    const dest = uid === from ? target : swap && uid === to ? source : null;
    if (!dest || (audio && !dest.withAudio)) return whole;
    count++;
    return `{{ref:${dest.uid}${audio ?? ""}}}`;
  });
  return { prompt: replaced, count };
}

/** Raw <Picture N> tags typed by hand that point at nothing. */
export function danglingTags(prompt: string, refs: RefItem[]): string[] {
  const out: string[] = [];
  for (const m of prompt.matchAll(MODEL_TAG)) {
    if (!referenceTargets(refs).some((r) => r.tag === `${m[1]} ${Number(m[2])}`)) out.push(m[0]);
  }
  return out;
}

export function newUid(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Short human title for a clip: first meaningful prompt line without tags or the subject_definitions header. */
export function promptTitle(prompt: string | null | undefined): string {
  if (!prompt) return "";
  let raw = prompt.split("\n");
  const head = raw.findIndex((l) => l.trim().toLowerCase() === "summary:");
  if (head >= 0) raw = raw.slice(head + 1); // structured prompt: the summary describes the shot
  const lines = raw.map((l) =>
    l.replace(/\[[^\]]*\]|<[^>]+>|\{\{ref:[a-z0-9]+(?::audio)?\}\}/gi, "").replace(/\s+/g, " ").trim().replace(/^[\s:.,-]+|[\s:.,-]+$/g, ""),
  );
  let line = lines.find((l) => l.length > 3 && !/^subject_definitions/i.test(l)) ?? "";
  if (head >= 0) line = line.replace(/^(a|an|the)\s+/i, "").replace(/^./, (c) => c.toUpperCase());
  return line.length > 48 ? line.slice(0, 48) + "…" : line;
}
