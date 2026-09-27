import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import clsx from "clsx";
import { Download, Film, Redo2, Scissors, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, urls } from "../../api/client";
import type { MediaAsset } from "../../api/types";
import { addToTimeline } from "../../lib/actions";
import { fmtDuration } from "../../lib/format";
import { useLibrary } from "../../store/library";
import {
  clipAtTime,
  commands,
  totalDuration,
  useTimeline,
  videoTrack,
  type Clip,
} from "../../store/timeline";
import { useUI } from "../../store/ui";
import { ASSET_DRAG_TYPE } from "../generate/RefsZone";
import { IconButton } from "../ui";

/** Comfortable default; long sequences auto-shrink to fit the rail so drag still works. */
const PX_PER_SEC = 28;
const MIN_CLIP = 0.15;

export function TimelineStrip({ tall }: { tall: boolean }) {
  const doc = useTimeline((s) => s.doc);
  const playhead = useTimeline((s) => s.playhead);
  const setPlayhead = useTimeline((s) => s.setPlayhead);
  const { run, undo, redo, past, future } = useTimeline();
  const assets = useLibrary((s) => s.assets);
  const [selected, setSelected] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [railW, setRailW] = useState(0);
  const [zoom, setZoom] = useState(1);
  const rail = useRef<HTMLDivElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const track = videoTrack(doc);
  const total = totalDuration(doc);
  const base = PX_PER_SEC * (tall ? 1.6 : 1);
  // Fit total duration into the visible rail when it would overflow (minus padding).
  const pad = 24;
  const fit = total > 0 && railW > pad ? (railW - pad) / total : base;
  const scale = Math.min(base, fit) * zoom;

  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setRailW(w);
    });
    ro.observe(el);
    setRailW(el.clientWidth);
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => {
        const next = e.deltaY > 0 ? z * 0.9 : z * 1.1;
        return Math.max(0.5, Math.min(4, Math.round(next * 100) / 100));
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) return;
      if (document.querySelector("[role=dialog]")) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        run(commands.removeClip(useTimeline.getState().doc, selected));
        setSelected(null);
      }
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        splitAtPlayhead();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const splitAtPlayhead = () => {
    const d = useTimeline.getState().doc;
    const ph = useTimeline.getState().playhead;
    const hit = clipAtTime(d, ph);
    if (!hit) return;
    const cmd = commands.splitClip(d, hit.clip.id, ph);
    if (!cmd) {
      useUI.getState().toast("Слишком близко к краю клипа", "info");
      return;
    }
    run(cmd);
    setSelected(hit.clip.id);
    useUI.getState().toast("Клип разрезан", "ok");
  };

  const onDragEnd = ({ active, over: target }: DragEndEvent) => {
    if (!target || active.id === target.id) return;
    run(commands.moveClip(track.clips.findIndex((c) => c.id === active.id), track.clips.findIndex((c) => c.id === target.id)));
  };

  const seekFromClientX = (clientX: number) => {
    const el = rail.current;
    if (!el || !total) return;
    const r = el.getBoundingClientRect();
    const x = clientX - r.left + el.scrollLeft - 6; // padding
    setPlayhead(Math.max(0, Math.min(total, x / scale)));
  };

  const doExport = async () => {
    if (!track.clips.length || exporting) return;
    setExporting(true);
    try {
      // flush pending persist
      await fetch("/api/projects/1/timeline", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(useTimeline.getState().doc),
      });
      const asset = await api.exportTimeline(1);
      useLibrary.getState().upsertAsset(asset);
      useUI.getState().selectAsset(asset.id);
      useUI.getState().setViewingSequence(false);
      useUI.getState().toast("Ролик экспортирован в медиатеку", "ok");
    } catch (e) {
      useUI.getState().toast(e instanceof Error ? e.message : "Не удалось экспортировать", "bad");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-faint">Таймлайн</h2>
        <span className="text-[11px] text-faint tabular-nums">{track.clips.length ? `${track.clips.length} клип. · ${fmtDuration(total)}` : ""}</span>
        <span className="ml-auto" />
        <IconButton
          label="Разрезать по курсору (S)"
          size="sm"
          disabled={!track.clips.length}
          onClick={splitAtPlayhead}
        >
          <Scissors size={13} />
        </IconButton>
        <IconButton
          label={exporting ? "Экспорт…" : "Экспорт ролика в медиатеку"}
          size="sm"
          disabled={!track.clips.length || exporting}
          onClick={() => void doExport()}
        >
          <Download size={13} />
        </IconButton>
        <IconButton label={past.length ? `Отменить: ${past.at(-1)!.label} (Ctrl+Z)` : "Нечего отменять"} size="sm" disabled={!past.length} onClick={undo}>
          <Undo2 size={13} />
        </IconButton>
        <IconButton label={future.length ? `Повторить: ${future[0].label} (Ctrl+Shift+Z)` : "Нечего повторять"} size="sm" disabled={!future.length} onClick={redo}>
          <Redo2 size={13} />
        </IconButton>
        <span className="mx-0.5 h-3 w-px bg-line" />
        <IconButton
          label="Мельче (длинные клипы)"
          size="sm"
          disabled={zoom <= 0.5}
          onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.25) * 100) / 100))}
        >
          <span className="text-[11px] font-semibold leading-none">−</span>
        </IconButton>
        <IconButton
          label="Крупнее (точная обрезка)"
          size="sm"
          disabled={zoom >= 4}
          onClick={() => setZoom((z) => Math.min(4, Math.round((z + 0.25) * 100) / 100))}
        >
          <span className="text-[11px] font-semibold leading-none">+</span>
        </IconButton>
      </div>
      <div
        ref={rail}
        className={clsx("relative mx-3 mb-2 flex-1 overflow-x-auto rounded-lg border transition-colors", over ? "border-accent bg-accent/5" : "border-line bg-bg/60")}
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
        onClick={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.rail === "1") {
            setSelected(null);
            seekFromClientX(e.clientX);
            useUI.getState().setViewingSequence(true);
          }
        }}
      >
        {track.clips.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center text-xs text-faint">
            <span className="flex items-center gap-2">
              <Film size={14} /> Перетащите клип из медиатеки или дважды щёлкните по нему
            </span>
            <span className="text-[11px] text-faint/70">Обрезка за края · S — разрез · +/− или Ctrl+колёсико — масштаб · экспорт в mp4</span>
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={track.clips.map((c) => c.id)} strategy={horizontalListSortingStrategy}>
              <div className="relative flex h-full items-stretch gap-0.5 p-1.5" data-rail="1" onClick={(e) => {
                if ((e.target as HTMLElement).dataset.rail === "1") {
                  seekFromClientX(e.clientX);
                  useUI.getState().setViewingSequence(true);
                }
              }}>
                {track.clips.map((c) => (
                  <ClipBlock
                    key={c.id}
                    clip={c}
                    asset={assets[c.assetId]}
                    tall={tall}
                    scale={scale}
                    selected={selected === c.id}
                    onSelect={() => {
                      setSelected(c.id);
                      useTimeline.getState().seekToClip(c.id);
                      useUI.getState().setViewingSequence(true);
                    }}
                    onTrim={(inn, out) => run(commands.trimClip(useTimeline.getState().doc, c.id, inn, out))}
                  />
                ))}
                {total > 0 && (
                  <div
                    className="pointer-events-none absolute bottom-1.5 top-1.5 z-20 w-0.5 bg-accent shadow-[0_0_0_1px_rgba(0,0,0,.4)]"
                    style={{ left: 6 + playhead * scale }}
                  />
                )}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}

