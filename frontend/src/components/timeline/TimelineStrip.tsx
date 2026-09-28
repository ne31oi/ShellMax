import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import clsx from "clsx";
import { Film } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MediaAsset } from "../../api/types";
import { fmtTimecode } from "../../lib/format";
import { physicalLetter } from "../../lib/hotkeys";
import { loadMontageView, saveMontageView } from "../../lib/montageView";
import { useLibrary } from "../../store/library";
import {
  commands,
  copyPlanToClipboard,
  findClipTrack,
  findPlan,
  peekPlanClipboard,
  planTracks,
  snapEnabled,
  timelineBeats,
  totalDuration,
  useTimeline,
  videoTrack,
} from "../../store/timeline";
import { useUI } from "../../store/ui";
import { ASSET_DRAG_TYPE } from "../generate/RefsZone";
import { ClipBlock, LABEL_W, TrackRow } from "./TimelineBlocks";
import { TimelineAudioLanes } from "./TimelineAudioLanes";
import { TimelinePlanLanes } from "./TimelinePlanLanes";
import { TimelineToolbar } from "./TimelineToolbar";
import {
  dropAssetOnTrack,
  isAssetDrag,
  pastePlanAtPointer,
  splitAtPlayhead,
} from "./timelineActions";
import type { AudioDragState, PlanDragState } from "./timelineDrag";
import { beginPlayheadScrub, buildTimeMarks, timeAtClientX as timeAtX } from "./timelineGeometry";

