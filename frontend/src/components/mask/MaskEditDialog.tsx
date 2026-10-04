import { useEffect, useRef, useState } from "react";
import { Wand2 } from "lucide-react";
import { api } from "../../api/client";
import type { MaskEditDefaults, MaskEditParams, MaskTrackParams } from "../../api/types";
import { fromModelPrompt, toModelPrompt } from "../../lib/refs";
import { useForm } from "../../store/form";
import { useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { AssetPreviewCard, JobFooter, JobLoading, runAssetJob } from "../jobs/PostProcessShell";
import { Button, Dialog, ErrorMessage, Select, Switch } from "../ui";
import { MaskEditor } from "./MaskEditor";
import { MaskTrackingControls, type PointMode } from "./MaskTrackingControls";
import { maskEditRefs, MaskEditReferences, useMaskEditReferences } from "./MaskEditReferences";
import { MaskEditPrompt } from "./MaskEditPrompt";

export function MaskEditDialog() {
  const state = useUI((s) => s.maskEditDialog);
  const close = () => useUI.getState().openMaskEditDialog(null);
  return <Dialog open={!!state} onOpenChange={(value) => !value && close()} title="Изменить область по маске" wide>
    {state && <MaskEditForm key={`${state.assetId}-${state.fromGenerationId ?? ""}`} assetId={state.assetId} fromGenerationId={state.fromGenerationId} onDone={close} />}
  </Dialog>;
}

function MaskEditForm({ assetId, fromGenerationId, onDone }: { assetId: number; fromGenerationId?: number; onDone: () => void }) {
  const [defaults, setDefaults] = useState<MaskEditDefaults | null>(null);
  const [draft, setDraft] = useState<MaskEditParams | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expert, setExpert] = useState(false);
  const [pointMode, setPointMode] = useState<PointMode>(null);
  const references = useMaskEditReferences();
  const [uploadingRef, setUploadingRef] = useState(false);
  const [writingPrompt, setWritingPrompt] = useState(false);
  const selectedRefs = maskEditRefs(draft?.reference_upload_ids ?? [], references.uploads);
  const meta = useLibrary((s) => s.meta);
  useEffect(() => {
    api.maskEditDefaults(assetId).then((d) => {
      setDefaults(d);
      const form = useForm.getState();
      const previous = fromGenerationId ? useLibrary.getState().generations[fromGenerationId] : null;
      const saved = previous?.kind === "mask_edit" ? previous.ui_params as unknown as MaskEditParams : form.maskEditDrafts[String(assetId)];
      const initial = saved ?? { source_asset_id: assetId, prompt: "", layers: [], start: 0, end: d.asset.duration,
        strength: d.strength, grow: d.grow, feather: d.feather, invert: false, crop_to_mask: false, keep_audio: true,
        quality: d.quality, seed: null, profile_id: form.profileId, reference_upload_ids: [] };
      const ids = initial.reference_upload_ids ?? [];
      const legacyRefs = form.refs.filter((r) => ids.includes(r.upload.id));
      const next = { ...initial, reference_upload_ids: ids,
        prompt: initial.prompt.replace(/\{\{ref:([a-z0-9]+)\}\}/gi, (token, uid: string) => {
          const legacy = legacyRefs.find((r) => r.uid === uid);
          return legacy ? `{{ref:${legacy.upload.id}}}` : token;
        }) };
      const tracking = previous?.kind === "mask_track" ? previous.ui_params as unknown as MaskTrackParams : null;
      setDraft(tracking && previous ? { ...next, start: tracking.start, end: tracking.end,
        sam_selection: { text: tracking.text, points: tracking.points }, sam_job_id: previous.id, sam_applied_id: undefined } : next);
    }).catch((e) => setError(e instanceof Error ? e.message : "Не удалось открыть клип"));
  }, [assetId, fromGenerationId]);
  const update = (patch: Partial<MaskEditParams>) => {
    if (!draftRef.current) return;
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setDraft(next);
    useForm.getState().set({ maskEditDrafts: { ...useForm.getState().maskEditDrafts, [assetId]: next } });
  };
  useEffect(() => {
    if (!draft || references.loading) return;
    const prompt = fromModelPrompt(draft.prompt, maskEditRefs(draft.reference_upload_ids, references.uploads));
    if (prompt !== draft.prompt) {
      const next = { ...draft, prompt };
      setDraft(next);
      useForm.getState().set({ maskEditDrafts: { ...useForm.getState().maskEditDrafts, [assetId]: next } });
    }
  }, [draft, references.loading, references.uploads, assetId]);
  const submit = () => {
    if (references.loading || uploadingRef || writingPrompt) return;
    if (draft && selectedRefs.length !== draft.reference_upload_ids.length) { setError("Референс не найден — уберите его из выбора и добавьте заново"); return; }
    const job = draft?.sam_job_id ? useLibrary.getState().generations[draft.sam_job_id] : null;
    if (job?.status === "queued" || job?.status === "running") { setError("Дождитесь трекинга SAM и проверьте готовую маску"); return; }
    if (!draft || !draft.prompt.trim() || !draft.layers.length) { setError("Нарисуйте маску и опишите желаемый результат"); return; }
    void runAssetJob(() => api.maskEdit({ ...draft, prompt: toModelPrompt(draft.prompt, selectedRefs), profile_id: useForm.getState().profileId }), {
      upsert: (g) => useLibrary.getState().upsertGeneration(g), select: (id) => useUI.getState().selectGen(id), onDone, setBusy, setError,
    });
  };
  if (!defaults || !draft) return <JobLoading error={error} />;
  const end = draft.end ?? defaults.asset.duration ?? 0;
  const frameBudget = Math.floor((end - draft.start) * 24 + 1e-5);
  const frames = frameBudget >= 5 ? Math.floor((frameBudget - 5) / 17) * 17 + 5 : 0;
  const selection = draft.sam_selection ?? { text: "", points: [] };
  return <div className="space-y-4 p-5">
    <p className="text-xs leading-relaxed text-muted">Выбранная область будет перерисована, результат сохранится новым клипом. Вне маски и её мягкой границы используются исходные кадры. Длина фрагмента округляется вниз до сетки H3: {frames} кадров ({(frames / 24).toFixed(2)} с).</p>
    <AssetPreviewCard asset={defaults.asset} frames={frames} durationSec={frames / 24} />
    <fieldset disabled={writingPrompt || busy} className="space-y-4">
    <div className="flex gap-3 text-xs"><label>С <input aria-label="Начало фрагмента маски" type="number" min={0} max={defaults.asset.duration ?? 0} step={1 / 24} className="w-20 rounded border border-line bg-raised px-2 py-1" value={draft.start} onChange={(e) => update({ start: Number(e.target.value) })} /> с</label>
      <label>До <input aria-label="Конец фрагмента маски" type="number" min={draft.start} max={defaults.asset.duration ?? 0} step={1 / 24} className="w-20 rounded border border-line bg-raised px-2 py-1" value={end} onChange={(e) => update({ end: Number(e.target.value) })} /> с</label></div>
    <MaskTrackingControls assetId={assetId} start={draft.start} end={end} selection={selection} onSelection={(sam_selection) => update({ sam_selection })}
      mode={pointMode} onMode={setPointMode} jobId={draft.sam_job_id} onJob={(sam_job_id) => update({ sam_job_id })}
      appliedJobId={draft.sam_applied_id} layers={draft.layers} onResult={(layers, sam_applied_id) => update({ layers, sam_applied_id })} />
    <MaskEditor asset={defaults.asset} layers={draft.layers} onChange={(layers) => update({ layers })} start={draft.start} end={end} pointMode={pointMode} selection={selection}
      onPoint={(time, point, mode) => { const existing = selection.points.find((p) => Math.abs(p.time - time) < 0.001);
        const frame = existing ?? { time, positive: [], negative: [] };
        update({ sam_selection: { ...selection, points: [...selection.points.filter((p) => p !== existing), { ...frame, [mode]: [...frame[mode], point] }].sort((a, b) => a.time - b.time) } }); }} />
    </fieldset>
    <MaskEditReferences uploads={references.uploads} selected={selectedRefs} loading={references.loading} disabled={busy || writingPrompt}
      onUpload={references.addUploads} onBusy={setUploadingRef}
      onChange={(reference_upload_ids) => update({ reference_upload_ids,
        prompt: draft.prompt.replace(/\{\{ref:([a-z0-9]+)\}\}/gi, (token, uid: string) => reference_upload_ids.includes(uid) ? token : "") })}
      onInsert={(uid) => update({ prompt: `${draft.prompt}${draft.prompt && !/\s$/.test(draft.prompt) ? " " : ""}{{ref:${uid}}}` })} />
    {references.error && <ErrorMessage text={references.error} />}
    {!references.loading && selectedRefs.length !== draft.reference_upload_ids.length && <div className="flex items-center gap-2 text-xs text-muted">
      Не удалось найти часть референсов.
      <Button size="sm" disabled={writingPrompt || busy} onClick={() => update({ reference_upload_ids: selectedRefs.map((r) => r.upload.id) })}>Убрать недоступные</Button>
    </div>}
    <MaskEditPrompt draft={draft} refs={selectedRefs} frames={frames} sourcePrompt={defaults.prompt}
      disabled={busy || references.loading || uploadingRef || selectedRefs.length !== draft.reference_upload_ids.length}
      onChange={(prompt) => update({ prompt })} onBusy={setWritingPrompt} />
    <fieldset disabled={writingPrompt || busy} className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-2"><Select value={String(draft.strength)} onChange={(value) => update({ strength: Number(value) })} options={[{ value: "0.8", label: "Сила: заметное изменение (по умолчанию)" }, { value: "0.5", label: "Сила: бережная правка" }, { value: "1", label: "Сила: полная перерисовка" }]} />
      <Select value={draft.quality} onChange={(value) => update({ quality: value })} options={(meta?.quality ?? []).map((q) => ({ value: q.id, label: q.label }))} /></div>
    <Switch checked={draft.keep_audio} onChange={(value) => update({ keep_audio: value })} label="Сохранить исходный звук" />
    <Button size="sm" onClick={() => setExpert(!expert)}>Эксперт {expert ? "▴" : "▾"}</Button>
    {expert && <div className="space-y-3 rounded-lg border border-line p-3"><Switch checked={draft.invert} onChange={(value) => update({ invert: value })} label="Изменить всё вне маски" />
      <Switch checked={draft.crop_to_mask} onChange={(value) => update({ crop_to_mask: value })} label="Сосредоточить детализацию вокруг маски" />
      <Select value={String(draft.grow)} onChange={(value) => update({ grow: Number(value) })} options={[0, 8, 16, 32, 64].map((v) => ({ value: String(v), label: `Расширить маску: ${v} px${v === 16 ? " (по умолчанию)" : ""}` }))} />
      <Select value={String(draft.feather)} onChange={(value) => update({ feather: Number(value) })} options={[0, 8, 12, 24, 32, 64].map((v) => ({ value: String(v), label: `Мягкая граница: ${v} px${v === 12 ? " (по умолчанию)" : ""}` }))} /></div>}
    </fieldset>
    {error && <ErrorMessage text={error} />}
    <JobFooter onCancel={onDone} onSubmit={submit} busy={busy} disabled={references.loading || uploadingRef || writingPrompt} estimate={null} label="Перерисовать область" icon={<Wand2 size={15} />} />
  </div>;
}
