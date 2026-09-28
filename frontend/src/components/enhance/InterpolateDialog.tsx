import { Gauge } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError, urls } from "../../api/client";
import type { InterpolateDefaults, Estimate } from "../../api/types";
import { estimateBasis, fileName, fmtEstimate, fmtSeconds } from "../../lib/format";
import { useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { Button, Dialog, ErrorMessage, SectionTitle, Select, Spinner } from "../ui";

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

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const g = await api.interpolate({
        source_asset_id: assetId,
        model,
        multiplier,
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

  const modelOptions = (defaults.model_presets ?? []).map((p) => ({
    value: p.id,
    label: `${p.label} — ${p.hint}`,
  }));
  const multOptions = (defaults.multiplier_presets ?? []).map((p) => ({
    value: String(p.multiplier),
    label: `${p.label} — ${p.hint}`,
  }));
  const modelLabel = defaults.model_path ? fileName(defaults.model_path) : "модель не найдена";
  const fps = defaults.source_fps || defaults.asset.fps || 24;
  const duration = defaults.asset.duration ?? defaults.frames / fps;
  const outFps = Math.round(fps * multiplier);

  return (
    <div className="space-y-5 p-5">
      <p className="-mt-1 text-xs leading-relaxed text-muted">
        Вставляет промежуточные кадры и поднимает FPS (разрешение не меняется). RIFE быстрее; FILM — аккуратнее на
        сложном движении. Звук сохраняется.
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
            {` · ${Math.round(fps)} → ${outFps} к/с`}
          </p>
        </div>
      </div>

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
          {busy ? <Spinner /> : <Gauge size={15} />} Интерполировать
        </Button>
      </div>
    </div>
  );
}
