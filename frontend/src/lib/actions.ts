/** User actions shared by the generate panel, media cards, context menus and the viewer. */
import { api, ApiError } from "../api/client";
import type { Generation, MediaAsset, UIParams, Upload } from "../api/types";
import { useForm } from "../store/form";
import { defaultProfile, useLibrary } from "../store/library";
import { commands, audioTracks, snapTime, useTimeline } from "../store/timeline";
import { useUI } from "../store/ui";
import { emit } from "./bus";
import { toModelPrompt } from "./refs";
import { useClip } from "../store/clip";
import type { ClipOperation, ClipEdit } from "../api/clip-types";
import { emptyPlan, type TimelineDoc, type Track } from "../store/timeline";

export async function clipEdit(patch: ClipEdit) {
  const active = useClip.getState().active;
  if (!active) return;
  useClip.getState().setActive(await api.editClipProject(active.id, active.revision, patch));
}

export async function clipOperation(operation: ClipOperation) {
  const active = useClip.getState().active;
  if (!active) return;
  await api.clipOperation(active.id, active.revision, operation);
  await useClip.getState().refresh();
}

function replaceClipTracks(label: string, incoming: Track[], output?: Partial<TimelineDoc>) {
  const state = useTimeline.getState();
  const before = state.doc;
  const ids = new Set(incoming.map((t) => t.id));
  const replacements = new Map(incoming.map((t) => [t.id, t]));
  state.run({ label,
    apply: (doc) => ({ ...doc, ...output, tracks: [
      ...doc.tracks.map((t) => replacements.get(t.id) ?? t),
      ...incoming.filter((t) => !doc.tracks.some((old) => old.id === t.id)),
    ] }),
    revert: (doc) => ({ ...doc, outputWidth: before.outputWidth, outputHeight: before.outputHeight, outputFps: before.outputFps,
      masterMute: before.masterMute, masterVolume: before.masterVolume,
      tracks: [...before.tracks.map((t) => ids.has(t.id) ? t : doc.tracks.find((now) => now.id === t.id) ?? t),
        ...doc.tracks.filter((t) => !ids.has(t.id) && !before.tracks.some((old) => old.id === t.id))] }),
  });
}

export async function applyClipBlock(blockId: string, replace = false) {
  const active = useClip.getState().active;
  if (!active) return;
  const proposal = await api.clipPlanProposal(active.id, blockId);
  if (useClip.getState().active?.id !== active.id || useClip.getState().active?.revision !== proposal.revision) throw new Error("Проект изменился — обновите блок");
  const current = useTimeline.getState().doc;
  const incoming: Track[] = [
    { id: proposal.track_id, kind: "plan", name: active.document.blocks.find((b) => b.id === blockId)?.name,
      clips: [], plans: proposal.plans.map((p) => emptyPlan(p)) }, proposal.audio_track,
  ];
  // A retry must never silently discard a manual edit or replace an older block version.
  const changes = replace ? incoming : incoming.filter((t) => !current.tracks.some((old) => old.id === t.id));
  if (changes.length) replaceClipTracks("Применить блок клипа", changes);
  // Await this save explicitly: the ordinary timeline autosave is debounced.
  await api.saveTimeline(active.project_id, useTimeline.getState().doc);
}

export async function assembleClip() {
  const active = useClip.getState().active;
  if (!active) return;
  const proposal = await api.clipAssembly(active.id);
  if (useClip.getState().active?.id !== active.id || useClip.getState().active?.revision !== proposal.revision) throw new Error("Проект изменился — обновите сборку");
  const before = useTimeline.getState().doc;
  const videoId = before.tracks.find((t) => t.kind === "video")?.id ?? "v1";
  const incoming = proposal.timeline.tracks.map((t) => ({ ...t, id: t.kind === "video" ? videoId : t.id,
    plans: t.plans ?? [], muted: false, solo: false }));
  const audioId = incoming.find((t) => t.kind === "audio")?.id;
  for (const t of before.tracks) if (t.kind === "audio" && t.id !== audioId) incoming.push({ ...t, muted: true, solo: false });
  replaceClipTracks("Собрать клип", incoming, {
    outputWidth: proposal.timeline.outputWidth, outputHeight: proposal.timeline.outputHeight, outputFps: 24,
    masterMute: false, masterVolume: 1,
  });
  await api.saveTimeline(active.project_id, useTimeline.getState().doc);
  useUI.getState().setWorkspace("edit");
  useUI.getState().setViewingSequence(true);
  useUI.getState().toast("Клип собран. Просмотрите монтаж и нажмите «Экспорт». Ctrl+Z отменит сборку", "ok");
}

