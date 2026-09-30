import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { AssetPreviewCard, JobFooter, JobLoading, PostProcessDialogShell, useAssetJobForm } from "../jobs/PostProcessShell";
import { ErrorMessage, SectionTitle } from "../ui";

export function SoLRefinerDialog() {
  const state = useUI((s) => s.solRefinerDialog);
  const close = () => useUI.getState().openSoLRefinerDialog(null);
  return <PostProcessDialogShell open={state !== null} title="Детализация · SoL-Refiner" onClose={close}>
    {state && <SoLForm key={`${state.assetId}-${state.fromGenerationId ?? ""}`} {...state} onDone={close} />}
  </PostProcessDialogShell>;
}

function SoLForm({ assetId, fromGenerationId, onDone }: {
  assetId: number; fromGenerationId?: number; onDone: () => void;
}) {
  const form = useAssetJobForm(assetId, api.solRefinerDefaults);
  const fromGen = useLibrary((s) => fromGenerationId ? s.generations[fromGenerationId] : undefined);
  const [prompt, setPrompt] = useState("");
  useEffect(() => { if (form.defaults) setPrompt(fromGen?.ui_params.prompt ?? form.defaults.prompt); }, [form.defaults, fromGen]);
  const d = form.defaults;
  if (!d) return <JobLoading error={form.error} />;
  const submit = () => form.submit(() => api.solRefiner({ source_asset_id: assetId, prompt, seed: fromGen?.seed ?? 0 }), {
    upsert: (g) => useLibrary.getState().upsertGeneration(g),
    select: (id) => useUI.getState().selectGen(id), onDone,
  });
  return <div className="space-y-4 p-5">
    <p className="text-xs leading-relaxed text-muted">SoL-Refiner обрабатывает готовое видео MiniMax H3 за один проход.
      Он может менять лицо и мелкие детали. Результат появится отдельным клипом для сравнения. Звук и длина сохраняются.</p>
    <AssetPreviewCard asset={d.asset} frames={d.frames} durationSec={d.asset.duration ?? 0} />
    <p className="text-xs text-muted">Результат: {d.width} × {d.height} · {d.asset.fps ?? 24} к/с</p>
    <div><SectionTitle>Описание клипа</SectionTitle>
      <textarea aria-label="Описание клипа для SoL-Refiner" value={prompt} onChange={(e) => setPrompt(e.target.value)}
        rows={5} className="w-full resize-y rounded-lg border border-line bg-raised p-3 text-xs outline-none focus:border-accent"
        placeholder="Коротко опишите то, что действительно видно: персонаж, важные детали, действие и окружение." />
      <p className="mt-1.5 text-[11px] text-faint">Промпт H3 не подставляется: SoL не получает его картинки-референсы.
        Ошибочное описание может изменить внешность.</p>
    </div>
    {!d.ready && <ErrorMessage text="SoL-Refiner ещё не установлен. Требуется загрузить комплект INT8 (41,4 ГБ). Инструкция — в README." />}
    <p className="text-[11px] text-faint">INT8 ConvRot · экспериментальный режим. На 16 ГБ слои выгружаются в оперативную память; первый запуск может быть долгим.</p>
    {form.error && <ErrorMessage text={form.error} />}
    <JobFooter onCancel={onDone} onSubmit={submit} busy={form.busy} disabled={!d.ready || !prompt.trim()} estimate={null}
      label="Обработать SoL-Refiner" icon={<Sparkles size={15} />} />
  </div>;
}
