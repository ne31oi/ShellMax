import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { AssetPreviewCard, JobFooter, JobLoading, PostProcessDialogShell, useAssetJobForm } from "../jobs/PostProcessShell";
import { ErrorMessage, SectionTitle, Select } from "../ui";

export function FidelityUpscaleDialog() {
  const state = useUI((s) => s.fidelityUpscaleDialog);
  const close = () => useUI.getState().openFidelityUpscaleDialog(null);
  return <PostProcessDialogShell open={state !== null} title="Бережное улучшение" onClose={close}>
    {state && <FidelityForm key={`${state.assetId}-${state.fromGenerationId ?? ''}`} {...state} onDone={close} />}
  </PostProcessDialogShell>;
}

function FidelityForm({ assetId, fromGenerationId, onDone }: { assetId: number; fromGenerationId?: number; onDone: () => void }) {
  const form = useAssetJobForm(assetId, api.fidelityDefaults);
  const fromGen = useLibrary((s) => fromGenerationId ? s.generations[fromGenerationId] : undefined);
  const [scale, setScale] = useState<1 | 2>(1);
  useEffect(() => {
    if (form.defaults) setScale(fromGen ? (fromGen.ui_params.scale === 1 ? 1 : 2) : form.defaults.scale);
  }, [form.defaults, fromGen]);
  const d = form.defaults;
  if (!d) return <JobLoading error={form.error} />;
  const submit = () => form.submit(() => api.fidelityUpscale({ source_asset_id: assetId, scale }), {
    upsert: (g) => useLibrary.getState().upsertGeneration(g),
    select: (id) => useUI.getState().selectGen(id), onDone,
  });
  return <div className="space-y-4 p-5">
    <p className="text-xs leading-relaxed text-muted">Уточняет существующие контуры. В режиме ×1 размер кадра остаётся прежним.
      Для клипов, где важно сохранить внешность, надписи и мелкие рисунки. Усиление деталей умеренное.</p>
    <AssetPreviewCard asset={d.asset} frames={d.frames} durationSec={d.asset.duration ?? 0} />
    <div><SectionTitle>Режим</SectionTitle>
      <Select value={String(scale)} onChange={(value) => setScale(value === "2" ? 2 : 1)} defaultValue="1"
        options={[{ value: "1", label: "×1 — улучшить без изменения размера" }, { value: "2", label: "×2 — улучшить и увеличить" }]} />
    </div>
    <p className="text-xs text-muted">Результат: {(d.asset.width ?? 0) * scale} × {(d.asset.height ?? 0) * scale} · {d.asset.fps ?? 24} к/с.
      Звук, длина и композиция сохраняются. Результат появится отдельным клипом для сравнения.</p>
    {!d.ready && <ErrorMessage text="SwinIR ещё не установлен. Запустите scripts/install_fidelity_upscale.py (67 МБ)." />}
    {form.error && <ErrorMessage text={form.error} />}
    <JobFooter onCancel={onDone} onSubmit={submit} busy={form.busy} disabled={!d.ready}
      estimate={null} label={scale === 1 ? "Улучшить ×1" : "Увеличить ×2"} icon={<Sparkles size={15} />} />
  </div>;
}
