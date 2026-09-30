import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { RefModEntry, RefModLimits } from "../../api/types";
import { addUploadsAsRefs } from "../../lib/actions";
import { reportJobError } from "../../lib/errors";
import { useForm } from "../../store/form";
import { useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { Button, Dialog, ErrorMessage, Select, Spinner, Switch } from "../ui";
import { RefModEditor } from "./RefModEditor";
import { RefModBudget, tokenLabel } from "./RefModBudget";

export function RefModLibrary() {
  const open = useUI((s) => s.refmodsOpen);
  return <Dialog open={open} onOpenChange={(value) => useUI.getState().openRefmods(value)} title="RefMods — готовые референсы" wide>
    {open && <RefModContent />}
  </Dialog>;
}

function RefModContent() {
  const [items, setItems] = useState<RefModEntry[]>([]);
  const [limits, setLimits] = useState<RefModLimits>();
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const refs = useForm((s) => s.refs);
  const picked = new Set(refs.map((r) => r.upload.refmod_file).filter(Boolean));
  const mode = useForm((s) => s.refmodMode);
  const audio = useForm((s) => s.refmodAudio);
  const job = useLibrary((s) => jobId ? s.generations[jobId] : undefined);
  const [selected, setSelected] = useState<string[]>(() => refs.filter((r) => !r.upload.refmod_file).map((r) => r.upload.id));
  const refresh = () => { setError(""); return api.refmods().then((data) => { setItems(data.items); setLimits(data.limits); }).catch((e) => reportJobError(e, setError)); };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { if (job?.status === "done") { void refresh(); setCreating(false); } }, [job?.status]);

  const pick = async (file: string) => {
    setBusy(true);
    try {
      if (useForm.getState().refs.some((r) => r.upload.refmod_file === file)) return;
      const upload = await api.useRefmod(file);
      addUploadsAsRefs([upload]);
      if (useForm.getState().refs.some((r) => r.upload.refmod_file === file)) {
        useUI.getState().toast("RefMod добавлен к референсам — нажмите «В промпт», чтобы учесть его", "ok");
      }
    }
    catch (e) { reportJobError(e, setError); }
    finally { setBusy(false); }
  };
  const create = async () => {
    setBusy(true); setError("");
    try {
      const g = await api.createRefmod({ upload_ids: selected, name: name.trim(), mode, include_audio: audio,
        description: name.trim(), profile_id: useForm.getState().profileId });
      useLibrary.getState().upsertGeneration(g); setJobId(g.id);
    } catch (e) { reportJobError(e, setError); }
    finally { setBusy(false); }
  };
  const remove = async (file: string) => {
    setBusy(true); setError("");
    try {
      const removed = await api.deleteRefmod(file);
      const deleted = new Set(removed.files);
      const current = useForm.getState();
      for (const ref of current.refs) if (deleted.has(ref.upload.refmod_file ?? "")) current.removeRef(ref.uid);
      useForm.getState().set({ recentRefs: Object.fromEntries(Object.entries(useForm.getState().recentRefs)
        .map(([kind, uploads]) => [kind, uploads.filter((up) => !deleted.has(up.refmod_file ?? ""))])) as typeof current.recentRefs });
      setDeleting(null); await refresh();
      useUI.getState().toast("RefMod удалён. Исходные файлы сохранены", "ok");
    } catch (e) { reportJobError(e, setError); }
    finally { setBusy(false); }
  };

  return <div className="space-y-4 p-5">
    <p className="text-xs leading-relaxed text-muted">RefMod сохраняет внешний вид, движение или голос в готовом виде. После создания добавьте его к референсам и нажмите «В промпт». Набор фото получает общую метку Video: ассистент учитывает его как фото внешности, одежды и аксессуаров.</p>
    <RefModBudget limits={limits} showCreation />
    <div className="flex gap-2">
      <input aria-label="Поиск RefMods" className="min-w-0 flex-1 rounded border border-line bg-raised px-3 py-2 text-sm" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск…" />
      <Button onClick={() => void refresh()}>Обновить</Button>
      <Button onClick={() => setCreating(!creating)}>Создать из референсов</Button>
    </div>
    {job && <div role="status" className="rounded border border-line p-3 text-sm">
      {job.status === "done" ? "RefMod создан — добавьте его к референсам для ассистента и генерации" : job.status === "error" ? job.error : job.status === "cancelled" ? "Создание отменено" : `Создание RefMod · ${Math.round(job.progress * 100)}%`}
      {job.status === "done" && job.info?.refmods?.map((file) => <Button key={file} size="sm" disabled={busy || picked.has(file)} onClick={() => void pick(file)}>
        {picked.has(file) ? "Добавлен к референсам" : "Добавить к референсам"}
      </Button>)}
      {(job.status === "running" || job.status === "queued") && <Button onClick={() => void api.cancel(job.id)}>Остановить</Button>}
    </div>}
    {creating && <div className="space-y-3 rounded-xl border border-line bg-raised/40 p-3">
      <input aria-label="Название RefMod" className="w-full rounded border border-line bg-panel px-3 py-2 text-sm" placeholder="Название персонажа, движения или голоса" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="flex flex-wrap gap-2">{refs.filter((r) => !r.upload.refmod_file).map((r) => <label key={r.uid} className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={selected.includes(r.upload.id)} onChange={(e) => setSelected(e.target.checked ? [...new Set([...selected, r.upload.id])] : selected.filter((id) => id !== r.upload.id))} />{r.upload.name || r.upload.orig_name}
      </label>)}</div>
      {!refs.some((r) => !r.upload.refmod_file) && <p className="text-xs text-muted">Сначала добавьте исходные картинки, видео или аудио к референсам.</p>}
      <Select value={mode} onChange={(value) => useForm.getState().set({ refmodMode: value })} options={[
        { value: "Compressed Reference", label: "Компактный — меньше памяти (по умолчанию)" },
        { value: "Full Reference", label: "Полный — больше деталей и памяти" }]} />
      <div className="flex items-center gap-2 text-xs"><Switch checked={audio} onChange={(value) => useForm.getState().set({ refmodAudio: value })} label="Добавить голос / звук" /><span>Добавить голос / звук</span></div>
      <Button variant="primary" disabled={busy || !name.trim() || !selected.length || job?.status === "running" || job?.status === "queued"} onClick={() => void create()}>{busy ? <Spinner /> : null} Создать RefMod</Button>
    </div>}
    {error && <ErrorMessage text={error} />}
    <div className="grid max-h-96 grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3">
      {items.filter((item) => `${item.label} ${item.desc}`.toLowerCase().includes(search.toLowerCase())).map((item) => <div key={item.name} className="space-y-2 rounded-xl border border-line p-2">
        {item.preview ? <img alt="" className="h-24 w-full rounded object-cover" src={`/api/refmods/preview?name=${encodeURIComponent(item.preview)}`} /> : <div className="flex h-24 items-center justify-center rounded bg-raised text-muted">RefMod</div>}
        <p className="truncate text-sm" title={item.label}>{item.label}</p>
        <p className="line-clamp-2 text-[11px] text-muted">{item.desc}</p>
        <p className="text-[11px] text-muted tabular-nums">{[item.visual && `Внешность: ${tokenLabel(item.visual.tokens)}`, item.audio && `Голос: ${tokenLabel(item.audio.tokens)}`].filter(Boolean).join(" · ")}</p>
        {item.visual && <Button size="sm" disabled={busy || picked.has(item.visual.file)} onClick={() => void pick(item.visual!.file)}>
          {picked.has(item.visual.file) ? "Добавлен к референсам" : item.visual.context?.source_kind === "photo_set" ? "Добавить набор фото" : "Добавить внешность"}
        </Button>}
        {item.audio && <Button size="sm" disabled={busy || picked.has(item.audio.file)} onClick={() => void pick(item.audio!.file)}>
          {picked.has(item.audio.file) ? "Добавлен к референсам" : "Добавить голос / звук"}
        </Button>}
        <div className="flex flex-wrap gap-1 border-t border-line pt-2">
          <Button size="sm" disabled={busy} onClick={() => setEditing((item.visual ?? item.audio)!.file)}>Изменить</Button>
          <Button size="sm" disabled={busy || !item.deletable} title={item.deletable ? "Удалить RefMod из библиотеки" : "Файл в основной установке ComfyUI — доступен только для чтения"} onClick={() => setDeleting(item.name)}>Удалить</Button>
        </div>
        {deleting === item.name && <div className="space-y-2 rounded bg-raised p-2 text-xs">
          <p>Удалить «{item.label}» из библиотеки и выбранных референсов? Исходные фото, видео и аудио сохранятся.</p>
          <div className="flex gap-1"><Button size="sm" disabled={busy} onClick={() => void remove((item.visual ?? item.audio)!.file)}>Да, удалить</Button><Button size="sm" disabled={busy} onClick={() => setDeleting(null)}>Отмена</Button></div>
        </div>}
      </div>)}
    </div>
    {!items.length && !error && <p className="text-xs text-muted">Здесь появятся созданные RefMods. Готовые файлы можно положить в папку models/refmods нашего движка.</p>}
    <Dialog open={editing != null} onOpenChange={(open) => { if (!open) { setEditing(null); void refresh(); } }} title="Изменить RefMod" wide>
      {editing && <RefModEditor file={editing} onDone={() => { setEditing(null); void refresh(); }} />}
    </Dialog>
  </div>;
}
