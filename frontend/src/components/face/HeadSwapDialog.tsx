import { ImagePlus, ScanFace } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, urls } from "../../api/client";
import type { HeadSwapTarget, Upload } from "../../api/types";
import { uploadFiles } from "../../lib/actions";
import { useLibrary } from "../../store/library";
import { useForm } from "../../store/form";
import { useUI } from "../../store/ui";
import { JobFooter, JobLoading, PostProcessDialogShell, useAssetJobForm } from "../jobs/PostProcessShell";
import { Button, ErrorMessage, SectionTitle, Select, Spinner } from "../ui";
import { HeadSwapTargetEditor } from "./HeadSwapTargetEditor";

export function HeadSwapDialog() {
  const state = useUI((s) => s.headSwapDialog);
  const close = () => useUI.getState().openHeadSwapDialog(null);
  return <PostProcessDialogShell open={state !== null} title="Заменить голову · Head Swap" onClose={close} wide>
    {state && <HeadSwapForm key={`${state.assetId}-${state.fromGenerationId ?? ""}`} {...state} onDone={close} />}
  </PostProcessDialogShell>;
}

function HeadSwapForm({ assetId, fromGenerationId, onDone }: {
  assetId: number; fromGenerationId?: number; onDone: () => void;
}) {
  const form = useAssetJobForm(assetId, api.headSwapDefaults);
  const previous = useLibrary((s) => fromGenerationId ? s.generations[fromGenerationId] : undefined);
  const [target, setTarget] = useState<HeadSwapTarget | null>(() => previous?.ui_params.target as HeadSwapTarget | null ?? null);
  const [photos, setPhotos] = useState<Upload[]>([]);
  const [identity, setIdentity] = useState<Upload | null>(null);
  const [loadingPhoto, setLoadingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    const savedId = previous?.ui_params.identity_upload_id as string | undefined;
    Promise.all([api.listUploads(), savedId ? api.uploadInfo(savedId) : Promise.resolve(null)])
      .then(([uploads, saved]) => {
        if (!active) return;
        const choices = uploads.filter((u) => u.kind === "image" && !u.refmod_file);
        setPhotos(saved && !choices.some((u) => u.id === saved.id) ? [saved, ...choices] : choices);
        if (saved) setIdentity(saved);
        else {
          const sticky = useForm.getState().headSwapIdentityUploadId;
          setIdentity(choices.find((u) => u.id === sticky) ?? null);
        }
      }).catch((e) => { if (active) setPhotoError(e instanceof Error ? e.message : "Не удалось загрузить фотографии"); });
    return () => { active = false; };
  }, [previous]);
  const choose = (photo: Upload) => {
    setIdentity(photo);
    useForm.getState().set({ headSwapIdentityUploadId: photo.id });
  };
  const upload = async (files: File[]) => {
    setLoadingPhoto(true);
    try {
      const [photo] = await uploadFiles(files.slice(0, 1));
      if (!photo) return;
      if (photo.kind !== "image") { setPhotoError("Выберите фотографию, а не видео"); return; }
      setPhotoError("");
      setPhotos((items) => [photo, ...items.filter((u) => u.id !== photo.id)]);
      choose(photo);
    } catch (e) {
      setPhotoError(e instanceof Error ? e.message : "Не удалось загрузить фотографию");
    } finally { setLoadingPhoto(false); }
  };
  const d = form.defaults;
  if (!d) return <JobLoading error={form.error} />;
  const submit = () => {
    if (!identity || !target) return;
    void form.submit(() => api.headSwap({ source_asset_id: assetId, identity_upload_id: identity.id, seed: previous?.seed ?? null, target }), {
      upsert: (g) => useLibrary.getState().upsertGeneration(g), select: (id) => useUI.getState().selectGen(id), onDone,
    });
  };
  return <div className="space-y-4 p-5">
    <p className="text-xs leading-relaxed text-muted">Заменяет всю голову, включая волосы, по фотографии.
      Движения, тело, одежда и окружение задаются исходным клипом. Результат появится отдельным видео.</p>
    <div className="flex items-center gap-3 text-xs">
      <span className="min-w-0 flex-1 truncate" title={d.asset.name}>{d.asset.name}</span>
      <span className="shrink-0 text-faint">{d.frames} кадров · {d.asset.width}×{d.asset.height}</span>
    </div>
    <div className="grid gap-5 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
    <HeadSwapTargetEditor asset={d.asset} value={target} onChange={setTarget} />
    <section><SectionTitle>На кого меняем</SectionTitle>
      {photos.length > 0 && <Select value={identity?.id ?? ""} onChange={(id) => { const photo = photos.find((u) => u.id === id); if (photo) choose(photo); }}
        label="Фотография головы" options={photos.map((u) => ({ value: u.id, label: u.name || u.orig_name }))} />}
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ""; }} />
      <div className="mt-2 flex items-center gap-3">
        {identity && <img src={urls.uploadFile(identity.id)} alt="Фото головы для замены" className="h-24 w-24 rounded-lg object-contain bg-raised" />}
        <Button onClick={() => input.current?.click()} disabled={loadingPhoto || form.busy}>
          {loadingPhoto ? <Spinner /> : <ImagePlus size={14} />} Загрузить фото
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-faint">Чёткая фотография одного человека с видимой головой и волосами.
        Описание внешности для промпта будет составлено автоматически по этому фото.</p>
    </section>
    </div>
    <p className="text-[11px] text-faint">Экспериментальный режим: сложные ракурсы и перекрытия могут менять сходство.
      Размер, число кадров, частота и звук берутся из исходного клипа.</p>
    {!d.ready && <ErrorMessage text={`Модели ещё не установлены: ${d.missing.join(", ")}. Запустите scripts/install_head_swap.py Python движка; подробности в README.`} />}
    {(photoError || form.error) && <ErrorMessage text={photoError || form.error} />}
    <JobFooter onCancel={onDone} onSubmit={submit} busy={form.busy} disabled={!d.ready || !identity || !target || loadingPhoto}
      estimate={null} label="Заменить голову" icon={<ScanFace size={15} />} />
  </div>;
}
