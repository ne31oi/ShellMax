import { AudioLines, BookOpen } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, urls } from "../../api/client";
import type { RefKind, Upload } from "../../api/types";
import { useForm } from "../../store/form";
import { Button, Popover, Select } from "../ui";

const categories: { value: Upload["category"]; label: string }[] = [
  { value: "character", label: "Персонаж" }, { value: "location", label: "Локация" },
  { value: "object", label: "Предмет" }, { value: "style", label: "Стиль" },
  { value: "other", label: "Другое" },
];

const label = (u: Upload) => u.name || u.orig_name;
const family = (u: Upload) => u.source_id || u.id;
const usageKinds: Record<string, string> = { plan: "План", clip: "Клип", shot: "Шот", generation: "Генерация" };

export function ReferenceLibrary({ onPick, onSaved, exclude = [], kinds, compact = false }: {
  onPick: (upload: Upload) => Promise<void> | void; onSaved?: (upload: Upload) => void;
  exclude?: string[]; kinds?: RefKind[]; compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Upload["category"] | "all">("all");
  const [selected, setSelected] = useState<Upload | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [editCategory, setEditCategory] = useState<Upload["category"]>("other");
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof api.referenceUsage>>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { if (open) void api.listUploads().then(setUploads).catch((e) => setError(String(e))); }, [open]);
  const visible = useMemo(() => uploads.filter((u) => {
    if (kinds && !kinds.includes(u.kind)) return false;
    if (category !== "all" && u.category !== category) return false;
    const q = query.trim().toLocaleLowerCase();
    return !q || `${u.name} ${u.orig_name} ${u.description}`.toLocaleLowerCase().includes(q);
  }), [uploads, query, category, kinds]);

  const inspect = (u: Upload) => {
    setSelected(u); setName(u.name); setDescription(u.description); setEditCategory(u.category); setUsage([]); setError("");
    void api.referenceUsage(u.id).then(setUsage).catch((e) => setError(String(e)));
  };
  const save = async () => {
    if (!selected || !name.trim()) return;
    setBusy(true); setError("");
    try {
      const updated = await api.updateReference(selected.id, { name: name.trim(), category: editCategory, description });
      const root = family(updated);
      const patch = (u: Upload) => family(u) === root ? { ...u, name: updated.name, category: updated.category, description: updated.description } : u;
      setUploads((list) => list.map(patch));
      setSelected(patch(selected));
      onSaved?.(updated);
      const form = useForm.getState();
      form.set({ refs: form.refs.map((r) => ({ ...r, upload: patch(r.upload) })),
        recentRefs: Object.fromEntries(Object.entries(form.recentRefs).map(([kind, list]) => [kind, list.map(patch)])) as typeof form.recentRefs });
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const pick = async () => {
    if (!selected) return;
    setBusy(true); setError("");
    try { await onPick(selected); setOpen(false); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  return <Popover open={open} onOpenChange={setOpen} align="start" side="bottom" className="w-[min(640px,90vw)] p-3"
    trigger={<button type="button" title="Библиотека референсов" className={compact
      ? "flex h-[76px] w-[52px] items-center justify-center rounded-lg border border-dashed border-line-strong text-muted hover:text-fg"
      : "flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-line-strong px-2.5 text-xs text-muted hover:text-fg"}>
      <BookOpen size={compact ? 18 : 14} />{!compact && "Библиотека"}
    </button>}>
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-2">
        <input className="w-full rounded-lg border border-line bg-raised p-2 text-xs" placeholder="Поиск по имени и описанию" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Select label="Категория" value={category} options={[{ value: "all", label: "Все" }, ...categories]} onChange={(v) => setCategory(v as typeof category)} />
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {visible.map((u) => <button key={u.id} type="button" onClick={() => inspect(u)} className={`flex w-full items-center gap-2 rounded-lg p-1.5 text-left text-xs ${selected?.id === u.id ? "bg-accent/15 ring-1 ring-accent" : "hover:bg-hover"}`}>
            {u.kind === "audio" ? <AudioLines size={28} className="m-2" /> : <img src={urls.uploadThumb(u.id)} alt="" className="h-10 w-10 rounded object-cover" />}
            <span className="min-w-0"><span className="block truncate font-medium">{label(u)}</span><span className="block truncate text-[10px] text-faint">{u.orig_name}</span></span>
          </button>)}
          {!visible.length && <p className="p-2 text-xs text-faint">Референсы не найдены</p>}
        </div>
      </div>
      {selected ? <div className="space-y-2 text-xs">
        <p className="font-medium">Карточка референса</p>
        <input className="w-full rounded-lg border border-line bg-raised p-2" aria-label="Имя референса" placeholder="Имя: кто или что на референсе" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        <Select label="Тип" value={editCategory} options={categories} onChange={(v) => setEditCategory(v as Upload["category"])} />
        <textarea className="w-full rounded-lg border border-line bg-raised p-2" aria-label="Описание референса" placeholder="Краткое описание" rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy || !name.trim()} onClick={() => void save()}>Сохранить имя</Button>
          <Button size="sm" disabled={busy || exclude.includes(selected.id) || exclude.includes(family(selected))} onClick={() => void pick()}>{exclude.includes(selected.id) || exclude.includes(family(selected)) ? "Уже добавлен" : "Добавить"}</Button></div>
        <div><p className="font-medium">Где используется</p>{usage.length ? <ul className="mt-1 max-h-28 overflow-y-auto text-muted">{usage.map((item, i) => <li key={i}>{item.project} · {usageKinds[item.kind] || item.kind}: {item.label}</li>)}</ul> : <p className="mt-1 text-faint">Пока нигде</p>}</div>
      </div> : <p className="self-center text-center text-xs text-faint">Выберите референс, чтобы дать ему имя или добавить в проект</p>}
    </div>
    {error && <p role="alert" className="mt-2 text-xs text-bad">{error}</p>}
  </Popover>;
}
