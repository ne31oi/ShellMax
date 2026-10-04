import { PersonStanding } from "lucide-react";
import { useEffect, useState } from "react";
import { api, urls } from "../../api/client";
import type { BodySwapUIParams } from "../../api/types";
import { useLibrary } from "../../store/library";
import { useForm } from "../../store/form";
import { useUI } from "../../store/ui";
import { JobFooter, JobLoading, PostProcessDialogShell, useAssetJobForm } from "../jobs/PostProcessShell";
import { ErrorMessage, SectionTitle, Select } from "../ui";
import { BodySwapPhotos } from "./BodySwapPhotos";

export function BodySwapDialog() {
  const state = useUI((s) => s.bodySwapDialog);
  const close = () => useUI.getState().openBodySwapDialog(null);
  return <PostProcessDialogShell open={state !== null} title="Заменить персонажа · Body Swap" onClose={close} wide>
    {state && <BodySwapForm key={`${state.assetId}-${state.fromGenerationId ?? ""}`} {...state} onDone={close} />}
  </PostProcessDialogShell>;
}

function BodySwapForm({ assetId, fromGenerationId, onDone }: {
  assetId: number; fromGenerationId?: number; onDone: () => void;
}) {
  const form = useAssetJobForm(assetId, api.bodySwapDefaults);
  const [initial] = useState(() => {
    const previous = fromGenerationId ? useLibrary.getState().generations[fromGenerationId] : null;
    return (previous?.ui_params as unknown as BodySwapUIParams | undefined) ?? useForm.getState().bodySwapDrafts[assetId];
  });
  const [photos, setPhotos] = useState<[string, string]>(() => initial
    ? [initial.front_upload_id, initial.side_upload_id] : useForm.getState().bodySwapPhotoIds);
  const [start, setStart] = useState(initial?.start ?? 0);
  const [end, setEnd] = useState(initial?.end ?? 0);
  const [subject, setSubject] = useState(initial?.subject ?? "person");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [variant, setVariant] = useState<"ref2va" | "singularity">(initial?.variant ?? "ref2va");
  const d = form.defaults;
  useEffect(() => {
    if (!d || initial) return;
    setEnd(Math.min(d.asset.duration ?? 0, d.max_duration));
  }, [d, initial]);
  useEffect(() => {
    if (!d || end <= start) return;
    const draft: BodySwapUIParams = { source_asset_id: assetId, front_upload_id: photos[0], side_upload_id: photos[1],
      start, end, subject, description, variant, seed: initial?.seed ?? null };
    const f = useForm.getState();
    f.set({ bodySwapDrafts: { ...f.bodySwapDrafts, [assetId]: draft }, bodySwapPhotoIds: photos });
  }, [assetId, d, start, end, photos, subject, description, variant, initial]);
  if (!d) return <JobLoading error={form.error} />;
  const readiness = d.variants?.[variant] ?? d;
  const count = Math.floor((end - start) * 24 + 1e-6);
  const frames = count < 5 ? 0 : Math.min(175, 5 + Math.floor((count - 5) / 17) * 17);
  const valid = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= (d.asset.duration ?? 0) + 1e-6
    && end > start && end - start <= d.max_duration + 1e-6 && frames >= 5;
  const submit = () => {
    void form.submit(() => api.bodySwap({ source_asset_id: assetId, front_upload_id: photos[0], side_upload_id: photos[1],
      start, end, subject, description, variant, seed: initial?.seed ?? null }), {
      upsert: (g) => useLibrary.getState().upsertGeneration(g), select: (id) => useUI.getState().selectGen(id), onDone,
    });
  };
  return <div className="space-y-4 p-5">
    <p className="text-xs leading-relaxed text-muted">Меняет лицо, волосы, тело и одежду по двум фотографиям.
      Поза и движения задаются исходным видео; кисти перерисовываются вместе с телом, звук сохраняется.
      Размер и положение головы привязываются к исходнику, свет подстраивается под сцену.
      Освободившийся фон восстанавливается из соседних пикселей. Для клипа с одним хорошо видимым человеком.</p>
    <div className="grid gap-5 md:grid-cols-2">
      <section className="space-y-3"><SectionTitle>Исходный клип</SectionTitle>
        <video src={urls.assetFile(assetId)} controls preload="metadata" className="max-h-56 w-full rounded-xl bg-raised" />
        <p className="truncate text-xs" title={d.asset.name}>{d.asset.name}</p>
        <div className="flex gap-3">
          <label className="flex-1 text-[11px] text-muted">Начало, с
            <input aria-label="Начало фрагмента" type="number" min={0} max={d.asset.duration ?? 0} step={1 / 24} value={start}
              onChange={(e) => setStart(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-line bg-raised px-2 py-1.5 text-fg" />
          </label>
          <label className="flex-1 text-[11px] text-muted">Конец, с
            <input aria-label="Конец фрагмента" type="number" min={0} max={d.asset.duration ?? 0} step={1 / 24} value={end}
              onChange={(e) => setEnd(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-line bg-raised px-2 py-1.5 text-fg" />
          </label>
        </div>
        <p className="text-[11px] text-faint">До 7,29 с за один проход. Результат: {frames} кадров · {(frames / 24).toFixed(2)} с · 24 fps · до 1024 px.
          {valid && <span> Конец результата: {(start + frames / 24).toFixed(2)} с исходника.</span>}</p>
        {!valid && <ErrorMessage text="Выберите фрагмент внутри клипа: от 5 кадров до 7,29 секунды." />}
      </section>
      <section><SectionTitle>Новый персонаж</SectionTitle>
        <BodySwapPhotos value={photos} onChange={setPhotos} disabled={form.busy} />
      </section>
    </div>
    <details className="rounded-lg border border-line p-3 text-xs">
      <summary className="cursor-pointer text-muted">Уточнить персонажа и одежду</summary>
      <div className="mt-3">
        <Select label="Модель замены" value={variant} disabled={form.busy}
          onChange={(v) => setVariant(v as "ref2va" | "singularity")} options={[
            {value:"ref2va", label:"Ref2VA"}, {value:"singularity", label:"Singularity v1.3"},
          ]} />
        <p className="mt-1 text-faint">Полная замена с учётом позы и фона. Детали лица берутся с портрета. Модель можно сменить для сравнения.</p>
      </div>
      <label className="mt-3 block text-[11px] text-muted">Кого выделить в исходнике · коротко по-английски
        <input value={subject} maxLength={160} aria-label="Кого заменить" onChange={(e) => setSubject(e.target.value)}
          className="mt-1 w-full rounded-lg border border-line bg-raised px-2 py-1.5 text-fg" placeholder="person" />
      </label>
      <label className="mt-3 block text-[11px] text-muted">Дополнительное описание нового персонажа · по-английски
        <textarea value={description} maxLength={4000} aria-label="Описание нового персонажа" onChange={(e) => setDescription(e.target.value)}
          className="mt-1 min-h-20 w-full rounded-lg border border-line bg-raised p-2 text-fg" placeholder="Обычно достаточно фотографий" />
      </label>
    </details>
    <p className="text-[11px] text-faint">Экспериментальный режим. Заменяется весь персонаж, включая кисти; лицо и одежда подстраиваются под свет сцены.
      Сложные перекрытия и смена силуэта требуют проверки. Видео создаётся отдельным файлом.</p>
    {!readiness.ready && <ErrorMessage text={`Не установлены модели Body Swap: ${readiness.missing.join(", ")}. Установка описана в README.`} />}
    {form.error && <ErrorMessage text={form.error} />}
    <JobFooter onCancel={onDone} onSubmit={submit} busy={form.busy} disabled={!readiness.ready || !valid || !photos[0] || !photos[1] || !subject.trim()}
      estimate={null} label="Заменить персонажа" icon={<PersonStanding size={15} />} />
  </div>;
}
