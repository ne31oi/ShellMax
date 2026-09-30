import { ArrowLeft, ArrowRight, Crop, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, urls } from "../../api/client";
import type { RefModRevisionDefaults, Upload } from "../../api/types";
import { uploadFiles } from "../../lib/actions";
import { reportJobError } from "../../lib/errors";
import { useForm } from "../../store/form";
import { useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { Button, Dialog, ErrorMessage, Select, Spinner, Switch } from "../ui";
import { MediaRefEditor } from "./MediaRefEditor";
import { RefModBudget, tokenLabel } from "./RefModBudget";

/** A revision rebuilds selected originals through the existing frozen create recipe. */
export function RefModEditor({ file, onDone }: { file: string; onDone: () => void }) {
  const [defaults, setDefaults] = useState<RefModRevisionDefaults>();
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState("Compressed Reference");
  const [audio, setAudio] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cropIndex, setCropIndex] = useState<number | null>(null);
  const [jobId, setJobId] = useState<number>();
  const [result, setResult] = useState<Upload[]>();
  const input = useRef<HTMLInputElement>(null);
  const job = useLibrary((s) => jobId ? s.generations[jobId] : undefined);
  const pending = job?.status === "queued" || job?.status === "running";
  const locked = busy || pending || job?.status === "done";

  useEffect(() => {
    let cancelled = false;
    void api.refmodEditDefaults(file).then((data) => {
      if (cancelled) return;
      setDefaults(data); setUploads(data.uploads); setName(data.item.label);
      setDescription(data.item.desc); setMode(data.mode); setAudio(data.include_audio);
    }).catch((e) => { if (!cancelled) reportJobError(e, setError); });
    return () => { cancelled = true; };
  }, [file]);
  useEffect(() => {
    if (job?.status !== "done" || !job.info?.refmods?.length) return;
    let cancelled = false;
    void Promise.all(job.info.refmods.map((member) => api.useRefmod(member))).then((data) => {
      if (!cancelled) setResult(data);
    }).catch((e) => { if (!cancelled) reportJobError(e, setError); });
    return () => { cancelled = true; };
  }, [job?.status, job?.info?.refmods]);

  const addFiles = async (files: File[]) => {
    setBusy(true); setError("");
    try { const added = await uploadFiles(files); setUploads((old) => [...old, ...added]); }
    catch (e) { reportJobError(e, setError); }
    finally { setBusy(false); }
  };
  const move = (index: number, delta: number) => setUploads((old) => {
    const next = [...old]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; return next;
  });
  const save = async () => {
    setBusy(true); setError("");
    try {
      const generation = await api.editRefmod({ source_refmod_file: file, upload_ids: uploads.map((up) => up.id),
        name: name.trim(), description, mode, include_audio: audio, profile_id: useForm.getState().profileId });
      useLibrary.getState().upsertGeneration(generation); setJobId(generation.id);
    } catch (e) { reportJobError(e, setError); }
    finally { setBusy(false); }
  };
  const apply = () => {
    if (!result || !defaults) return;
    const channels = [defaults.item.visual, defaults.item.audio].filter(Boolean);
    const originals = new Set(channels.map((channel) => channel!.file));
    const selected = useForm.getState().refs.filter((ref) => originals.has(ref.upload.refmod_file ?? ""));
    for (const ref of selected) {
      const replacement = result.find((up) => (up.kind === "audio") === (ref.upload.kind === "audio"));
      if (replacement) useForm.getState().replaceRefUpload(ref.uid, replacement);
      else useForm.getState().removeRef(ref.uid);
    }
    useUI.getState().toast(selected.length ? "Новая версия применена к выбранным референсам" : "Новая версия сохранена в библиотеке RefMods", "ok");
    onDone();
  };

  if (!defaults) return <div className="p-5">{error ? <ErrorMessage text={error} /> : <Spinner />}</div>;
  return <div className="space-y-4 p-5">
    <p className="text-xs text-muted">Измените исходники и сохраните новую версию. RefMod будет собран заново; исходная версия и фото сохранятся. После сборки выбранные карточки можно заменить, сохранив ссылки в промпте.</p>
    <RefModBudget limits={defaults.limits} showCreation />
    <p className="text-xs text-muted">Текущая версия: {[defaults.item.visual && `внешность — ${tokenLabel(defaults.item.visual.tokens)}`, defaults.item.audio && `голос — ${tokenLabel(defaults.item.audio.tokens)}`].filter(Boolean).join(" · ")}. Точное число токенов новой версии появится после сборки.</p>
    <label className="block space-y-1 text-xs text-muted">Название
      <input aria-label="Название новой версии" disabled={locked} className="w-full rounded border border-line bg-raised px-3 py-2 text-sm text-fg" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
    </label>
    <label className="block space-y-1 text-xs text-muted">Описание для ассистента
      <textarea aria-label="Описание RefMod" disabled={locked} className="w-full rounded border border-line bg-raised px-3 py-2 text-sm text-fg" value={description} maxLength={2000} rows={2} onChange={(e) => setDescription(e.target.value)} />
    </label>
    {!defaults.has_sources && <ErrorMessage text="Исходники этого RefMod не сохранены в ShellMax. Добавьте исходные файлы, чтобы собрать новую версию; без них существующее содержимое восстановить нельзя." />}
    {defaults.missing_sources > 0 && <p className="text-xs text-warn">Не найдены исходники: {defaults.missing_sources}. В новую версию войдут только файлы ниже.</p>}
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Состав RefMod">
      {uploads.map((upload, index) => <div key={`${index}-${upload.id}`} className="space-y-2 rounded border border-line p-2">
        {upload.kind === "audio" ? <p className="flex h-24 items-center justify-center text-xs text-muted">Аудио</p> : <img className="h-24 w-full rounded object-contain" src={urls.uploadThumb(upload.id)} alt={upload.name || upload.orig_name} />}
        <p className="truncate text-xs" title={upload.name || upload.orig_name}>{index + 1}. {upload.name || upload.orig_name}</p>
        <div className="flex justify-between gap-1">
          <Button size="sm" disabled={locked || index === 0} title="Переместить раньше" onClick={() => move(index, -1)}><ArrowLeft size={12} /></Button>
          <Button size="sm" disabled={locked || index === uploads.length - 1} title="Переместить позже" onClick={() => move(index, 1)}><ArrowRight size={12} /></Button>
          <Button size="sm" disabled={locked} title="Обрезать исходник" onClick={() => setCropIndex(index)}><Crop size={12} /></Button>
          <Button size="sm" disabled={locked} title="Убрать из новой версии" onClick={() => setUploads((old) => old.filter((_, i) => i !== index))}><Trash2 size={12} /></Button>
        </div>
      </div>)}
    </div>
    <input ref={input} type="file" accept="image/*,video/*,audio/*" multiple hidden onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
    <Button disabled={locked || uploads.length >= 15} onClick={() => input.current?.click()}><Plus size={14} /> Добавить исходники</Button>
    {uploads.length > 15 && <ErrorMessage text="В одной версии может быть не больше 15 исходников — уберите лишние." />}
    <Select label="Хранение" value={mode} disabled={locked} onChange={setMode} options={[
      { value: "Compressed Reference", label: "Компактный — меньше памяти" }, { value: "Full Reference", label: "Полный — больше деталей и памяти" }]} />
    <div className="flex items-center gap-2 text-xs"><Switch checked={audio} disabled={locked} onChange={setAudio} label="Добавить голос / звук" /><span>Добавить голос / звук</span></div>
    {error && <ErrorMessage text={error} />}
    {job && <div role="status" className="text-sm">
      {pending ? `Сборка новой версии · ${Math.round(job.progress * 100)}%` : job.status === "error" ? job.error : job.status === "cancelled" ? "Сборка отменена" : "Новая версия готова"}
      {result && <p className="text-xs text-muted">{result.map((up) => `${up.kind === "audio" ? "Голос" : "Внешность"}: ${tokenLabel(up.refmod_tokens)}`).join(" · ")}</p>}
      {pending && <Button size="sm" onClick={() => void api.cancel(job.id)}>Остановить</Button>}
    </div>}
    <div className="flex justify-end gap-2 border-t border-line pt-3">
      <Button onClick={onDone}>{pending ? "Закрыть — сборка продолжится" : "Закрыть"}</Button>
      {job?.status === "done" ? <Button variant="primary" disabled={!result} onClick={apply}>Применить новую версию</Button> :
        <Button variant="primary" disabled={locked || !name.trim() || !uploads.length || uploads.length > 15} onClick={() => void save()}>{busy && <Spinner />} Сохранить новую версию</Button>}
    </div>
    <Dialog open={cropIndex != null} onOpenChange={(open) => !open && setCropIndex(null)} title="Изменить исходник RefMod" wide>
      {cropIndex != null && uploads[cropIndex] && <MediaRefEditor key={uploads[cropIndex].id} upload={uploads[cropIndex]}
        onApply={(upload) => setUploads((old) => old.map((up, index) => index === cropIndex ? upload : up))} onDone={() => setCropIndex(null)} />}
    </Dialog>
  </div>;
}
