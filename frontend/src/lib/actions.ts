/** User actions shared by the generate panel, media cards, context menus and the viewer. */
import { api, ApiError } from "../api/client";
import type { Generation, MediaAsset, UIParams, Upload } from "../api/types";
import { useForm } from "../store/form";
import { defaultProfile, useLibrary } from "../store/library";
import { commands, useTimeline } from "../store/timeline";
import { useUI } from "../store/ui";
import { emit } from "./bus";
import { toModelPrompt } from "./refs";

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
  await useForm.getState().loadFromGeneration(g);
  const ui = useUI.getState();
  if (ui.workspace === "edit" && !ui.genDrawer) ui.toggleGenDrawer();
  emit("focusPrompt");
  toast("Параметры загружены в панель — измените и нажмите «Создать»", "info");
}

export async function cancel(g: Generation) {
  await api.cancel(g.id).catch(handleError);
}

export async function remove(g: Generation) {
  try {
    await api.deleteGeneration(g.id);
    useLibrary.getState().removeGeneration(g.id);
    if (useUI.getState().selectedGen === g.id) useUI.getState().selectGen(null);
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
  toast(`«${asset.name}» добавлен в таймлайн`, "ok");
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
