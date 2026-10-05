import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import type { ContinuationUIParams } from "../../api/types";
import { defaultProfile, useLibrary } from "../../store/library";
import { useForm } from "../../store/form";
import { useUI } from "../../store/ui";
import { AssetPreviewCard, JobFooter, JobLoading, PostProcessDialogShell, useAssetJobForm } from "../jobs/PostProcessShell";
import { ErrorMessage, Select } from "../ui";

export function ContinuationDialog() {
  const state = useUI((s) => s.continuationDialog);
  const close = () => useUI.getState().openContinuationDialog(null);
  return <PostProcessDialogShell open={state !== null} title="Продолжить клип" onClose={close} wide>
    {state && <ContinuationForm key={`${state.assetId}-${state.fromGenerationId ?? ""}`} {...state} onDone={close} />}
  </PostProcessDialogShell>;
}

function ContinuationForm({ assetId, fromGenerationId, onDone }: {
  assetId: number; fromGenerationId?: number; onDone: () => void;
}) {
  const form = useAssetJobForm(assetId, api.continuationDefaults);
  const previous = useLibrary((s) => fromGenerationId ? s.generations[fromGenerationId] : undefined);
  const profiles = useLibrary((s) => s.profiles);
  const sourceProfileId = form.defaults?.params.profile_id;
  const sticky = useForm.getState();
  const [prompt, setPrompt] = useState(() => String(previous?.ui_params.prompt ?? ""));
  const [duration, setDuration] = useState(() => Number(previous?.ui_params.duration ?? sticky.continuationDuration));
  const [context, setContext] = useState(() => Number(previous?.ui_params.context_frames ?? sticky.continuationContextFrames));
  const [profileId, setProfileId] = useState<number | null>(() => {
    const id = Number(previous?.ui_params.profile_id);
    return profiles.some((p) => p.id === id) ? id : null;
  });
  const selectedProfileId = profileId ?? (profiles.some((p) => p.id === sourceProfileId) ? sourceProfileId : null)
    ?? (profiles.some((p) => p.id === sticky.profileId) ? sticky.profileId : null)
    ?? defaultProfile(profiles)?.id ?? null;
  const [expert, setExpert] = useState(false);
  const d = form.defaults;
  if (!d) return <JobLoading error={form.error} />;
  const params = { ...d.params, ...(previous?.ui_params ?? {}), source_asset_id: assetId,
    prompt, duration, context_frames: context, profile_id: selectedProfileId, variants: 1 } as ContinuationUIParams;
  const profile = profiles.find((p) => p.id === selectedProfileId) ?? defaultProfile(profiles);
  const available = Math.floor((d.asset.duration ?? 0) * 24 + 1e-4);
  const effectiveContext = Math.min(context, Math.max(5, Math.floor((available - 5) / 17) * 17 + 5));
  const added = Math.ceil(duration * 24 / 17) * 17;
  const submit = () => void form.submit(() => api.continueVideo(params), {
    upsert: (g) => useLibrary.getState().upsertGeneration(g), select: (id) => useUI.getState().selectGen(id), onDone,
  });
  return <div className="space-y-4 p-5">
    <AssetPreviewCard asset={d.asset} frames={Math.round((d.asset.duration ?? 0) * (d.asset.fps ?? 24))} durationSec={d.asset.duration ?? 0} />
    <p className="text-xs leading-relaxed text-muted">Последние {effectiveContext} {effectiveContext === 22 ? "кадра" : "кадров"} и их звук задают начало продолжения в обоих проходах.
      В библиотеке появится отдельный клип с новым действием, без повторения этих кадров.</p>
    <label className="block"><span className="mb-2 block text-xs text-muted">Что происходит дальше</span>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={7}
        placeholder="Опишите продолжение движения персонажа и камеры…"
        className="w-full resize-y rounded-xl border border-line bg-raised p-3 text-[13px] outline-none focus:border-accent/60" />
    </label>
    <div className="grid grid-cols-2 gap-4">
      <label className="block"><span className="mb-1 block text-xs text-muted">Добавить секунд</span>
        <input aria-label="Добавить секунд" type="number" value={duration} min={0.2} max={149} step={0.1}
          onChange={(e) => { if (!e.target.value) return; const v = Number(e.target.value); setDuration(v); useForm.getState().set({ continuationDuration: v }); }}
          className="h-8 w-full rounded-lg border border-line bg-raised px-2.5 text-[13px]" />
      </label>
      <Select label="Профиль движка" value={String(selectedProfileId ?? "")} options={profiles.map((p) => ({ value: String(p.id), label: p.name }))}
        onChange={(value) => setProfileId(Number(value))} />
    </div>
    <p className="text-[11px] text-faint">{added} новых кадров · {(added / 24).toFixed(2)} с · {profile?.name}.
      {params.refs.length > 0 ? ` Сохранены референсы исходной генерации: ${params.refs.length}.` : ""}</p>
    <button className="text-xs text-muted hover:text-fg" onClick={() => setExpert(!expert)}>Эксперт</button>
    {expert && <Select label="Контекст движения" value={String(context)} onChange={(v) => {
      const frames = Number(v) as 5 | 22 | 39; setContext(frames); useForm.getState().set({ continuationContextFrames: frames });
    }} options={[{ value: "22", label: "22 кадра · 0,92 с (по умолчанию)" },
      { value: "5", label: "5 кадров · 0,21 с" }, { value: "39", label: "39 кадров · 1,63 с" }]} />}
    {form.error && <ErrorMessage text={form.error} />}
    <JobFooter onCancel={onDone} onSubmit={submit} busy={form.busy} estimate={null} label="Продолжить" icon={<ArrowRight size={15} />}
      disabled={!prompt.trim() || !Number.isFinite(duration) || duration < 0.2 || duration > 149 || !!profile?.problems.length} />
    {!!profile?.problems.length && <ErrorMessage text="Не найдены модели выбранного профиля — проверьте Настройки → Движок" />}
  </div>;
}