const toast = (...a: Parameters<ReturnType<typeof useUI.getState>["toast"]>) => useUI.getState().toast(...a);

function handleError(e: unknown) {
  if (e instanceof ApiError && e.detail && typeof e.detail === "object" && (e.detail as { kind?: string }).kind === "missing_file") {
    toast(e.message, "bad", { label: "Открыть настройки", run: () => useUI.getState().openSettings("engine") });
    return;
  }
  toast(e instanceof Error ? e.message : String(e), "bad");
}

export async function generate(): Promise<void> {
  const f = useForm.getState();
  const prompt = toModelPrompt(f.prompt, f.refs).trim();
  if (!prompt) {
    toast("Опишите, что должно происходить в видео", "info");
    emit("focusPrompt");
    return;
  }
  const params: UIParams = {
    prompt,
    refs: f.refs.map((r) => ({ kind: r.upload.kind, upload_id: r.upload.id, with_audio: r.withAudio })),
    aspect: f.aspect,
    duration: f.duration,
    quality: f.quality,
    look: f.look,
    light: f.light,
    styles: f.styles.map((s) => ({ style_id: s.style_id, strength: s.strength })),
    seed: f.seedLocked && f.seed != null ? f.seed : null,
    variants: f.variants,
    profile_id: f.profileId,
  };
  try {
    const gens = await api.generate(params);
    gens.forEach((g) => useLibrary.getState().upsertGeneration(g));
    f.rememberPrompt();
    if (!f.seedLocked) useForm.getState().set({ seed: gens[0].seed });
    useUI.getState().selectGen(gens[0].id);
  } catch (e) {
    handleError(e);
  }
}

export async function retry(g: Generation, sameSeed: boolean, variants = 1) {
  try {
    const gens = await api.retry(g.id, sameSeed, variants);
    gens.forEach((x) => useLibrary.getState().upsertGeneration(x));
    useUI.getState().selectGen(gens[0].id);
  } catch (e) {
    handleError(e);
  }
}

export async function editAndRetry(g: Generation) {
  if (g.kind === "face") {
    if (g.source_asset_id) useUI.getState().openFaceDialog({ assetId: g.source_asset_id, fromGenerationId: g.id });
    return;
  }
  if (g.kind === "enhance") {
    if (g.source_asset_id) useUI.getState().openEnhanceDialog({ assetId: g.source_asset_id, fromGenerationId: g.id });
    return;
  }
  if (g.kind === "interpolate") {
    if (g.source_asset_id) useUI.getState().openInterpolateDialog({ assetId: g.source_asset_id, fromGenerationId: g.id });
    return;
  }
  await useForm.getState().loadFromGeneration(g);
  const ui = useUI.getState();
  if (ui.workspace !== "assistant" && !ui.panelOpen) ui.togglePanel();
  emit("focusPrompt");
  toast("Параметры загружены в панель — измените и нажмите «Создать»", "info");
}

export async function cancel(g: Generation) {
  await api.cancel(g.id).catch(handleError);
}

export async function cancelAll() {
  try {
    const res = await api.cancelAll();
    const n = res.cancelled?.length ?? 0;
    if (n === 0) toast("Нет активных генераций", "info");
    else toast(n === 1 ? "Остановлена 1 генерация" : `Остановлено: ${n}`, "ok");
    return res;
  } catch (e) {
    handleError(e);
  }
}

export async function remove(g: Generation) {
  const gens = useLibrary.getState().generations;
  const kids = descendantGens(g, gens);
  if (kids.length) {
    const n = kids.length;
    const ok = window.confirm(
      `Также удалятся ${n} ${n === 1 ? "связанное улучшение" : "связанных улучшений"} (лицо / детализация / интерполяция). Продолжить?`,
    );
    if (!ok) return;
  }
  try {
    await api.deleteGeneration(g.id);
    const lib = useLibrary.getState();
    lib.removeGeneration(g.id);
    for (const k of kids) lib.removeGeneration(k.id);
    const sel = useUI.getState().selectedGen;
    if (sel === g.id || kids.some((k) => k.id === sel)) useUI.getState().selectGen(null);
  } catch (e) {
    handleError(e);
  }
}

/** Face/enhance jobs that refine this generation's draft or output (transitively). */
function descendantGens(root: Generation, gens: Record<number, Generation>): Generation[] {
  const assetIds = new Set<number>();
  if (root.draft_asset_id) assetIds.add(root.draft_asset_id);
  if (root.output_asset_id) assetIds.add(root.output_asset_id);
  const found: Generation[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of Object.values(gens)) {
      if (g.id === root.id || found.some((f) => f.id === g.id)) continue;
      if (g.source_asset_id != null && assetIds.has(g.source_asset_id)) {
        found.push(g);
        if (g.draft_asset_id) assetIds.add(g.draft_asset_id);
        if (g.output_asset_id) assetIds.add(g.output_asset_id);
        changed = true;
      }
    }
  }
  return found;
}