export function TimelineStrip({ tall }: { tall: boolean }) {
  const doc = useTimeline((s) => s.doc);
  const playhead = useTimeline((s) => s.playhead);
  const setPlayhead = useTimeline((s) => s.setPlayhead);
  const selectedPlanId = useTimeline((s) => s.selectedPlanId);
  const selectedPlanIds = useTimeline((s) => s.selectedPlanIds);
  const run = useTimeline((s) => s.run);
  const assets = useLibrary((s) => s.assets);
  const projectId = useUI((s) => s.projectId);
  const [selected, setSelected] = useState<string | null>(null);
  const [planDrag, setPlanDrag] = useState<PlanDragState | null>(null);
  const [audioDrag, setAudioDrag] = useState<AudioDragState | null>(null);
  const [overTrack, setOverTrack] = useState<string | null>(null);
  const [railW, setRailW] = useState(0);
  const audioFileInput = useRef<HTMLInputElement>(null);
  const audioAddTrackId = useRef<string | null>(null);
  const [zoom, setZoomState] = useState(() => loadMontageView(useUI.getState().projectId).zoom);
  const setZoom = (z: number) => {
    const next = Math.max(0.5, Math.min(4, Math.round(z * 100) / 100));
    setZoomState(next);
    saveMontageView(useUI.getState().projectId, { zoom: next });
  };
  useEffect(() => {
    setZoomState(loadMontageView(projectId).zoom);
  }, [projectId]);
  const rail = useRef<HTMLDivElement>(null);
  const scrubRef = useRef({ scale: 1, total: 4, snapBeats: true });
  const zoomLayoutRef = useRef({ zoom: 1, scale: 1, total: 4, usable: 80 });
  /** Last pointer position — Ctrl+V pastes under the cursor (time + nearest plan track). */
  const pointerRef = useRef({ x: 0, y: 0 });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const vTrack = videoTrack(doc);
  const total = Math.max(totalDuration(doc), 4);
  // Always fill the rail width at zoom=1; zoom > 1 scrolls horizontally.
  const usable = Math.max(80, railW - LABEL_W - 4);
  const scale = (usable / total) * zoom;
  scrubRef.current = { scale, total, snapBeats: snapEnabled(doc) };
  zoomLayoutRef.current = { zoom, scale, total, usable };
  const { beats, downbeats: downsList } = timelineBeats(doc);
  const downbeats = new Set(downsList);
  const timeMarks = buildTimeMarks(total, scale);
  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      setRailW((prev) => (Math.abs(prev - w) < 2 ? prev : w));
    });
    ro.observe(el);
    setRailW(Math.round(el.clientWidth));
    const onWheel = (e: WheelEvent) => {
      // Alt / Ctrl + wheel — zoom toward the pointer
      if (e.altKey || e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const { zoom: z, scale: sc, total: tot, usable: us } = zoomLayoutRef.current;
        const factor = e.deltaY > 0 ? 1 / 1.12 : 1.12;
        const nextZ = Math.max(0.5, Math.min(4, Math.round(z * factor * 100) / 100));
        if (Math.abs(nextZ - z) < 1e-6) return;

        const r = el.getBoundingClientRect();
        const pointerInView = e.clientX - r.left - LABEL_W;
        const timeUnder = Math.max(0, (pointerInView + el.scrollLeft) / Math.max(sc, 0.001));
        const nextScale = (us / Math.max(tot, 0.001)) * nextZ;
        const nextScroll = timeUnder * nextScale - pointerInView;

        setZoom(nextZ);
        requestAnimationFrame(() => {
          el.scrollLeft = Math.max(0, nextScroll);
        });
        return;
      }

      // Plain wheel — pan the timeline horizontally (track scrub)
      const dx = e.deltaX !== 0 ? e.deltaX : e.deltaY;
      if (dx === 0) return;
      // Only intercept when we can scroll sideways (or always map vertical → horizontal)
      e.preventDefault();
      el.scrollLeft += dx;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointerRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) return;
      if (document.querySelector("[role=dialog]")) return;
      const d = useTimeline.getState().doc;
      const planId = useTimeline.getState().selectedPlanId;
      const ctrl = e.ctrlKey || e.metaKey;
      const letter = physicalLetter(e);

      if (ctrl && letter === "c") {
        if (!planId) return;
        const hit = findPlan(d, planId);
        if (!hit) return;
        e.preventDefault();
        copyPlanToClipboard(hit.plan, hit.track.id);
        useUI.getState().toast("План скопирован", "ok");
        return;
      }

      if (ctrl && letter === "v") {
        if (!peekPlanClipboard()) return;
        e.preventDefault();
        pastePlanAtPointer({
          pointer: pointerRef.current,
          railEl: rail.current,
          timeAtClientX: (clientX) => timeAtX(rail.current, clientX, scrubRef.current),
          run,
        });
        return;
      }

      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        const hit = findClipTrack(d, selected);
        if (hit) run(commands.removeClip(d, selected, hit.track.id));
        setSelected(null);
      }
      if ((e.key === "Delete" || e.key === "Backspace") && planId) {
        const ids = useTimeline.getState().selectedPlanIds;
        const toRemove = ids.length ? ids : [planId];
        for (const pid of toRemove) {
          for (const t of planTracks(useTimeline.getState().doc)) {
            if (t.plans.some((p) => p.id === pid)) {
              run(commands.removePlan(useTimeline.getState().doc, pid, t.id));
              break;
            }
          }
        }
        useTimeline.getState().selectPlan(null);
      }
      if (e.key === "Escape") {
        useTimeline.getState().selectPlan(null);
        useTimeline.getState().selectPlans([]);
        setSelected(null);
      }
      if (letter === "s") {
        e.preventDefault();
        splitAtPlayhead({ selectedId: selected, run, onSelectClip: setSelected });
      }
      if (letter === "n") {
        e.preventDefault();
        run(commands.setSnapToBeats(d, !snapEnabled(d)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, run]);

  const onDragEnd = ({ active, over: target }: DragEndEvent) => {
    if (!target || active.id === target.id) return;
    run(commands.moveClip(vTrack.clips.findIndex((c) => c.id === active.id), vTrack.clips.findIndex((c) => c.id === target.id)));
  };

  const beginScrub = (e: React.PointerEvent) => {
    beginPlayheadScrub({
      event: e,
      rail: rail.current,
      scrubLayout: () => scrubRef.current,
      setPlayhead,
      onStart: () => {
        useTimeline.getState().setPlaying(false);
        useUI.getState().setViewingSequence(true);
        setSelected(null);
      },
    });
  };

  // Full width at zoom=1; wider when zoomed (horizontal scroll).
  const contentW = Math.max(usable, Math.round(scale * total));

  return (
    <div className="relative flex h-full w-full min-w-0 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TimelineToolbar
          zoom={zoom}
          setZoom={setZoom}
          selectedPlanIds={selectedPlanIds}
          selectedClipId={selected}
          onSelectClip={setSelected}
        />

        <div
          ref={rail}
          className="relative mx-3 mb-2 min-h-0 w-auto flex-1 overflow-auto rounded-lg border border-line bg-bg/60"
          onPointerDown={(e) => {
            const t = e.target as HTMLElement;
            if (t.dataset.rail === "1" || t.closest("[data-scrub='1']")) {
              beginScrub(e);
            }
          }}
        >
          <div className="relative min-h-full" style={{ width: LABEL_W + contentW }} data-rail="1">
            {/* Time + beat ruler — drag to scrub playhead */}
            <div
              className="sticky top-0 z-30 flex h-7 cursor-ew-resize border-b border-line bg-panel/95"
              data-scrub="1"
              title="Тяните курсор по времени"
            >
              <div className="sticky left-0 z-40 flex w-[72px] shrink-0 cursor-default flex-col justify-center border-r border-line bg-panel px-1.5">
                <span className="text-[10px] font-medium tabular-nums text-accent leading-none">{fmtTimecode(playhead)}</span>
                <span className="text-[8px] uppercase tracking-wider text-faint/70 leading-tight">
                  {doc.markers?.bpm ? `${Math.round(doc.markers.bpm)} BPM` : "время"}
                </span>
              </div>
              <div className="relative flex-1" style={{ width: contentW }} data-scrub="1">
                {timeMarks.map((t) => (
                  <div key={`t-${t}`} className="absolute top-0 bottom-0 pointer-events-none" style={{ left: t * scale }}>
                    <div className="h-full w-px bg-line-strong/50" />
                    <span className="absolute left-0.5 top-0.5 text-[9px] tabular-nums text-faint whitespace-nowrap">
                      {fmtTimecode(t)}
                    </span>
                  </div>
                ))}
                {beats.map((b) => (
                  <div
                    key={`b-${b}`}
                    className={clsx(
                      "pointer-events-none absolute bottom-0 w-px",
                      downbeats.has(b) ? "top-3 bg-accent/80" : "top-4 bg-accent/35",
                    )}
                    style={{ left: b * scale }}
                  />
                ))}
              </div>
            </div>

            {/* Video track */}
            <TrackRow
              label="V"
              name={vTrack.name || "Видео"}
              over={overTrack === vTrack.id}
              onDragOver={(e) => {
                if (isAssetDrag(e.dataTransfer)) {
                  e.preventDefault();
                  setOverTrack(vTrack.id);
                }
              }}
              onDragLeave={() => setOverTrack(null)}
              onDrop={(e) => {
                e.preventDefault();
                setOverTrack(null);
                const json = e.dataTransfer.getData(ASSET_DRAG_TYPE);
                if (json) dropAssetOnTrack(JSON.parse(json) as MediaAsset, vTrack, e.clientX, e.currentTarget, scale);
              }}
            >
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={vTrack.clips.map((c) => c.id)} strategy={horizontalListSortingStrategy}>
                  <div className="relative flex h-full items-stretch" style={{ width: contentW }} data-rail="1">
                    {vTrack.clips.length === 0 && (
                      <div className="pointer-events-none absolute inset-0 flex items-center gap-2 px-2 text-[11px] text-faint">
                        <Film size={12} /> Перетащите клип из медиатеки
                      </div>
                    )}
                    {(() => {
                      let t = 0;
                      return vTrack.clips.map((c) => {
                        const start = t;
                        t += c.out - c.in;
                        return (
                          <div key={c.id} className="absolute top-0.5 bottom-0.5" style={{ left: start * scale, width: Math.max(40, (c.out - c.in) * scale) }}>
                            <ClipBlock
                              clip={c}
                              asset={assets[c.assetId]}
                              tall={tall}
                              scale={scale}
                              selected={selected === c.id}
                              absolute
                              onSelect={() => {
                                setSelected(c.id);
                                useTimeline.getState().seekToClip(c.id);
                                useUI.getState().setViewingSequence(true);
                              }}
                              onTrim={(inn, out) => run(commands.trimClip(useTimeline.getState().doc, c.id, inn, out))}
                              onRemove={() => {
                                run(commands.removeClip(useTimeline.getState().doc, c.id));
                                setSelected(null);
                              }}
                            />
                          </div>
                        );
                      });
                    })()}
                  </div>
                </SortableContext>
              </DndContext>
            </TrackRow>

            <TimelinePlanLanes
              contentW={contentW}
              scale={scale}
              planDrag={planDrag}
              setPlanDrag={setPlanDrag}
              playhead={playhead}
              selectedPlanId={selectedPlanId}
              selectedPlanIds={selectedPlanIds}
            />

            <TimelineAudioLanes
              contentW={contentW}
              scale={scale}
              playhead={playhead}
              beats={beats}
              downsList={downsList}
              selected={selected}
              setSelected={setSelected}
              audioDrag={audioDrag}
              setAudioDrag={setAudioDrag}
              overTrack={overTrack}
              setOverTrack={setOverTrack}
              assets={assets}
              audioFileInput={audioFileInput}
              audioAddTrackId={audioAddTrackId}
            />

            {/* Playhead — drag handle on ruler + line through lanes */}
            <div
              className="absolute bottom-0 top-0 z-40"
              style={{ left: LABEL_W + playhead * scale }}
              data-scrub="1"
            >
              <button
                type="button"
                data-scrub="1"
                title="Курсор — тяните по таймлайну"
                onPointerDown={beginScrub}
                className="absolute top-0 left-0 z-10 flex h-7 w-4 -translate-x-1/2 cursor-ew-resize items-end justify-center"
              >
                <span className="block h-0 w-0 border-x-[6px] border-t-[8px] border-x-transparent border-t-accent drop-shadow" />
              </button>
              <div className="pointer-events-none absolute bottom-0 top-7 w-0.5 -translate-x-1/2 bg-accent shadow-[0_0_0_1px_rgba(0,0,0,.4)]" />
            </div>
            {/* Beat lines through lanes */}
            {beats.map((b) => (
              <div
                key={`g-${b}`}
                className={clsx(
                  "pointer-events-none absolute bottom-0 top-7 z-10 w-px",
                  downbeats.has(b) ? "bg-accent/25" : "bg-line/40",
                )}
                style={{ left: LABEL_W + b * scale }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
