import { BookMarked, RotateCcw, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import { restorePrompt } from "../../lib/actions";
import { capturePrompt, PROMPT_CATEGORIES, type PromptCategory } from "../../lib/prompt-presets";
import { toModelPrompt } from "../../lib/refs";
import { fmtSeconds } from "../../lib/format";
import { flushFormPersist, useForm } from "../../store/form";
import { useUI } from "../../store/ui";
import { Button, Dialog, Select } from "../ui";

export function PromptLibrary({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const library = useForm((s) => s.promptLibrary);
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<PromptCategory>("scene");
  const [filter, setFilter] = useState("all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const visible = library.filter((p) => (!favoritesOnly || p.favorite) && (filter === "all" || p.category === filter)
    && `${p.name} ${toModelPrompt(p.snapshot.prompt, p.snapshot.refs)}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.updated.localeCompare(a.updated));
  const save = async () => {
    const f = useForm.getState();
    if (!name.trim() || !f.prompt.trim()) return;
    if (f.promptLibrary.length >= 100) { setError("В библиотеке уже 100 промптов. Удалите ненужный, прежде чем добавить новый."); return; }
    const preset = { id: crypto.randomUUID(), name: name.trim(), category, favorite: false, updated: new Date().toISOString(), snapshot: capturePrompt(f) };
    setBusy(true);
    f.set({ promptLibrary: [preset, ...f.promptLibrary] });
    setName("");
    setError("");
    try { await flushFormPersist(true); useUI.getState().toast("Промпт и набор референсов добавлены в библиотеку", "ok"); }
    catch { setError("Не удалось сохранить библиотеку. Проверьте соединение с сервером."); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }} title={<span className="flex items-center gap-2"><BookMarked size={17} /> Библиотека промптов</span>} wide>
      <div className="space-y-4">
        <p className="text-xs text-muted">Сохраняются промпт, референсы с обрезками, формат, длительность, качество, подача и стили.</p>
        <div className="rounded-xl border border-line bg-raised p-3">
          <p className="mb-2 text-xs font-semibold">Добавить текущий промпт</p>
          <div className="flex flex-wrap gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Название промпта" aria-label="Название промпта" className="min-w-40 flex-1 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-sm" />
            <div className="w-32"><Select value={category} onChange={(v) => setCategory(v as PromptCategory)} options={Object.entries(PROMPT_CATEGORIES).map(([value, label]) => ({ value, label }))} /></div>
            <Button disabled={busy || !name.trim() || !useForm.getState().prompt.trim()} onClick={() => void save()}>Добавить</Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск по названию и тексту" aria-label="Поиск промптов" className="min-w-40 flex-1 rounded-lg border border-line bg-raised px-2.5 py-1.5 text-sm" />
          <div className="w-32"><Select value={filter} onChange={setFilter} options={[{ value: "all", label: "Все категории" }, ...Object.entries(PROMPT_CATEGORIES).map(([value, label]) => ({ value, label }))]} /></div>
          <Button variant={favoritesOnly ? "subtle" : "ghost"} onClick={() => setFavoritesOnly(!favoritesOnly)} aria-pressed={favoritesOnly}><Star size={14} /> Избранное</Button>
        </div>
        {error && <p className="text-xs text-bad" role="alert">{error}</p>}
        <div className="max-h-[45vh] space-y-2 overflow-y-auto">
          {!visible.length && <p className="py-6 text-center text-sm text-muted">{library.length ? "Нет совпадений" : "Здесь появятся сохранённые промпты"}</p>}
          {visible.map((p) => <div key={p.id} className="rounded-xl border border-line p-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{p.name}</p><p className="mt-0.5 text-[11px] text-faint">{PROMPT_CATEGORIES[p.category]} · {fmtSeconds(p.snapshot.duration)} · референсов: {p.snapshot.refs.length}</p></div>
              <Button variant="ghost" size="sm" aria-label={p.favorite ? "Убрать из избранного" : "В избранное"} disabled={busy} onClick={() => useForm.getState().set({ promptLibrary: useForm.getState().promptLibrary.map((item) => item.id === p.id ? { ...item, favorite: !item.favorite } : item) })}><Star size={14} fill={p.favorite ? "currentColor" : "none"} /></Button>
              <Button variant="ghost" size="sm" aria-label={`Удалить ${p.name}`} disabled={busy} onClick={() => {
                const before = useForm.getState().promptLibrary;
                useForm.getState().set({ promptLibrary: before.filter((item) => item.id !== p.id) });
                useUI.getState().toast("Промпт удалён из библиотеки", "info", { label: "Отменить", run: () => useForm.getState().set({ promptLibrary: [...useForm.getState().promptLibrary, p] }) });
              }}><Trash2 size={14} /></Button>
            </div>
            <p className="my-2 line-clamp-2 whitespace-pre-line text-xs text-muted">{toModelPrompt(p.snapshot.prompt, p.snapshot.refs)}</p>
            <Button size="sm" disabled={busy} onClick={async () => {
              setBusy(true); setError("");
              try { await restorePrompt(p.snapshot); onOpenChange(false); }
              catch (e) { setError(e instanceof Error ? e.message : "Не удалось загрузить промпт. Попробуйте снова."); }
              finally { setBusy(false); }
            }}><RotateCcw size={12} /> Загрузить с референсами</Button>
          </div>)}
        </div>
      </div>
    </Dialog>
  );
}
