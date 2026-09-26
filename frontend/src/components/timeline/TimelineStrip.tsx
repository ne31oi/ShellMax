import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import clsx from "clsx";
import { Film, Redo2, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { urls } from "../../api/client";
import type { MediaAsset } from "../../api/types";
import { addToTimeline } from "../../lib/actions";
import { fmtDuration } from "../../lib/format";
import { useLibrary } from "../../store/library";
import { clipDuration, commands, useTimeline, type Clip } from "../../store/timeline";
import { useUI } from "../../store/ui";
import { ASSET_DRAG_TYPE } from "../generate/RefsZone";
import { IconButton } from "../ui";

const PX_PER_SEC = 28;

export function TimelineStrip({ tall }: { tall: boolean }) {
  const doc = useTimeline((s) => s.doc);
  const { run, undo, redo, past, future } = useTimeline();
  const assets = useLibrary((s) => s.assets);
  const [selected, setSelected] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const track = doc.tracks[0];
  const total = track.clips.reduce((s, c) => s + clipDuration(c), 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        run(commands.removeClip(useTimeline.getState().doc, selected));
        setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, run]);

  const onDragEnd = ({ active, over: target }: DragEndEvent) => {
    if (!target || active.id === target.id) return;
    run(commands.moveClip(track.clips.findIndex((c) => c.id === active.id), track.clips.findIndex((c) => c.id === target.id)));
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-faint">Таймлайн</h2>
        <span className="text-[11px] text-faint tabular-nums">{track.clips.length ? `${track.clips.length} клип. · ${fmtDuration(total)}` : ""}</span>
        <span className="ml-auto" />
        <IconButton label={past.length ? `Отменить: ${past.at(-1)!.label} (Ctrl+Z)` : "Нечего отменять"} size="sm" disabled={!past.length} onClick={undo}>
          <Undo2 size={13} />
        </IconButton>
        <IconButton label={future.length ? `Повторить: ${future[0].label} (Ctrl+Shift+Z)` : "Нечего повторять"} size="sm" disabled={!future.length} onClick={redo}>
          <Redo2 size={13} />
        </IconButton>
      </div>
      <div
        className={clsx("mx-3 mb-2 flex-1 overflow-x-auto rounded-lg border transition-colors", over ? "border-accent bg-accent/5" : "border-line bg-bg/60")}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(ASSET_DRAG_TYPE)) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false);
          const json = e.dataTransfer.getData(ASSET_DRAG_TYPE);
          if (json) addToTimeline(JSON.parse(json) as MediaAsset);
        }}
        onClick={() => setSelected(null)}
      >
        {track.clips.length === 0 ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-faint">
            <Film size={14} /> Перетащите клип из медиатеки или дважды щёлкните по нему
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={track.clips.map((c) => c.id)} strategy={horizontalListSortingStrategy}>
              <div className="flex h-full items-stretch gap-0.5 p-1.5">
                {track.clips.map((c) => (
                  <ClipBlock key={c.id} clip={c} asset={assets[c.assetId]} tall={tall} selected={selected === c.id} onSelect={() => setSelected(c.id)} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}

function ClipBlock({ clip, asset, selected, onSelect, tall }: { clip: Clip; asset?: MediaAsset; selected: boolean; onSelect: () => void; tall: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: clip.id });
  const width = Math.max(56, clipDuration(clip) * PX_PER_SEC * (tall ? 1.6 : 1));
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, width }}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
        if (asset) useUI.getState().selectAsset(asset.id);
      }}
      className={clsx(
        "relative shrink-0 overflow-hidden rounded-md bg-raised ring-1",
        selected ? "ring-2 ring-accent" : "ring-line hover:ring-line-strong",
      )}
    >
      {asset?.thumb && (
        <div className="absolute inset-0 flex">
          {/* repeat the poster frame like a filmstrip */}
          {Array.from({ length: Math.ceil(width / 64) }).map((_, i) => (
            <img key={i} src={urls.assetThumb(asset.id)} alt="" className="h-full w-16 shrink-0 object-cover opacity-80" draggable={false} />
          ))}
        </div>
      )}
      <span className="absolute bottom-0.5 left-1 max-w-[90%] truncate rounded bg-black/70 px-1 text-[10px] text-white">
        {asset?.name ?? "клип"} · {fmtDuration(clipDuration(clip))}
      </span>
    </div>
  );
}
