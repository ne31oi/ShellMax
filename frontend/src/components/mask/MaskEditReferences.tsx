import { useEffect, useRef, useState } from "react";
import { AudioLines, ImagePlus, X } from "lucide-react";
import { api, urls } from "../../api/client";
import type { RefItem, Upload } from "../../api/types";
import { uploadFiles } from "../../lib/actions";
import { KIND_LABEL, tagOf } from "../../lib/refs";
import { useForm } from "../../store/form";
import { Button, ErrorMessage, SectionTitle, Select, Spinner } from "../ui";

// Upload IDs provide stable prompt tokens even after the generation panel changes.
export function maskEditRefs(ids: string[], uploads: Upload[]): RefItem[] {
  return ids.flatMap((id) => {
    const upload = uploads.find((u) => u.id === id);
    return upload ? [{ uid: id, upload, withAudio: false }] : [];
  });
}

export function useMaskEditReferences() {
  const [uploads, setUploads] = useState<Upload[]>(() => useForm.getState().refs.map((r) => r.upload));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api.listUploads().then((items) => { if (active) setUploads(items); })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : "Не удалось загрузить референсы"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const addUploads = (items: Upload[]) => setUploads((current) => [
    ...items, ...current.filter((u) => !items.some((item) => item.id === u.id)),
  ]);
  return { uploads, loading, error, addUploads };
}

export function MaskEditReferences({ uploads, selected, loading, disabled, onChange, onUpload, onInsert, onBusy }: {
  uploads: Upload[]; selected: RefItem[]; loading: boolean; disabled: boolean;
  onChange: (ids: string[]) => void; onUpload: (uploads: Upload[]) => void;
  onInsert: (uid: string) => void; onBusy: (busy: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const available = uploads.filter((u) => !selected.some((r) => r.upload.id === u.id));
  const choose = (items: Upload[]) => {
    const next = [...selected.map((r) => r.upload), ...items];
    // The ordinary reference bundle has nine picture and three video/audio slots.
    if (next.length > 15 || ["image", "video", "audio"].some((kind) =>
      next.filter((u) => u.kind === kind && !u.refmod_file).length > (kind === "image" ? 9 : 3))) {
      setError("Можно выбрать до 9 картинок, 3 видео и 3 аудио; всего до 15 референсов");
      return;
    }
    setError("");
    onChange(next.map((u) => u.id));
  };
  const upload = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    onBusy(true);
    try {
      const items = await uploadFiles(files);
      onUpload(items);
      choose(items);
    } finally { setBusy(false); onBusy(false); }
  };
  return <section className="space-y-2 rounded-xl border border-line p-3">
    <SectionTitle>На что меняем</SectionTitle>
    <p className="text-xs text-muted">Выберите референс внешности или объекта и укажите его метку в промпте.</p>
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1"><Select value="" label="Референс для замены" disabled={disabled || busy || loading}
        options={[{ value: "", label: loading ? "Загружаю референсы…" : "Выбрать загруженный референс…" },
          ...available.map((u) => ({ value: u.id, label: `${u.name || u.orig_name} · ${KIND_LABEL[u.kind]}${u.refmod_file ? " · RefMod" : ""}` }))]}
        onChange={(id) => { const item = available.find((u) => u.id === id); if (item) choose([item]); }} /></div>
      <Button disabled={disabled || busy || loading} onClick={() => input.current?.click()}>
        {busy ? <Spinner /> : <ImagePlus size={14} />} Загрузить референс
      </Button>
      <input ref={input} type="file" accept="image/*,video/*,audio/*" multiple hidden
        onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ""; }} />
    </div>
    {selected.map((r) => <div key={r.uid} className="flex items-center gap-2 rounded-lg bg-raised p-2">
      {r.upload.kind === "audio" ? <AudioLines size={24} className="shrink-0 text-audio" /> :
        <img src={urls.uploadThumb(r.upload.id)} alt="Референс для замены" className="h-14 w-14 shrink-0 rounded object-contain" />}
      <div className="min-w-0 flex-1"><p className="truncate text-xs">{r.upload.name || r.upload.orig_name}</p>
        <p className="text-xs text-accent">{`<${tagOf(selected, r.uid)}>`}{r.upload.refmod_file ? " · RefMod" : ""}</p></div>
      <Button size="sm" disabled={disabled || busy} onClick={() => onInsert(r.uid)}>Вставить метку</Button>
      <Button size="sm" disabled={disabled || busy} title="Убрать референс"
        onClick={() => onChange(selected.filter((item) => item.uid !== r.uid).map((item) => item.upload.id))}><X size={14} /></Button>
    </div>)}
    {error && <ErrorMessage text={error} />}
  </section>;
}