function ClipBlock({
  clip,
  asset,
  selected,
  onSelect,
  tall,
  scale,
  onTrim,
}: {
  clip: Clip;
  asset?: MediaAsset;
  selected: boolean;
  onSelect: () => void;
  tall: boolean;
  scale: number;
  onTrim: (inn: number, out: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: clip.id });
  const [draft, setDraft] = useState<{ in: number; out: number } | null>(null);
  const shown = draft ?? { in: clip.in, out: clip.out };
  const width = Math.max(56, (shown.out - shown.in) * scale);
  const srcDur = Math.max(clip.out, asset?.duration ?? clip.out);
  void tall;

  const dragEdge = (e: React.PointerEvent, which: "in" | "out") => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const in0 = clip.in;
    const out0 = clip.out;
    let lastIn = in0;
    let lastOut = out0;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / scale;
      if (which === "in") {
        lastIn = Math.max(0, Math.min(out0 - MIN_CLIP, in0 + dx));
        lastOut = out0;
      } else {
        lastIn = in0;
        lastOut = Math.min(srcDur, Math.max(in0 + MIN_CLIP, out0 + dx));
      }
      setDraft({ in: lastIn, out: lastOut });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDraft(null);
      if (lastIn !== in0 || lastOut !== out0) onTrim(lastIn, lastOut);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, width }}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      className={clsx(
        "relative shrink-0 overflow-hidden rounded-md bg-raised ring-1",
        selected ? "ring-2 ring-accent" : "ring-line hover:ring-line-strong",
      )}
    >
      {asset?.thumb && (
        <div
          className="pointer-events-none absolute inset-0 opacity-80"
          style={{
            backgroundImage: `url(${urls.assetThumb(asset.id)})`,
            backgroundSize: "auto 100%",
            backgroundRepeat: "repeat-x",
          }}
        />
      )}
      <span className="pointer-events-none absolute bottom-0.5 left-1 max-w-[90%] truncate rounded bg-black/70 px-1 text-[10px] text-white">
        {asset?.name ?? "клип"} · {fmtDuration(shown.out - shown.in)}
      </span>
      <div
        className="absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize bg-accent/0 hover:bg-accent/80"
        onPointerDown={(e) => {
          e.stopPropagation();
          dragEdge(e, "in");
        }}
        onClick={(e) => e.stopPropagation()}
      />
      <div
        className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize bg-accent/0 hover:bg-accent/80"
        onPointerDown={(e) => {
          e.stopPropagation();
          dragEdge(e, "out");
        }}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
