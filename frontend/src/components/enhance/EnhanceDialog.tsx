import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { EnhanceDefaults, Estimate } from "../../api/types";
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
 * SeedVR2 post-enhance on a finished clip: restore detail (and optional upscale).
 * Default Refine ×1 + soft blend — pure SeedVR overcooks already-sharp MiniMax clips.
 */
export function EnhanceDialog() {
  const state = useUI((s) => s.enhanceDialog);
  const close = () => useUI.getState().openEnhanceDialog(null);
  return (
    <Dialog open={state !== null} onOpenChange={(o) => !o && close()} title="Детализация">
      {state && (
        <EnhanceForm
          key={`${state.assetId}-${state.fromGenerationId ?? ""}`}
          assetId={state.assetId}
          fromGenerationId={state.fromGenerationId}
          onDone={close}
        />
      )}
    </Dialog>
  );
}

function EnhanceForm({
  assetId,
  fromGenerationId,
  onDone,
}: {
  assetId: number;
  fromGenerationId?: number;
  onDone: () => void;
}) {
  const fromGen = useLibrary((s) => (fromGenerationId ? s.generations[fromGenerationId] : undefined));
  const [defaults, setDefaults] = useState<EnhanceDefaults | null>(null);
  const [scale, setScale] = useState(1);
  const [strength, setStrength] = useState(0.55);
  const [color, setColor] = useState("lab");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [estimate, setEstimate] = useState<Estimate | null>(null);

  useEffect(() => {
    api
      .enhanceDefaults(assetId)
      .then((d) => {
        setDefaults(d);
        const p = fromGen?.ui_params;
        setScale(typeof p?.scale === "number" ? p.scale : d.scale);
        setStrength(typeof p?.strength === "number" ? p.strength : d.strength);
        setColor(typeof p?.color_correction === "string" ? p.color_correction : d.color_correction);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Не удалось открыть клип"));
  }, [assetId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!defaults) return;
    api.enhanceEstimate(assetId, scale).then(setEstimate).catch(() => setEstimate(null));
  }, [assetId, scale, defaults]);

  const submit = () =>
    runAssetJob(
      () =>
        api.enhance({
          source_asset_id: assetId,
          scale,
          strength,
          color_correction: color as "lab" | "wavelet" | "adain" | "none",
          seed: fromGen?.seed ?? null,
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

  const scaleOptions = (defaults.scale_presets ?? []).map((p) => ({
    value: String(p.scale),
    label: `${p.label} — ${p.hint}`,
  }));
  const strengthOptions = (defaults.strength_presets ?? []).map((p) => ({
    value: String(p.strength),
    label: `${p.label} — ${p.hint}`,
  }));
  const colorOptions = (defaults.color_presets ?? []).map((p) => ({
    value: p.id,
    label: `${p.label} — ${p.hint}`,
  }));
  const fps = defaults.asset.fps || 24;
  const duration = defaults.asset.duration ?? defaults.frames / fps;

  return (
    <div className="space-y-5 p-5">
      <p className="-mt-1 text-xs leading-relaxed text-muted">
        SeedVR2 подчищает и добавляет реализм. По умолчанию — Refine ×1 и сила «Естественно»
        (подмешивание исходника), чтобы не пережечь уже резкий клип MiniMax. Звук сохраняется.
      </p>

      <AssetPreviewCard asset={defaults.asset} frames={defaults.frames} durationSec={duration} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <SectionTitle>Масштаб</SectionTitle>
          <Select
            value={String(scale)}
            onChange={(v) => setScale(Number(v))}
            options={scaleOptions.length ? scaleOptions : [{ value: "1", label: "Refine ×1" }]}
            defaultValue="1"
          />
        </div>
        <div>
          <SectionTitle>Сила</SectionTitle>
          <Select
            value={String(strength)}
            onChange={(v) => setStrength(Number(v))}
            options={strengthOptions.length ? strengthOptions : [{ value: "0.55", label: "Естественно" }]}
            defaultValue="0.55"
          />
        </div>
      </div>

      <div>
        <SectionTitle>Цвет</SectionTitle>
        <Select
          value={color}
          onChange={setColor}
          options={colorOptions.length ? colorOptions : [{ value: "lab", label: "Цвет LAB" }]}
          defaultValue="lab"
        />
      </div>

      <ModelEstimateLine modelLabel={defaults.unet ? fileName(defaults.unet) : "модель не найдена"} estimate={estimate} />
      {error && <ErrorMessage text={error} />}

      <JobFooter
        onCancel={onDone}
        onSubmit={submit}
        busy={busy}
        estimate={estimate}
        label="Детализировать"
        icon={<Sparkles size={15} />}
      />
    </div>
  );
}
