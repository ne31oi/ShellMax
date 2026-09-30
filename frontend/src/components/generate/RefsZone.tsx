import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import clsx from "clsx";
import { AlertTriangle, AudioLines, Crop, ImagePlus, Plus, Scissors, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { urls } from "../../api/client";
import type { MediaAsset, RefItem } from "../../api/types";
import { addUploadsAsRefs, assetAsRef, uploadFiles } from "../../lib/actions";
import { emit } from "../../lib/bus";
import { fmtSeconds } from "../../lib/format";
import { KIND_COLOR, KIND_LABEL, mentionedUids, tagOf } from "../../lib/refs";
import { useForm } from "../../store/form";
import { useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { Button, Select, Spinner, Tip } from "../ui";
import { RecentRefsPicker } from "./RecentRefsPicker";
import { ReferenceLibrary } from "./ReferenceLibrary";

export const ASSET_DRAG_TYPE = "application/x-shellmax-asset";
const ACCEPT = "image/*,video/*,audio/*";

export function RefsZone() {
  const refs = useForm((s) => s.refs);
  const prompt = useForm((s) => s.prompt);
  const moveRef = useForm((s) => s.moveRef);
  const maxRefs = useLibrary((s) => s.meta?.max_refs);
  const [pending, setPending] = useState(0);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const mentioned = mentionedUids(prompt);

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    setPending((n) => n + files.length);
    try {
      addUploadsAsRefs(await uploadFiles(files));
    } finally {
      setPending((n) => n - files.length);
    }
  };

  // Ctrl+V anywhere: pasted images/files become references
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    const assetJson = e.dataTransfer.getData(ASSET_DRAG_TYPE);
    if (assetJson) {
      await assetAsRef(JSON.parse(assetJson) as MediaAsset);
      return;
    }
    addFiles([...e.dataTransfer.files]);
  };

  const onDragEnd = ({ active, over: target }: DragEndEvent) => {
    if (!target || active.id === target.id) return;
    moveRef(refs.findIndex((r) => r.uid === active.id), refs.findIndex((r) => r.uid === target.id));
  };

  const counts = { image: 0, video: 0, audio: 0 };
  refs.forEach((r) => counts[r.upload.kind]++);
  const nearLimit = maxRefs && (Object.keys(counts) as (keyof typeof counts)[]).filter((k) => counts[k] >= maxRefs[k] - 1);

  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop,
  };

  return (
    <div>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          addFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
      {refs.length === 0 && pending === 0 ? (
        <button
          {...dropProps}
          onClick={() => input.current?.click()}
          className={clsx(
            "flex w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 py-5 text-center transition-colors",
            over ? "border-accent bg-accent/10" : "border-line-strong hover:border-accent/60 hover:bg-hover/40",
          )}
        >
          <ImagePlus size={20} className="text-muted" />
          <span className="text-[13px] text-fg">Перетащите картинки, видео или аудио</span>
          <span className="text-xs text-faint">или нажмите, чтобы выбрать · Ctrl+V вставит из буфера</span>
          <span className="mt-1 max-w-xs text-[11px] leading-snug text-faint">
            Для людей: нейтральный портрет лицом к камере, ровный свет — меньше «зловещей долины»
          </span>
          <div className="mt-2" onClick={(e) => e.stopPropagation()}>
            <RecentRefsPicker />
            <Button size="sm" onClick={() => useUI.getState().openRefmods(true)}>RefMods</Button>
            <ReferenceLibrary onPick={(u) => addUploadsAsRefs([u])} exclude={refs.map((r) => r.upload.source_id || r.upload.id)} />
          </div>
        </button>
      ) : (
        <div
          {...dropProps}
          className={clsx("rounded-xl border p-2 transition-colors", over ? "border-accent bg-accent/10" : "border-transparent")}
        >
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={refs.map((r) => r.uid)} strategy={horizontalListSortingStrategy}>
              <div className="flex flex-wrap gap-2">
                {refs.map((r) => (
                  <RefCard key={r.uid} item={r} tag={tagOf(refs, r.uid)!} mentioned={mentioned.has(r.uid)} />
                ))}
                {Array.from({ length: pending }).map((_, i) => (
                  <div key={i} className="flex h-[76px] w-[76px] items-center justify-center rounded-lg bg-raised text-muted">
                    <Spinner />
                  </div>
                ))}
                <Tip text="Добавить референс">
                  <button
                    onClick={() => input.current?.click()}
                    className="flex h-[76px] w-[52px] items-center justify-center rounded-lg border border-dashed border-line-strong text-muted hover:border-accent/60 hover:text-fg"
                  >
                    <Plus size={18} />
                  </button>
                </Tip>
                <RecentRefsPicker compact />
                <Button size="sm" onClick={() => useUI.getState().openRefmods(true)}>RefMods</Button>
                <ReferenceLibrary compact onPick={(u) => addUploadsAsRefs([u])} exclude={refs.map((r) => r.upload.source_id || r.upload.id)} />
              </div>
            </SortableContext>
          </DndContext>
          {nearLimit && nearLimit.length > 0 && (
            <p className="mt-1.5 text-[11px] text-faint">
              {nearLimit.map((k) => `${KIND_LABEL[k]}: ${counts[k]} из ${maxRefs![k]}`).join(" · ")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function RefCard({ item, tag, mentioned }: { item: RefItem; tag: string; mentioned: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.uid });
  const removeRef = useForm((s) => s.removeRef);
  const toggleAudio = useForm((s) => s.toggleRefAudio);
  const { upload } = item;
  const edited = !!upload.source_id;
  const color = KIND_COLOR[upload.kind];
  const badDuration = !upload.refmod_file && upload.kind === "video" && upload.duration != null && (upload.duration < 2 || upload.duration > 15);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined }}
      className={clsx("group relative h-[76px] w-[76px] shrink-0", isDragging && "opacity-80")}
      {...attributes}
      {...listeners}
    >
      <Tip text={<span>{upload.name || upload.orig_name}<br /><span className="text-muted">Щёлкните, чтобы вставить тег в промпт · тяните, чтобы изменить порядок</span></span>}>
        <button
          onClick={() => emit("insertMention", item.uid)}
          className="h-full w-full overflow-hidden rounded-lg bg-raised ring-1 ring-line hover:ring-accent/60"
        >
          {upload.kind === "audio" ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-audio">
              <AudioLines size={22} />
              <span className="text-[10px] text-muted">{upload.duration ? fmtSeconds(upload.duration) : ""}</span>
            </div>
          ) : (
            <img src={urls.uploadThumb(upload.id)} alt="" className="h-full w-full object-cover" draggable={false} />
          )}
        </button>
      </Tip>

      <span
        className="pointer-events-none absolute left-1 top-1 rounded px-1 text-[10px] font-semibold leading-4 text-black"
        style={{ background: color }}
      >
        {tag}
      </span>
      {!mentioned && (
        <Tip text="Не упомянут в промпте. Модель всё равно его увидит, но лучше сослаться на него словами.">
          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-warn/80 ring-2 ring-panel" />
        </Tip>
      )}

      {!upload.refmod_file && upload.kind === "video" && (
        <div className="absolute inset-x-1 bottom-1 flex items-center justify-between">
          <span className="flex items-center gap-0.5 rounded bg-black/70 px-1 text-[10px] text-white">
            {edited && <Scissors size={9} />}
            {upload.duration ? fmtSeconds(upload.duration) : ""}
          </span>
          {upload.has_audio && (
            <Tip text={item.withAudio ? "Звук видео передаётся модели" : "Звук видео не используется (как в воркфлоу)"}>
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => toggleAudio(item.uid)}
                className={clsx("rounded p-0.5", item.withAudio ? "bg-accent text-accent-fg" : "bg-black/70 text-white/70")}
              >
                {item.withAudio ? <Volume2 size={11} /> : <VolumeX size={11} />}
              </button>
            </Tip>
          )}
        </div>
      )}
      {badDuration && (
        <Tip text="Модель ожидает видео-референс длиной 2–15 секунд">
          <AlertTriangle size={13} className="absolute bottom-6 right-1 text-warn drop-shadow" />
        </Tip>
      )}

      {edited && upload.kind !== "video" && (
        <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/70 p-0.5 text-white">
          <Scissors size={9} />
        </span>
      )}
      {upload.refmod_file && <div className="absolute inset-x-0 bottom-0 rounded-b bg-panel/90 text-[9px]" onPointerDown={(e) => e.stopPropagation()}>
        <Select value={String(item.strength ?? 1)} onChange={(value) => useForm.getState().set({ refs: useForm.getState().refs.map((r) => r.uid === item.uid ? { ...r, strength: Number(value) } : r) })}
          options={[1, 0.75, 0.5, 0.25].map((v) => ({ value: String(v), label: `RefMod ${Math.round(v * 100)}%` }))} />
      </div>}
      {!upload.refmod_file && <Tip text={upload.kind === "image" ? "Обрезать" : upload.kind === "audio" ? "Вырезать фрагмент" : "Обрезать кадр и выбрать фрагмент"}>
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => useUI.getState().openRefEditor(item.uid)}
          aria-label="Изменить референс"
          className="absolute -top-1.5 right-4 hidden h-5 w-5 items-center justify-center rounded-full border border-line bg-panel text-muted hover:text-fg group-hover:flex"
        >
          {upload.kind === "image" ? <Crop size={11} /> : <Scissors size={11} />}
        </button>
      </Tip>}
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => removeRef(item.uid)}
        aria-label="Убрать референс"
        className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 items-center justify-center rounded-full border border-line bg-panel text-muted hover:text-bad group-hover:flex"
      >
        <X size={11} />
      </button>
    </div>
  );
}
