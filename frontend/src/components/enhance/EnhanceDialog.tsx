import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError, urls } from "../../api/client";
import type { EnhanceDefaults, Estimate } from "../../api/types";
import { estimateBasis, fileName, fmtEstimate, fmtSeconds } from "../../lib/format";
import { useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { Button, Dialog, ErrorMessage, SectionTitle, Select, Spinner } from "../ui";

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

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const g = await api.enhance({
        source_asset_id: assetId,
        scale,
        strength,
        color_correction: color as "lab" | "wavelet" | "adain" | "none",
        seed: fromGen?.seed ?? null,
      });
      useLibrary.getState().upsertGeneration(g);
      useUI.getState().selectGen(g.id);
      onDone();
    } catch (e) {
      if (e instanceof ApiError && typeof e.detail === "object" && e.detail && (e.detail as { kind?: string }).kind === "missing_file") {
        useUI.getState().toast(e.message, "bad");
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!defaults) {
    return (
      <div className="flex h-48 items-center justify-center gap-2 text-muted">
        {error ? <ErrorMessage text={error} /> : <><Spinner /> Готовлю клип…</>}
      </div>
    );
  }

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
  const modelLabel = defaults.unet ? fileName(defaults.unet) : "модель не найдена";
  const fps = defaults.asset.fps || 24;
  const duration = defaults.asset.duration ?? defaults.frames / fps;

  return (
    <div className="space-y-5 p-5">
      <p className="-mt-1 text-xs leading-relaxed text-muted">
        SeedVR2 подчищает и добавляет реализм. По умолчанию — Refine ×1 и сила «Естественно»
        (подмешивание исходника), чтобы не пережечь уже резкий клип MiniMax. Звук сохраняется.
      </p>

      <div className="flex items-center gap-3 rounded-xl border border-line bg-raised/40 p-2.5">
        {defaults.asset.thumb && (
          <img src={urls.assetThumb(defaults.asset.id)} alt="" className="h-12 w-20 rounded object-cover" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px]">{defaults.asset.name}</p>
          <p className="text-[11px] text-faint tabular-nums">
            {defaults.frames} кадров · {fmtSeconds(duration)}
            {defaults.asset.width && defaults.asset.height
              ? ` · ${defaults.asset.width}×${defaults.asset.height}`
              : ""}
          </p>
        </div>
      </div>

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

      <p className="text-[11px] text-faint">
        Модель: {modelLabel}
        {estimate ? (
          <>
            {" · "}
            <span title={estimateBasis(estimate)}>{fmtEstimate(estimate.seconds)}</span>
          </>
        ) : null}
      </p>

      {error && <ErrorMessage text={error} />}

      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <Button variant="ghost" onClick={onDone} disabled={busy}>
          Отмена
        </Button>
        <Button variant="primary" size="lg" onClick={submit} disabled={busy} title={estimateBasis(estimate)}>
          {busy ? <Spinner /> : <Sparkles size={15} />} Детализировать
        </Button>
      </div>
    </div>
  );
}
