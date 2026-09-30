import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { MaskLayer, MaskSelection } from "../../api/types";
import { stageInfo } from "../../lib/stages";
import { useLibrary } from "../../store/library";
import { Button, ErrorMessage } from "../ui";

export type PointMode = "positive" | "negative" | null;
export function MaskTrackingControls({ assetId, start, end, selection, onSelection, mode, onMode, jobId, onJob, appliedJobId, layers, onResult }: {
  assetId: number; start: number; end: number; selection: MaskSelection; onSelection: (selection: MaskSelection) => void;
  mode: PointMode; onMode: (mode: PointMode) => void; jobId?: number; onJob: (id: number) => void;
  appliedJobId?: number; layers: MaskLayer[]; onResult: (layers: MaskLayer[], id: number) => void;
}) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const job = useLibrary((s) => jobId ? s.generations[jobId] : undefined);
  const pending = job?.status === "queued" || job?.status === "running";
  useEffect(() => { api.maskTrackStatus().then((s) => setAvailable(s.available)).catch((e) => setError(String(e))); }, []);
  useEffect(() => {
    const result = job?.info?.mask;
    if (job?.status !== "done" || !result || appliedJobId === job.id) return;
    if (layers.some((l) => l.kind === "auto" && l.track_generation_id === job.id)) { onResult(layers, job.id); return; }
    if (!result.hit) { setError("Объект не найден. Поставьте зелёную точку внутри него и повторите трекинг."); return; }
    // Keep hand-drawn corrections while replacing the previous automatic result.
    const manual = layers.filter((l) => l.kind !== "auto");
    if (manual.length >= 16) { setError("Удалите одну ручную область, чтобы добавить маску SAM."); return; }
    onResult([{ kind: "auto", result: result.file, track_generation_id: job.id, visible: true, mode: "add" }, ...manual], job.id);
    onMode(null);
  }, [job, appliedJobId, layers, onResult, onMode]);
  const track = async () => {
    setBusy(true); setError("");
    try {
      const created = await api.maskTrack({ source_asset_id: assetId, start, end, text: selection.text,
        points: selection.points.filter((p) => p.time >= start && p.time < end) });
      useLibrary.getState().upsertGeneration(created); onJob(created.id);
    } catch (e) { setError(e instanceof Error ? e.message : "Не удалось запустить SAM"); }
    finally { setBusy(false); }
  };
  const count = selection.points.reduce((n, p) => n + p.positive.length + p.negative.length, 0);
  const needsPositive = selection.points.some((p) => p.time >= start && p.time < end && p.negative.length && !p.positive.length);
  const trackStart = Number(job?.full_params?.start ?? 0), trackEnd = Number(job?.full_params?.end ?? end);
  return <div className="space-y-2 rounded-lg border border-line bg-raised/40 p-3">
    <div className="flex flex-wrap items-center gap-2 text-xs"><span className="font-medium text-fg">Автоматическая маска · SAM</span>
      <Button size="sm" variant={mode === "positive" ? "subtle" : "ghost"} onClick={() => onMode(mode === "positive" ? null : "positive")}>+ Объект</Button>
      <Button size="sm" variant={mode === "negative" ? "subtle" : "ghost"} onClick={() => onMode(mode === "negative" ? null : "negative")}>− Исключить</Button>
      {!!count && <Button size="sm" onClick={() => onSelection({ ...selection, points: [] })}>Очистить точки</Button>}
    </div>
    <p className="text-[11px] text-muted">Нажмите «+ Объект» и щёлкните внутри объекта на кадре ниже. Красные точки исключают фон. Для уточнения добавьте точки на других кадрах.</p>
    <input aria-label="Объект для SAM" value={selection.text} onChange={(e) => onSelection({ ...selection, text: e.target.value })} className="w-full rounded border border-line bg-panel px-2 py-1.5 text-xs" placeholder="Можно также указать объект по-английски: person, car…" maxLength={500} />
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Button size="sm" onClick={() => void track()} disabled={available !== true || busy || pending || needsPositive || (!selection.text.trim() && !selection.points.some((p) => p.time >= start && p.time < end && p.positive.length))}>Выделить и отследить</Button>
      {pending && <><span className="text-muted">{job.status === "queued" ? "В очереди" : stageInfo(job.stage, job).label}{job.progress > 0 ? ` · ${Math.round(job.progress * 100)}%` : ""}</span><Button size="sm" onClick={() => void api.cancel(job.id).catch((e) => setError(String(e)))}>Остановить</Button></>}
      {job?.status === "done" && job.info?.mask && <span className="text-muted">Объект найден: {job.info.mask.hit} / {job.info.mask.frames} кадров</span>}
    </div>
    {needsPositive && <p className="text-[11px] text-warn">На кадре с красными точками добавьте зелёную точку внутри объекта.</p>}
    {job?.status === "done" && (start < trackStart - 0.001 || end > trackEnd + 0.001) && <p className="text-[11px] text-warn">Фрагмент расширен. Повторите трекинг: за пределами {trackStart.toFixed(2)}–{trackEnd.toFixed(2)} с маска SAM пуста.</p>}
    {available === false && <ErrorMessage text="Модель SAM не найдена. Добавьте SAM 3 или SAM 3.1 в папку sam3 движка." />}
    {(error || job?.status === "error" && job.error) && <ErrorMessage text={error || job?.error || "Не удалось отследить объект"} />}
  </div>;
}
