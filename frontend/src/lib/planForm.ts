/** Bridge selected timeline plan ↔ generation form store. */
import { api } from "../api/client";
import type { RefItem, StyleChoice, Upload } from "../api/types";
import { fromModelPrompt, newUid, toModelPrompt } from "./refs";
import { useForm } from "../store/form";
import {
  commands,
  findPlan,
  useTimeline,
  type Plan,
  type PlanRef,
  type PlanStyle,
} from "../store/timeline";

export type FormSnapshot = {
  refs: RefItem[];
  prompt: string;
  aspect: string;
  duration: number;
  quality: string;
  look: string;
  camera: string;
  light: string;
  styles: StyleChoice[];
  promptRevision: number;
};

let backup: FormSnapshot | null = null;
let syncing = false; // suppress form→plan while loading plan→form
let activePlanId: string | null = null;

export function isPlanFormActive(): boolean {
  return activePlanId != null;
}

export function getActivePlanId(): string | null {
  return activePlanId;
}

function snapshotForm(): FormSnapshot {
  const f = useForm.getState();
  return {
    refs: f.refs,
    prompt: f.prompt,
    aspect: f.aspect,
    duration: f.duration,
    quality: f.quality,
    look: f.look,
    camera: f.camera,
    light: f.light,
    styles: f.styles.map((s) => ({ style_id: s.style_id, strength: s.strength ?? 1 })),
    promptRevision: f.promptRevision,
  };
}

function applySnapshot(s: FormSnapshot) {
  useForm.setState({
    refs: s.refs,
    prompt: s.prompt,
    aspect: s.aspect,
    duration: s.duration,
    quality: s.quality,
    look: s.look,
    camera: s.camera,
    light: s.light,
    styles: s.styles.map((st) => ({ style_id: st.style_id, strength: st.strength ?? 1 })),
    promptRevision: s.promptRevision + 1,
  });
}

async function refsFromPlan(plan: Plan): Promise<RefItem[]> {
  const uploads = await Promise.all(
    plan.refs.map((r) => api.uploadInfo(r.uploadId).catch(() => null as Upload | null)),
  );
  const refs: RefItem[] = [];
  plan.refs.forEach((r, i) => {
    const up = uploads[i];
    if (up) refs.push({ uid: newUid(), upload: up, withAudio: !!r.withAudio });
  });
  return refs;
}

export async function bindPlanToForm(planId: string): Promise<void> {
  const hit = findPlan(useTimeline.getState().doc, planId);
  if (!hit) return;
  if (activePlanId !== planId) {
    if (activePlanId == null) backup = snapshotForm();
    activePlanId = planId;
  }
  syncing = true;
  try {
    const refs = await refsFromPlan(hit.plan);
    const prompt = hit.plan.prompt.includes("<Picture") || hit.plan.prompt.includes("<Video") || hit.plan.prompt.includes("<Audio")
      ? fromModelPrompt(hit.plan.prompt, refs)
      : hit.plan.prompt;
    useForm.setState({
      refs,
      prompt,
      aspect: hit.plan.aspect,
      duration: hit.plan.duration,
      quality: hit.plan.quality,
      look: hit.plan.look,
      light: hit.plan.light,
      camera: "auto",
      styles: hit.plan.styles.map((s) => ({ style_id: s.styleId, strength: s.strength ?? 1 })),
      promptRevision: useForm.getState().promptRevision + 1,
    });
  } finally {
    syncing = false;
  }
}

export function unbindPlanForm(): void {
  activePlanId = null;
  if (backup) {
    syncing = true;
    applySnapshot(backup);
    syncing = false;
    backup = null;
  }
}

export function planFromForm(): {
  prompt: string;
  refs: PlanRef[];
  aspect: string;
  duration: number;
  quality: string;
  look: string;
  light: string;
  styles: PlanStyle[];
} {
  const f = useForm.getState();
  return {
    prompt: toModelPrompt(f.prompt, f.refs),
    refs: f.refs.map((r) => ({
      kind: r.upload.kind,
      uploadId: r.upload.id,
      withAudio: r.withAudio,
    })),
    aspect: f.aspect,
    duration: f.duration,
    quality: f.quality,
    look: f.look,
    light: f.light,
    styles: f.styles.map((s) => ({ styleId: s.style_id, strength: s.strength ?? null })),
  };
}

/** Write current form into the bound plan (and relocate if duration changed). */
export function flushFormToPlan(): void {
  if (syncing || !activePlanId) return;
  const hit = findPlan(useTimeline.getState().doc, activePlanId);
  if (!hit) return;
  if (hit.plan.status === "queued" || hit.plan.status === "running") return;
  const next = planFromForm();
  const { track, plan } = hit;
  const patch: Partial<Plan> = {
    prompt: next.prompt,
    refs: next.refs,
    aspect: next.aspect,
    quality: next.quality,
    look: next.look,
    light: next.light,
    styles: next.styles,
  };
  const tl = useTimeline.getState();
  if (Math.abs(next.duration - plan.duration) > 1e-4) {
    const cmd = commands.relocatePlan(tl.doc, plan.id, track.id, track.id, plan.start, next.duration);
    if (cmd) {
      tl.run(cmd);
      // relocate keeps other fields; apply prompt/refs after
      const after = findPlan(useTimeline.getState().doc, plan.id);
      if (after) {
        useTimeline.getState().run(commands.updatePlan(useTimeline.getState().doc, plan.id, after.track.id, patch));
      }
      return;
    }
  }
  tl.run(commands.updatePlan(tl.doc, plan.id, track.id, { ...patch, duration: plan.duration }));
}

export function setFormFieldFromPlan(patch: Partial<FormSnapshot>): void {
  syncing = true;
  const bump = patch.prompt != null || patch.refs != null;
  useForm.setState({
    ...patch,
    ...(bump ? { promptRevision: useForm.getState().promptRevision + 1 } : {}),
  } as Partial<FormSnapshot> & { promptRevision?: number });
  syncing = false;
}
let unsub: (() => void) | null = null;
export function ensurePlanFormSync(): void {
  if (unsub) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  unsub = useForm.subscribe(() => {
    if (syncing || !activePlanId) return;
    clearTimeout(timer);
    timer = setTimeout(() => flushFormToPlan(), 200);
  });
}
