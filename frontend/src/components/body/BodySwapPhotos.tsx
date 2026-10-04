import { ImagePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, urls } from "../../api/client";
import type { Upload } from "../../api/types";
import { uploadFiles } from "../../lib/actions";
import { Button, ErrorMessage, Select, Spinner } from "../ui";

export function BodySwapPhotos({ value, onChange, disabled }: {
  value: [string, string]; onChange: (value: [string, string]) => void; disabled: boolean;
}) {
  const [photos, setPhotos] = useState<Upload[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const slot = useRef(0);
  useEffect(() => {
    let active = true;
    api.listUploads().then((items) => {
      if (active) setPhotos(items.filter((u) => u.kind === "image" && !u.refmod_file));
    }).catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);
  const choose = (index: number, id: string) => {
    const next: [string, string] = [...value];
    next[index] = id;
    onChange(next);
  };
  const upload = async (files: File[]) => {
    const index = slot.current;
    setBusy(index);
    try {
      const [photo] = await uploadFiles(files.slice(0, 1));
      if (!photo || photo.kind !== "image") { setError("Не удалось загрузить фотографию — выберите изображение"); return; }
      setPhotos((items) => [photo, ...items.filter((p) => p.id !== photo.id)]);
      choose(index, photo.id);
      setError("");
    } finally { setBusy(null); }
  };
  return <section>
    <input ref={input} hidden type="file" accept="image/*" onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ""; }} />
    <div className="grid grid-cols-2 gap-3">
      {["Костюм и тело", "Лицо и волосы"].map((label, index) => <div key={label} className="space-y-2 rounded-xl border border-line p-3">
        <p className="text-xs font-semibold">{label}</p>
        <Select value={value[index]} label={`Фото ${label.toLowerCase()}`} disabled={disabled || busy !== null}
          onChange={(id) => choose(index, id)} options={[
            { value: "", label: "Выберите фото" }, ...photos.map((u) => ({ value: u.id, label: u.name || u.orig_name })),
          ]} />
        {value[index] && <img src={urls.uploadFile(value[index])} alt={`Новый персонаж: ${label.toLowerCase()}`}
          className="h-32 w-full rounded-lg bg-raised object-contain" />}
        <Button disabled={disabled || busy !== null} onClick={() => { slot.current = index; input.current?.click(); }}>
          {busy === index ? <Spinner /> : <ImagePlus size={14} />} Загрузить фото
        </Button>
      </div>)}
    </div>
    <p className="mt-2 text-[11px] text-faint">Первое фото задаёт одежду и комплекцию, второе — лицо и волосы. Для одежды подходит манекен; для лица нужен чёткий портрет. Позу берём из клипа.</p>
    {error && <ErrorMessage text={error} />}
  </section>;
}
