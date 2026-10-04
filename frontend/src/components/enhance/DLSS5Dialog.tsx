import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { DLSS5Mode, DLSS5Params } from "../../api/types";
import { useForm } from "../../store/form";
import { useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { AssetPreviewCard, JobFooter, JobLoading, PostProcessDialogShell, useAssetJobForm } from "../jobs/PostProcessShell";
import { ErrorMessage, SectionTitle, Select } from "../ui";

export function DLSS5Dialog() {
  const state = useUI((s) => s.dlss5Dialog);
  const close = () => useUI.getState().openDLSS5Dialog(null);
  return <PostProcessDialogShell open={state !== null} title="Улучшение DLSS5" onClose={close}>
    {state && <DLSS5Form key={`${state.assetId}-${state.fromGenerationId ?? ''}`} {...state} onDone={close} />}
  </PostProcessDialogShell>;
}

function DLSS5Form({ assetId, fromGenerationId, onDone }: { assetId: number; fromGenerationId?: number; onDone: () => void }) {
  const form = useAssetJobForm(assetId, api.dlss5Defaults);
  const fromGen = useLibrary((s) => fromGenerationId ? s.generations[fromGenerationId] : undefined);
  const [params, setParams] = useState<Omit<DLSS5Params, "source_asset_id">>({ mode: "1x (DLAA / native)", style: "Default", intensity: 1 });
  useEffect(() => {
    const d = form.defaults;
    if (d) {
      const saved = useForm.getState().dlss5Settings;
      const u = fromGen?.ui_params;
      setParams({ mode: u?.mode ?? saved?.mode ?? d.mode, style: u?.style ?? saved?.style ?? d.style,
        intensity: u?.intensity ?? saved?.intensity ?? d.intensity });
    }
  }, [form.defaults, fromGen]);
  const update = (patch: Partial<typeof params>) => {
    const next = { ...params, ...patch };
    setParams(next);
    useForm.getState().set({ dlss5Settings: next });
  };
  const d = form.defaults;
  if (!d) return <JobLoading error={form.error} />;
  const factor = Number.parseFloat(params.mode);
  const even = (size: number) => Math.max(2, Math.floor(size * factor / 2 + 0.5) * 2);
  const submit = () => form.submit(() => api.dlss5({ source_asset_id: assetId, ...params }), {
    upsert: (g) => useLibrary.getState().upsertGeneration(g), select: (id) => useUI.getState().selectGen(id), onDone,
  });
  return <div className="space-y-4 p-5">
    <p className="text-xs leading-relaxed text-muted">Нейронная обработка кожи, волос и материалов с согласованием соседних кадров.
      Результат появится отдельным клипом для сравнения с исходником.</p>
    <AssetPreviewCard asset={d.asset} frames={d.frames} durationSec={d.asset.duration ?? 0} />
    <div><SectionTitle>Масштаб</SectionTitle>
      <Select value={params.mode} onChange={(mode) => update({ mode: mode as DLSS5Mode })} defaultValue={d.mode}
        options={d.modes.map((value) => ({ value, label: value === "1x (DLAA / native)" ? "×1 — исходный размер" : value.replace("x", "×") }))} />
    </div>
    <div className="grid grid-cols-2 gap-3">
      <div><SectionTitle>Подача</SectionTitle><Select value={params.style} defaultValue={d.style}
        onChange={(style) => update({ style: style as DLSS5Params["style"] })}
        options={d.styles.map((value) => ({ value, label: ({ Default: "Стандартная", Natural: "Естественная", Cinematic: "Кинематографичная" })[value] }))} /></div>
      <div><SectionTitle>Сила обработки</SectionTitle><Select value={String(params.intensity)} defaultValue={String(d.intensity)}
        onChange={(value) => update({ intensity: Number(value) })}
        options={[{ value: "1", label: "100%" }, { value: "0.7", label: "70% — мягче" }, { value: "0.5", label: "50% — деликатно" }]} /></div>
    </div>
    <p className="text-xs text-muted">Результат: {even(d.asset.width ?? 0)} × {even(d.asset.height ?? 0)} · {d.asset.fps ?? 24} к/с.
      Исходный звук переносится в MP4. Метаданные и параметры обработки записываются в файл.</p>
    {!d.ready && <ErrorMessage text={d.detail} />}
    {form.error && <ErrorMessage text={form.error} />}
    <JobFooter onCancel={onDone} onSubmit={submit} busy={form.busy} disabled={!d.ready}
      estimate={null} label="Обработать DLSS5" icon={<Sparkles size={15} />} />
  </div>;
}