export async function removeAsset(asset: MediaAsset) {
  if (asset.source !== "imported" && asset.source !== "exported") {
    toast("Сгенерированные клипы удаляются вместе с задачей", "info");
    return;
  }
  try {
    await api.deleteAsset(asset.id);
    useLibrary.getState().removeAsset(asset.id);
    if (useUI.getState().selectedAsset === asset.id) useUI.getState().selectAsset(null);
  } catch (e) {
    handleError(e);
  }
}

export function addUploadsAsRefs(uploads: Upload[]) {
  const { rejected } = useForm.getState().addRefs(uploads);
  if (rejected.length) toast(`Достигнут лимит референсов этого типа: ${rejected.join(", ")}`, "info");
}

export async function uploadFiles(files: File[]): Promise<Upload[]> {
  const results = await Promise.allSettled(files.map((f) => api.upload(f)));
  const ok: Upload[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") ok.push(r.value);
    else toast(`${files[i].name}: ${r.reason instanceof Error ? r.reason.message : "не удалось загрузить"}`, "bad");
  });
  return ok;
}

export async function assetAsRef(asset: MediaAsset) {
  try {
    addUploadsAsRefs([await api.assetAsUpload(asset.id)]);
  } catch (e) {
    handleError(e);
  }
}

export async function frameAsRef(asset: MediaAsset, t: number) {
  try {
    addUploadsAsRefs([await api.frameToRef(asset.id, t)]);
    toast("Кадр добавлен в референсы", "ok");
  } catch (e) {
    handleError(e);
  }
}

export function addToTimeline(asset: MediaAsset) {
  if (asset.kind !== "video") return;
  useTimeline.getState().run(
    commands.addClip({ id: Math.random().toString(36).slice(2, 10), assetId: asset.id, in: 0, out: asset.duration ?? 0 }),
  );
  const ui = useUI.getState();
  if (ui.workspace !== "edit") ui.setWorkspace("edit");
  ui.setViewingSequence(true);
  toast(`«${asset.name}» добавлен в таймлайн`, "ok");
}

/** Place audio (or video with a soundtrack) on an A-track at the playhead. */
export function addToAudioTrack(asset: MediaAsset, opts?: { trackId?: string; start?: number }) {
  if (asset.kind !== "audio" && !asset.has_audio) {
    toast("На A-трек — аудиофайл или клип со звуком", "info");
    return;
  }
  const tl = useTimeline.getState();
  const tracks = audioTracks(tl.doc);
  const trackId = opts?.trackId ?? tracks[0]?.id;
  if (!trackId) {
    toast("Нет аудиодорожки — нажмите A+", "info");
    return;
  }
  let start = opts?.start ?? tl.playhead;
  if (tl.doc.snapToBeats !== false) start = snapTime(tl.doc, start, { force: true });
  const dur = Math.max(0.15, asset.duration ?? 2);
  tl.run(
    commands.addAudioClip(
      {
        id: Math.random().toString(36).slice(2, 10),
        assetId: asset.id,
        in: 0,
        out: dur,
        start,
        muted: false,
      },
      trackId,
    ),
  );
  const ui = useUI.getState();
  if (ui.workspace !== "edit") ui.setWorkspace("edit");
  toast(`«${asset.name}» на аудиодорожку`, "ok");
}

export async function reveal(asset: MediaAsset) {
  await api.reveal(asset.id).catch(handleError);
}

/** One-click fixes offered on errors. */
export const fixes = {
  lowerQuality(g: Generation) {
    const order = ["high", "standard", "draft"];
    const next = order[Math.min(order.indexOf(g.ui_params.quality) + 1, order.length - 1)];
    useForm.getState().loadFromGeneration(g).then(() => useForm.getState().set({ quality: next }));
    toast("Качество снижено — нажмите «Создать»", "info");
  },
  async enableLowVram() {
    const lib = useLibrary.getState();
    const prof = defaultProfile(lib.profiles);
    if (!prof) return;
    await api.updateProfile(prof.id, { ...prof.data, low_vram: true }, prof.is_default);
    await lib.reloadProfiles();
    toast("Экономия VRAM включена", "ok");
  },
};

export const outputAsset = (g: Generation | undefined, assets: Record<number, MediaAsset>) =>
  g ? (g.output_asset_id ? assets[g.output_asset_id] : g.draft_asset_id ? assets[g.draft_asset_id] : undefined) : undefined;
