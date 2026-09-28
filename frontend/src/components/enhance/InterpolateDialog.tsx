import { Gauge } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { Estimate, InterpolateDefaults } from "../../api/types";
import { fileName } from "../../lib/format";
import { useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import {
  AssetPreviewCard,
  JobFooter,
  JobLoading,
  ModelEstimateLine,
  runAssetJob,
} from "../jobs/PostProcessShell";
import { Dialog, ErrorMessage, SectionTitle, Select } from "../ui";

/**
 * Native ComfyUI frame interpolation (RIFE / FILM): raise FPS without changing resolution.
 */
export function InterpolateDialog() {
  const state = useUI((s) => s.interpolateDialog);
  const close = () => useUI.getState().openInterpolateDialog(null);
  return (
    <Dialog open={state !== null} onOpenChange={(o) => !o && close()} title="Интерполяция">
      {state && (
        <InterpolateForm
          key={`${state.assetId}-${state.fromGenerationId ?? ""}`}
          assetId={state.assetId}
          fromGenerationId={state.fromGenerationId}
          onDone={close}
        />
      )}
    </Dialog>
  );
}

function InterpolateForm({
  assetId,
  fromGenerationId,
  onDone,
}: {
  assetId: number;
  fromGenerationId?: number;
  onDone: () => void;
}) {
  const fromGen = useLibrary((s) => (fromGenerationId ? s.generations[fromGenerationId] : undefined));
  const [defaults, setDefaults] = useState<InterpolateDefaults | null>(null);
  const [model, setModel] = useState<"rife" | "film">("rife");
  const [multiplier, setMultiplier] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [estimate, setEstimate] = useState<Estimate | null>(null);

  useEffect(() => {
    api
      .interpolateDefaults(assetId)
      .then((d) => {
        setDefaults(d);
        const p = fromGen?.ui_params;
        setModel(p?.model === "film" ? "film" : d.model === "film" ? "film" : "rife");
        setMultiplier(typeof p?.multiplier === "number" ? p.multiplier : d.multiplier);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Не удалось открыть клип"));
  }, [assetId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!defaults) return;
    api.interpolateEstimate(assetId, multiplier, model).then(setEstimate).catch(() => setEstimate(null));
  }, [assetId, multiplier, model, defaults]);

  const submit = () =>
    runAssetJob(
      () =>
        api.interpolate({
          source_asset_id: assetId,
          model,
          multiplier,
        }),
      {
        upsert: (g) => useLibrary.getState().upsertGeneration(g),
        select: (id) => useUI.getState().selectGen(id),
        onDone,
        setBusy,
        setError,
      },
    );

  if (!defaults) return <JobLoading error={error} />;

  const modelOptions = (defaults.model_presets ?? []).map((p) => ({
    value: p.id,
    label: `${p.label} — ${p.hint}`,
  }));
  const multOptions = (defaults.multiplier_presets ?? []).map((p) => ({
    value: String(p.multiplier),
    label: `${p.label} — ${p.hint}`,
  }));
  const fps = defaults.source_fps || defaults.asset.fps || 24;
  const duration = defaults.asset.duration ?? defaults.frames / fps;
  const outFps = Math.round(fps * multiplier);

  return (
    <div className="space-y-5 p-5">
      <p className="-mt-1 text-xs leading-relaxed text-muted">
        Вставляет промежуточные кадры и поднимает FPS (разрешение не меняется). RIFE быстрее; FILM — аккуратнее на
        сложном движении. Звук сохраняется.
      </p>

      <AssetPreviewCard
        asset={defaults.asset}
        frames={defaults.frames}
        durationSec={duration}
        extra={` · ${Math.round(fps)} → ${outFps} к/с`}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <SectionTitle>Модель</SectionTitle>
          <Select
            value={model}
            onChange={(v) => setModel(v as "rife" | "film")}
            options={modelOptions.length ? modelOptions : [{ value: "rife", label: "Быстро (RIFE)" }]}
            defaultValue="rife"
          />
        </div>
        <div>
          <SectionTitle>Множитель</SectionTitle>
          <Select
            value={String(multiplier)}
            onChange={(v) => setMultiplier(Number(v))}
            options={multOptions.length ? multOptions : [{ value: "2", label: "×2" }]}
            defaultValue="2"
          />
        </div>
      </div>

      <ModelEstimateLine
        modelLabel={defaults.model_path ? fileName(defaults.model_path) : "модель не найдена"}
        estimate={estimate}
      />
      {error && <ErrorMessage text={error} />}

      <JobFooter
        onCancel={onDone}
        onSubmit={submit}
        busy={busy}
        estimate={estimate}
        label="Интерполировать"
        icon={<Gauge size={15} />}
      />
    </div>
  );
}
