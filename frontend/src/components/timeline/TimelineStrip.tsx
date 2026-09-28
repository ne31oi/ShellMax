import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as ContextMenu from "@radix-ui/react-context-menu";
import clsx from "clsx";
import {
  Download, Eraser, Film, Gauge, Magnet, Music2, Pencil, Plus, Redo2, ScanFace, Scissors, Sparkles, Trash2, Undo2, Volume2, VolumeX, type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, urls } from "../../api/client";
import type { MediaAsset } from "../../api/types";
import * as actions from "../../lib/actions";
import { addToTimeline } from "../../lib/actions";
import { fmtDuration, fmtTimecode } from "../../lib/format";
import { physicalLetter } from "../../lib/hotkeys";
import { loadMontageView, saveMontageView } from "../../lib/montageView";
import { H3_FPS, nearestH3Duration, snapToFrame } from "../../lib/planH3";
import { useLibrary } from "../../store/library";
import {
  audioTracks,
  clipAtTime,
  clipDuration,
  clonePlanFresh,
  commands,
  copyPlanToClipboard,
  emptyPlan,
  findClip,
  findClipTrack,
  findPlan,
  openPlanInSidebar,
  peekPlanClipboard,
  planTracks,
  resolvePlanPlacement,
  clampPlanResize,
  snapEnabled,
  snapTime,
  timelineBeats,
  totalDuration,
  useTimeline,
  videoTrack,
  type Clip,
  type Plan,
  type Track,
} from "../../store/timeline";
import { useUI } from "../../store/ui";
import { ASSET_DRAG_TYPE } from "../generate/RefsZone";
import { IconButton, Slider } from "../ui";
import { AudioClipWave } from "./AudioClipWave";
import { PlanBatchBar } from "./PlanInspector";

/** Comfortable default; long sequences auto-shrink to fit the rail so drag still works. */
const MIN_CLIP = 0.15;
const MIN_PLAN = 0.2;
const LABEL_W = 72;

/** Nice-step time marks for the ruler (seconds). */
function buildTimeMarks(total: number, scale: number, minPx = 56): number[] {
  const minSec = minPx / Math.max(scale, 0.001);
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find((s) => s >= minSec) ?? 600;
  const out: number[] = [];
  for (let t = 0; t <= total + 1e-6; t += step) out.push(Math.round(t * 1000) / 1000);
  return out;
}

export function TimelineStrip({ tall }: { tall: boolean }) {
  const doc = useTimeline((s) => s.doc);
  const playhead = useTimeline((s) => s.playhead);
  const setPlayhead = useTimeline((s) => s.setPlayhead);
  const selectedPlanId = useTimeline((s) => s.selectedPlanId);
  const selectedPlanIds = useTimeline((s) => s.selectedPlanIds);
  const run = useTimeline((s) => s.run);
  const undo = useTimeline((s) => s.undo);
  const redo = useTimeline((s) => s.redo);
  const pastLen = useTimeline((s) => s.past.length);
  const futureLen = useTimeline((s) => s.future.length);
  const pastLabel = useTimeline((s) => s.past.at(-1)?.label);
  const futureLabel = useTimeline((s) => s.future[0]?.label);
  const assets = useLibrary((s) => s.assets);
  const projectId = useUI((s) => s.projectId);
  const [selected, setSelected] = useState<string | null>(null);
  const [planDrag, setPlanDrag] = useState<{
    planId: string;
    fromTrackId: string;
    toTrackId: string;
    start: number;
    duration: number;
    mode: "move" | "in" | "out";
  } | null>(null);
  const [audioDrag, setAudioDrag] = useState<{
    clipId: string;
    fromTrackId: string;
    toTrackId: string;
    start: number;
    in: number;
    out: number;
  } | null>(null);
  const [overTrack, setOverTrack] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
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
  const pTracks = planTracks(doc);
  const aTracks = audioTracks(doc);
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
        const clip = peekPlanClipboard();
        if (!clip) return;
        e.preventDefault();
        const tracks = planTracks(d);
        if (!tracks.length) {
          useUI.getState().toast("Нет дорожки планов", "info");
          return;
        }
        const ptr = pointerRef.current;
        const railEl = rail.current;
        const railBox = railEl?.getBoundingClientRect();
        const overRail =
          !!railBox &&
          ptr.x >= railBox.left &&
          ptr.x <= railBox.right &&
          ptr.y >= railBox.top &&
          ptr.y <= railBox.bottom;

        const startWant = overRail
          ? timeAtClientX(ptr.x)
          : snapToFrame(snapTime(d, useTimeline.getState().playhead, { force: true }));
        const duration = Math.max(MIN_PLAN, snapToFrame(clip.plan.duration));

        // Plan tracks ranked by vertical distance to cursor
        const ranked = (() => {
          const els = [...document.querySelectorAll<HTMLElement>("[data-plan-track]")];
          const scored = els
            .map((el) => {
              const id = el.dataset.planTrack;
              if (!id || !tracks.some((t) => t.id === id)) return null;
              const r = el.getBoundingClientRect();
              const mid = (r.top + r.bottom) / 2;
              const dist =
                ptr.y >= r.top && ptr.y <= r.bottom
                  ? 0
                  : Math.min(Math.abs(ptr.y - r.top), Math.abs(ptr.y - r.bottom), Math.abs(ptr.y - mid));
              return { id, dist };
            })
            .filter((x): x is { id: string; dist: number } => !!x)
            .sort((a, b) => a.dist - b.dist);
          const ids = scored.map((s) => s.id);
          for (const t of tracks) {
            if (!ids.includes(t.id)) ids.push(t.id);
          }
          return ids;
        })();

        let placed: number | null = null;
        let trackId: string | null = null;
        for (const id of ranked) {
          const track = tracks.find((t) => t.id === id);
          if (!track) continue;
          const at = resolvePlanPlacement(track.plans, startWant, duration);
          if (at != null) {
            placed = at;
            trackId = id;
            break;
          }
        }
        if (placed == null || !trackId) {
          useUI.getState().toast("Нет места без перекрытия на ближайших дорожках", "info");
          return;
        }
        const plan = clonePlanFresh(clip.plan, { start: placed, duration });
        run(commands.addPlan(plan, trackId));
        openPlanInSidebar(plan.id);
        const trackIdx = tracks.findIndex((t) => t.id === trackId);
        const trackLabel = trackIdx >= 0 ? `P${trackIdx + 1}` : trackId;
        useUI.getState().toast(`План → ${trackLabel} · ${fmtTimecode(placed)}`, "ok");
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
        splitAtPlayhead();
      }
      if (letter === "n") {
        e.preventDefault();
        run(commands.setSnapToBeats(d, !snapEnabled(d)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, run]);

  const splitAtPlayhead = () => {
    const d = useTimeline.getState().doc;
    const ph = useTimeline.getState().playhead;

    const tryAudio = (clipId: string, trackId: string) => {
      const cmd = commands.splitAudioClip(d, clipId, trackId, ph);
      if (!cmd) {
        useUI.getState().toast("Слишком близко к краю клипа", "info");
        return true;
      }
      run(cmd);
      setSelected(clipId);
      useUI.getState().toast("Аудио разрезано", "ok");
      return true;
    };

    if (selected) {
      const hit = findClipTrack(d, selected);
      if (hit?.track.kind === "audio") {
        tryAudio(selected, hit.track.id);
        return;
      }
    }
    for (const t of audioTracks(d)) {
      for (const c of t.clips) {
        const s = c.start ?? 0;
        const dur = clipDuration(c);
        if (ph > s + MIN_CLIP && ph < s + dur - MIN_CLIP) {
          tryAudio(c.id, t.id);
          return;
        }
      }
    }

    const hit = clipAtTime(d, ph);
    if (!hit) {
      useUI.getState().toast("Нет клипа под курсором", "info");
      return;
    }
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
    run(commands.moveClip(vTrack.clips.findIndex((c) => c.id === active.id), vTrack.clips.findIndex((c) => c.id === target.id)));
  };

  const timeAtClientX = (clientX: number, opts?: { altKey?: boolean }) => {
    const el = rail.current;
    if (!el) return 0;
    const { scale: sc, total: tot, snapBeats } = scrubRef.current;
    const r = el.getBoundingClientRect();
    const x = clientX - r.left + el.scrollLeft - LABEL_W;
    let t = Math.max(0, Math.min(tot, x / Math.max(sc, 0.001)));
    t = snapToFrame(t);
    if (snapBeats && !opts?.altKey) t = snapTime(useTimeline.getState().doc, t, { force: true });
    return t;
  };

  const beginScrub = (e: React.PointerEvent) => {
    // Don't steal plan/clip drags — only empty rail / ruler / playhead handle.
    e.preventDefault();
    e.stopPropagation();
    useTimeline.getState().setPlaying(false);
    useUI.getState().setViewingSequence(true);
    setSelected(null);
    setPlayhead(timeAtClientX(e.clientX, { altKey: e.altKey }));
    const move = (ev: PointerEvent) => {
      setPlayhead(timeAtClientX(ev.clientX, { altKey: ev.altKey }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const doExport = async () => {
    if (!vTrack.clips.length || exporting) return;
    setExporting(true);
    try {
      const projectId = useUI.getState().projectId;
      await api.saveTimeline(projectId, useTimeline.getState().doc);
      const asset = await api.exportTimeline(projectId);
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

  const analyzeBeatsFromSelection = async () => {
    const d = useTimeline.getState().doc;
    const ph = useTimeline.getState().playhead;

    const resolve = (): { clip: Clip; trackStart: number } | null => {
      // 1) A-clip under the playhead (what you see)
      for (const t of audioTracks(d)) {
        for (const c of t.clips) {
          const s = c.start ?? 0;
          if (ph >= s - 1e-3 && ph < s + clipDuration(c) + 1e-3) {
            return { clip: c, trackStart: s };
          }
        }
      }
      // 2) Selected clip
      if (selected) {
        const onA = audioTracks(d)
          .flatMap((t) => t.clips.map((c) => ({ c, start: c.start ?? 0 })))
          .find((x) => x.c.id === selected);
        if (onA) return { clip: onA.c, trackStart: onA.start };
        const onV = findClip(d, selected);
        if (onV) return { clip: onV.clip, trackStart: onV.trackStart };
      }
      // 3) First A, then V
      const a = audioTracks(d).flatMap((t) => t.clips)[0];
      if (a) return { clip: a, trackStart: a.start ?? 0 };
      const v0 = videoTrack(d).clips[0];
      if (v0) return { clip: v0, trackStart: 0 };
      return null;
    };

    const hit = resolve();
    if (!hit) {
      useUI.getState().toast("Нужен аудио- или видеоклип на таймлайне", "info");
      return;
    }
    const { clip, trackStart } = hit;

    setAnalyzing(true);
    try {
      // Backend returns **file-absolute** times; we store them + clip id and remap on display.
      const result = await api.analyzeBeats(clip.assetId, { start: clip.in, end: clip.out });
      run(
        commands.setMarkers(useTimeline.getState().doc, {
          beats: result.beats,
          downbeats: result.downbeats,
          bpm: result.bpm,
          offset: result.offset ?? clip.in,
          sourceAssetId: clip.assetId,
          sourceClipId: clip.id,
          timespace: "file",
        }),
      );
      const mapped = timelineBeats(useTimeline.getState().doc);
      useUI.getState().toast(
        `Биты: ${mapped.beats.length}${result.bpm ? ` · ${Math.round(result.bpm)} BPM` : ""} · клип с ${fmtTimecode(trackStart)}`,
        "ok",
      );
    } catch (e) {
      useUI.getState().toast(e instanceof Error ? e.message : "Не удалось найти биты", "bad");
    } finally {
      setAnalyzing(false);
    }
  };

  const layOutByBeats = () => {
    const marks = downsList.length ? downsList : beats;
    if (marks.length < 2) {
      useUI.getState().toast("Сначала найдите биты", "info");
      return;
    }
    const pt = pTracks[0];
    if (!pt) return;
    let lastId: string | null = null;
    for (let i = 0; i < marks.length - 1; i++) {
      const start = marks[i];
      const rawDur = marks[i + 1] - start;
      const plan = emptyPlan({
        start,
        duration: nearestH3Duration(Math.max(MIN_PLAN, rawDur)),
        name: `Бит ${i + 1}`,
        mode: "draft",
      });
      useTimeline.getState().run(commands.addPlan(plan, pt.id));
      lastId = plan.id;
    }
    if (lastId) openPlanInSidebar(lastId);
    useUI.getState().toast(`Разложено планов: ${marks.length - 1}`, "ok");
  };

  const dropAsset = (asset: MediaAsset, track: Track, clientX: number, el: HTMLElement) => {
    if (track.kind === "video") {
      addToTimeline(asset);
      return;
    }
    if (track.kind === "audio") {
      if (asset.kind !== "audio" && !asset.has_audio) {
        useUI.getState().toast("На A-трек — аудио или клип со звуком", "info");
        return;
      }
      const r = el.getBoundingClientRect();
      const x = clientX - r.left - LABEL_W;
      let start = Math.max(0, x / scale);
      if (doc.snapToBeats !== false) start = snapTime(doc, start, { force: true });
      actions.addToAudioTrack(asset, { trackId: track.id, start });
      return;
    }
  };

  const importAudioOntoTrack = async (trackId: string, files: FileList | File[]) => {
    const list = [...files];
    if (!list.length) return;
    try {
      for (const f of list) {
        const asset = await api.importAsset(f);
        useLibrary.getState().upsertAsset(asset);
        if (asset.kind !== "audio" && !asset.has_audio) {
          useUI.getState().toast(`«${asset.name}» без звука — пропуск`, "info");
          continue;
        }
        actions.addToAudioTrack(asset, { trackId, start: useTimeline.getState().playhead });
      }
    } catch (e) {
      useUI.getState().toast(e instanceof Error ? e.message : "Не удалось импортировать", "bad");
    }
  };

  const dragTypes = (dt: DataTransfer) => Array.from(dt.types as unknown as string[]);
  const isAssetDrag = (dt: DataTransfer) => dragTypes(dt).includes(ASSET_DRAG_TYPE);
  const isFileDrag = (dt: DataTransfer) => dragTypes(dt).includes("Files");

  // Full width at zoom=1; wider when zoomed (horizontal scroll).
  const contentW = Math.max(usable, Math.round(scale * total));

  return (
    <div className="relative flex h-full w-full min-w-0 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-faint">Монтаж</h2>
          <PlanBatchBar selectedIds={selectedPlanIds} />
          <span className="ml-auto" />
          <IconButton
            label={snapEnabled(doc) ? "Snap к битам (N) — вкл" : "Snap к битам (N) — выкл"}
            size="sm"
            active={snapEnabled(doc)}
            onClick={() => run(commands.setSnapToBeats(useTimeline.getState().doc, !snapEnabled(doc)))}
          >
            <Magnet size={13} />
          </IconButton>
          <IconButton
            label={analyzing ? "Анализ…" : "Найти биты"}
            size="sm"
            disabled={analyzing}
            onClick={() => void analyzeBeatsFromSelection()}
          >
            <Music2 size={13} />
          </IconButton>
          <IconButton
            label="Очистить биты"
            size="sm"
            disabled={!beats.length}
            onClick={() => {
              run(
                commands.setMarkers(useTimeline.getState().doc, {
                  beats: [],
                  downbeats: [],
                  bpm: null,
                  offset: 0,
                  sourceAssetId: null,
                  sourceClipId: null,
                  timespace: null,
                }),
              );
              useUI.getState().toast("Биты очищены", "ok");
            }}
          >
            <Eraser size={13} />
          </IconButton>
          <IconButton label="Разложить планы по битам" size="sm" onClick={layOutByBeats}>
            <Plus size={13} />
          </IconButton>
          <IconButton
            label="Дорожка планов"
            size="sm"
            onClick={() => run(commands.addPlanTrack(useTimeline.getState().doc))}
          >
            <span className="text-[10px] font-bold">P+</span>
          </IconButton>
          <IconButton
            label="Аудиодорожка"
            size="sm"
            onClick={() => run(commands.addAudioTrack(useTimeline.getState().doc))}
          >
            <span className="text-[10px] font-bold">A+</span>
          </IconButton>
          <IconButton
            label="Собрать готовые планы на видеодорожку"
            size="sm"
            onClick={() => {
              const has = planTracks(doc).some((t) => t.plans.some((p) => p.outputAssetId || p.draftAssetId));
              if (!has) {
                useUI.getState().toast("Нет готовых планов для сборки", "info");
                return;
              }
              try {
                run(commands.compilePlansToVideo(useTimeline.getState().doc));
                useUI.getState().toast("Планы собраны на V", "ok");
              } catch (error) {
                useUI.getState().toast(error instanceof Error ? error.message : String(error), "bad");
              }
            }}
          >
            <Film size={13} />
          </IconButton>
          <IconButton
            label="Разрезать по курсору (S)"
            size="sm"
            disabled={!vTrack.clips.length && !aTracks.some((t) => t.clips.length)}
            onClick={splitAtPlayhead}
          >
            <Scissors size={13} />
          </IconButton>
          <IconButton
            label={exporting ? "Экспорт…" : "Экспорт"}
            size="sm"
            disabled={!vTrack.clips.length || exporting}
            onClick={() => void doExport()}
          >
            <Download size={13} />
          </IconButton>
          <IconButton label={pastLen ? `Отменить: ${pastLabel}` : "Нечего отменять"} size="sm" disabled={!pastLen} onClick={undo}>
            <Undo2 size={13} />
          </IconButton>
          <IconButton label={futureLen ? `Повторить: ${futureLabel}` : "Нечего повторять"} size="sm" disabled={!futureLen} onClick={redo}>
            <Redo2 size={13} />
          </IconButton>
          <div className="flex min-w-[260px] items-center gap-2 pl-2" title="Масштаб таймлайна (Alt + колёсико — к курсору)">
            <span className="text-[12px] text-faint select-none">−</span>
            <Slider size="lg" className="w-52" value={zoom} min={0.5} max={4} step={0.05} onChange={setZoom} />
            <span className="text-[12px] text-faint select-none">+</span>
            <span className="w-11 text-right text-[12px] tabular-nums text-muted">{Math.round(zoom * 100)}%</span>
          </div>
        </div>

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
                if (json) dropAsset(JSON.parse(json) as MediaAsset, vTrack, e.clientX, e.currentTarget);
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

            {/* Plan tracks */}
            {pTracks.map((pt, idx) => (
              <TrackRow
                key={pt.id}
                label={`P${idx + 1}`}
                name={pt.name || `Планы ${idx + 1}`}
                muted={pt.muted}
                over={planDrag?.toTrackId === pt.id}
                onAddPlan={() => {
                  const start = snapToFrame(snapTime(doc, playhead, { force: true }));
                  const duration = nearestH3Duration(2);
                  const placed = resolvePlanPlacement(pt.plans, start, duration);
                  if (placed == null) {
                    useUI.getState().toast("На дорожке нет места без перекрытия", "info");
                    return;
                  }
                  const plan = emptyPlan({ start: placed, duration });
                  run(commands.addPlan(plan, pt.id));
                  openPlanInSidebar(plan.id);
                }}
                onMute={() => run(commands.setTrackMuted(useTimeline.getState().doc, pt.id, !pt.muted))}
                onRemove={
                  pTracks.length > 1
                    ? () => {
                        const cmd = commands.removeTrack(useTimeline.getState().doc, pt.id);
                        if (!cmd) {
                          useUI.getState().toast("Нужна хотя бы одна дорожка планов", "info");
                          return;
                        }
                        run(cmd);
                        useTimeline.getState().selectPlan(null);
                      }
                    : undefined
                }
              >
                <div
                  className="relative h-full"
                  style={{ width: contentW }}
                  data-rail="1"
                  data-plan-track={pt.id}
                >
                  {pt.plans.map((p) => {
                    const dragging = planDrag?.planId === p.id;
                    const onThisTrack = !dragging || planDrag.toTrackId === pt.id;
                    if (dragging && planDrag.fromTrackId === pt.id && planDrag.toTrackId !== pt.id) {
                      return null; // shown as ghost / on destination
                    }
                    if (!onThisTrack) return null;
                    const start = dragging ? planDrag.start : p.start;
                    const duration = dragging ? planDrag.duration : p.duration;
                    return (
                      <PlanBlock
                        key={p.id}
                        plan={p}
                        displayStart={start}
                        displayDuration={duration}
                        scale={scale}
                        selected={selectedPlanId === p.id}
                        checked={selectedPlanIds.includes(p.id)}
                        dragging={!!dragging}
                        trackId={pt.id}
                        onSelect={(mods) => {
                          if (mods.toggle) {
                            useTimeline.getState().togglePlanSelected(p.id);
                            return;
                          }
                          if (mods.range) {
                            const ordered = planTracks(useTimeline.getState().doc).flatMap((t) => t.plans.map((x) => x.id));
                            const anchor = selectedPlanIds[0] ?? selectedPlanId ?? p.id;
                            const a = ordered.indexOf(anchor);
                            const b = ordered.indexOf(p.id);
                            if (a >= 0 && b >= 0) {
                              const lo = Math.min(a, b);
                              const hi = Math.max(a, b);
                              useTimeline.getState().selectPlans(ordered.slice(lo, hi + 1));
                              return;
                            }
                          }
                          openPlanInSidebar(p.id);
                        }}
                        onPreview={(preview) => setPlanDrag(preview)}
                        onCommit={(final) => {
                          setPlanDrag(null);
                          if (!final) return;
                          const cmd = commands.relocatePlan(
                            useTimeline.getState().doc,
                            final.planId,
                            final.fromTrackId,
                            final.toTrackId,
                            final.start,
                            final.duration,
                          );
                          if (!cmd) {
                            useUI.getState().toast("Нельзя: перекрытие с другим планом на дорожке", "info");
                            return;
                          }
                          run(cmd);
                        }}
                        snapBeats={snapEnabled(doc)}
                        resolvePreview={(toTrackId, start, duration, mode) => {
                          const dest = useTimeline.getState().doc.tracks.find((t) => t.id === toTrackId);
                          const peers = dest?.plans ?? [];
                          if (mode === "move") {
                            const placed = resolvePlanPlacement(peers, start, duration, p.id);
                            return placed == null ? { start, duration, blocked: true } : { start: placed, duration, blocked: false };
                          }
                          const clamped = clampPlanResize(peers, p.id, start, duration, mode);
                          return clamped
                            ? { start: clamped.start, duration: clamped.duration, blocked: false }
                            : { start, duration, blocked: true };
                        }}
                      />
                    );
                  })}
                  {planDrag &&
                    planDrag.toTrackId === pt.id &&
                    planDrag.fromTrackId !== pt.id && (
                      <div
                        className="pointer-events-none absolute top-1 bottom-1 rounded-md bg-accent/25 ring-2 ring-accent"
                        style={{
                          left: planDrag.start * scale,
                          width: Math.max(28, planDrag.duration * scale),
                        }}
                      />
                    )}
                </div>
              </TrackRow>
            ))}

            {/* Audio tracks */}
            {aTracks.map((at, idx) => (
              <TrackRow
                key={at.id}
                label={`A${idx + 1}`}
                name={at.name || `Аудио ${idx + 1}`}
                tall
                over={overTrack === at.id}
                muted={at.muted}
                onMute={() => run(commands.setTrackMuted(useTimeline.getState().doc, at.id, !at.muted))}
                onAddAudio={() => {
                  const selectedAssetId = useUI.getState().selectedAsset;
                  const sel = selectedAssetId != null ? assets[selectedAssetId] : undefined;
                  if (sel && (sel.kind === "audio" || sel.has_audio)) {
                    actions.addToAudioTrack(sel, { trackId: at.id, start: playhead });
                    return;
                  }
                  audioAddTrackId.current = at.id;
                  audioFileInput.current?.click();
                }}
                onRemove={
                  aTracks.length > 1
                    ? () => {
                        const cmd = commands.removeTrack(useTimeline.getState().doc, at.id);
                        if (!cmd) {
                          useUI.getState().toast("Нужна хотя бы одна аудиодорожка", "info");
                          return;
                        }
                        run(cmd);
                      }
                    : undefined
                }
                onDragOver={(e) => {
                  if (isAssetDrag(e.dataTransfer) || isFileDrag(e.dataTransfer)) {
                    e.preventDefault();
                    setOverTrack(at.id);
                  }
                }}
                onDragLeave={() => setOverTrack(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setOverTrack(null);
                  if (e.dataTransfer.files?.length) {
                    void importAudioOntoTrack(at.id, e.dataTransfer.files);
                    return;
                  }
                  const json = e.dataTransfer.getData(ASSET_DRAG_TYPE);
                  if (json) dropAsset(JSON.parse(json) as MediaAsset, at, e.clientX, e.currentTarget);
                }}
              >
                <div className="relative h-full" style={{ width: contentW }} data-rail="1" data-audio-track={at.id}>
                  {at.clips.length === 0 && (
                    <div className="pointer-events-none absolute inset-0 flex items-center gap-2 px-2 text-[11px] text-faint">
                      <Music2 size={12} /> Перетащите аудио или нажмите «+ аудио»
                    </div>
                  )}
                  {at.clips.map((c) => {
                    const dragging = audioDrag?.clipId === c.id;
                    const onThisTrack = !dragging || audioDrag.toTrackId === at.id;
                    if (dragging && audioDrag.fromTrackId === at.id && audioDrag.toTrackId !== at.id) {
                      return null; // ghost moves to target track
                    }
                    const start = dragging && onThisTrack ? audioDrag.start : (c.start ?? 0);
                    const inn = dragging && onThisTrack ? audioDrag.in : c.in;
                    const out = dragging && onThisTrack ? audioDrag.out : c.out;
                    const asset = assets[c.assetId];
                    return (
                      <AudioClipBlock
                        key={c.id}
                        clip={c}
                        displayStart={start}
                        displayIn={inn}
                        displayOut={out}
                        assetName={asset?.name}
                        assetDuration={asset?.duration}
                        scale={scale}
                        selected={selected === c.id}
                        dragging={!!dragging}
                        trackId={at.id}
                        trackMuted={!!at.muted}
                        playhead={playhead}
                        beats={beats}
                        downbeats={downsList}
                        masterVolume={doc.masterVolume ?? 1}
                        masterMute={!!doc.masterMute}
                        snapBeats={snapEnabled(doc)}
                        onSelect={() => {
                          setSelected(c.id);
                          setPlayhead(c.start ?? 0);
                        }}
                        onPreview={setAudioDrag}
                        onCommit={(d) => {
                          setAudioDrag(null);
                          if (!d) return;
                          const cmd = commands.relocateAudioClip(
                            useTimeline.getState().doc,
                            d.clipId,
                            d.fromTrackId,
                            d.toTrackId,
                            { start: d.start, in: d.in, out: d.out },
                          );
                          if (cmd) run(cmd);
                        }}
                        onRemove={() => {
                          run(commands.removeClip(useTimeline.getState().doc, c.id, at.id));
                          setSelected(null);
                        }}
                        onToggleMute={() =>
                          run(commands.setClipMuted(useTimeline.getState().doc, c.id, !c.muted, at.id))
                        }
                      />
                    );
                  })}
                  {/* Ghost on target track while dragging from another */}
                  {audioDrag &&
                    audioDrag.toTrackId === at.id &&
                    audioDrag.fromTrackId !== at.id &&
                    (() => {
                      const src = aTracks.flatMap((t) => t.clips.map((c) => ({ t, c }))).find((x) => x.c.id === audioDrag.clipId);
                      if (!src) return null;
                      const asset = assets[src.c.assetId];
                      return (
                        <AudioClipBlock
                          key={`ghost-${audioDrag.clipId}`}
                          clip={src.c}
                          displayStart={audioDrag.start}
                          displayIn={audioDrag.in}
                          displayOut={audioDrag.out}
                          assetName={asset?.name}
                          assetDuration={asset?.duration}
                          scale={scale}
                          selected
                          dragging
                          trackId={at.id}
                          trackMuted={!!at.muted}
                          playhead={playhead}
                          beats={beats}
                          downbeats={downsList}
                          masterVolume={doc.masterVolume ?? 1}
                          masterMute={!!doc.masterMute}
                          snapBeats={snapEnabled(doc)}
                          ghost
                          onSelect={() => undefined}
                          onPreview={() => undefined}
                          onCommit={() => undefined}
                          onRemove={() => undefined}
                          onToggleMute={() => undefined}
                        />
                      );
                    })()}
                </div>
              </TrackRow>
            ))}

            <input
              ref={audioFileInput}
              type="file"
              hidden
              accept="audio/*,video/*"
              multiple
              onChange={(e) => {
                const trackId = audioAddTrackId.current ?? aTracks[0]?.id;
                const files = e.target.files;
                e.target.value = "";
                audioAddTrackId.current = null;
                if (trackId && files?.length) void importAudioOntoTrack(trackId, files);
              }}
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

function TrackRow({
  label,
  name,
  children,
  over,
  muted,
  tall,
  onDragOver,
  onDragLeave,
  onDrop,
  onAddPlan,
  onAddAudio,
  onMute,
  onRemove,
}: {
  label: string;
  name: string;
  children: ReactNode;
  over?: boolean;
  muted?: boolean;
  tall?: boolean;
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave?: () => void;
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void;
  onAddPlan?: () => void;
  onAddAudio?: () => void;
  onMute?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div
      className={clsx(
        "flex border-b border-line/60",
        tall ? "h-16" : "h-12",
        over && "bg-accent/5",
        muted && "opacity-50",
      )}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        className={clsx(
          "sticky left-0 z-20 flex w-[72px] shrink-0 flex-col justify-center border-r border-line px-1.5",
          over ? "bg-accent/10" : "bg-panel",
        )}
      >
        <div className="flex items-center gap-0.5">
          <span className="text-[10px] font-semibold text-muted">{label}</span>
          {onMute && (
            <button type="button" className="text-faint hover:text-fg" title={muted ? "Включить дорожку" : "Выключить дорожку"} onClick={onMute}>
              {muted ? <VolumeX size={10} /> : <Volume2 size={10} />}
            </button>
          )}
          {onRemove && (
            <button type="button" className="text-faint hover:text-bad" title="Удалить дорожку" onClick={onRemove}>
              <Trash2 size={10} />
            </button>
          )}
        </div>
        <span className="truncate text-[9px] text-faint">{name}</span>
        {onAddPlan && (
          <button type="button" className="text-[9px] text-accent hover:underline" onClick={onAddPlan}>
            + план
          </button>
        )}
        {onAddAudio && (
          <button type="button" className="text-[9px] text-accent hover:underline" onClick={onAddAudio}>
            + аудио
          </button>
        )}
      </div>
      <div className="relative min-w-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

type PlanDragState = {
  planId: string;
  fromTrackId: string;
  toTrackId: string;
  start: number;
  duration: number;
  mode: "move" | "in" | "out";
};

type AudioDragState = {
  clipId: string;
  fromTrackId: string;
  toTrackId: string;
  start: number;
  in: number;
  out: number;
};

function AudioClipBlock({
  clip,
  displayStart,
  displayIn,
  displayOut,
  assetName,
  assetDuration,
  scale,
  selected,
  dragging,
  trackId,
  trackMuted,
  playhead,
  beats,
  downbeats,
  masterVolume,
  masterMute,
  snapBeats,
  ghost,
  onSelect,
  onPreview,
  onCommit,
  onRemove,
  onToggleMute,
}: {
  clip: Clip;
  displayStart: number;
  displayIn: number;
  displayOut: number;
  assetName?: string;
  assetDuration?: number | null;
  scale: number;
  selected: boolean;
  dragging: boolean;
  trackId: string;
  trackMuted: boolean;
  playhead: number;
  beats: number[];
  downbeats: number[];
  masterVolume: number;
  masterMute: boolean;
  snapBeats: boolean;
  ghost?: boolean;
  onSelect: () => void;
  onPreview: (d: AudioDragState | null) => void;
  onCommit: (d: AudioDragState | null) => void;
  onRemove: () => void;
  onToggleMute: () => void;
}) {
  const maxSrc = assetDuration && assetDuration > 0 ? assetDuration : Math.max(displayOut, clip.out, 60);
  const dur = Math.max(MIN_CLIP, displayOut - displayIn);
  const widthPx = Math.max(32, dur * scale);
  const clipEnd = displayStart + dur;
  const progress =
    playhead <= displayStart ? 0 : playhead >= clipEnd ? 1 : (playhead - displayStart) / dur;
  const silent = !!clip.muted || trackMuted || masterMute;
  const gain = silent ? 0 : Math.max(0, Math.min(1, masterVolume));
  const downSet = useMemo(() => new Set(downbeats), [downbeats]);
  const localBeats = useMemo(
    () => beats.filter((b) => b > displayStart + 0.01 && b < clipEnd - 0.01),
    [beats, displayStart, clipEnd],
  );

  const drag = (e: React.PointerEvent, mode: "move" | "in" | "out") => {
    if (ghost) return;
    e.preventDefault();
    e.stopPropagation();
    const originX = e.clientX;
    const s0 = clip.start ?? 0;
    const in0 = clip.in;
    const out0 = clip.out;
    let last: AudioDragState = {
      clipId: clip.id,
      fromTrackId: trackId,
      toTrackId: trackId,
      start: s0,
      in: in0,
      out: out0,
    };
    onPreview(last);
    onSelect();

    const move = (ev: PointerEvent) => {
      let toTrackId = trackId;
      if (mode === "move") {
        const trackEls = document.querySelectorAll<HTMLElement>("[data-audio-track]");
        for (const el of trackEls) {
          const r = el.getBoundingClientRect();
          if (ev.clientY >= r.top && ev.clientY <= r.bottom) {
            toTrackId = el.dataset.audioTrack || trackId;
            break;
          }
        }
      }
      const dx = (ev.clientX - originX) / scale;
      let nextStart = s0;
      let nextIn = in0;
      let nextOut = out0;
      if (mode === "move") {
        nextStart = Math.max(0, s0 + dx);
        if (snapBeats) {
          const doc = useTimeline.getState().doc;
          if (timelineBeats(doc).beats.length) {
            nextStart = snapTime(doc, nextStart, { force: true });
          }
        }
        nextStart = snapToFrame(nextStart);
      } else if (mode === "in") {
        // Trim left: slide in + start together, keep right edge fixed on timeline
        let nextStartRaw = Math.max(0, s0 + dx);
        if (snapBeats) {
          const doc = useTimeline.getState().doc;
          if (timelineBeats(doc).beats.length) {
            nextStartRaw = snapTime(doc, nextStartRaw, { force: true });
          }
        }
        nextStart = snapToFrame(nextStartRaw);
        const delta = nextStart - s0;
        nextIn = Math.max(0, Math.min(out0 - MIN_CLIP, in0 + delta));
        nextOut = out0;
      } else {
        let nextOutTimeline = s0 + (out0 - in0) + dx; // right edge on master clock
        if (snapBeats) {
          const doc = useTimeline.getState().doc;
          if (timelineBeats(doc).beats.length) {
            nextOutTimeline = snapTime(doc, nextOutTimeline, { force: true });
          }
        }
        nextOutTimeline = snapToFrame(nextOutTimeline);
        nextOut = Math.max(in0 + MIN_CLIP, Math.min(maxSrc, in0 + (nextOutTimeline - s0)));
        nextOut = snapToFrame(nextOut);
        nextStart = s0;
        nextIn = in0;
      }
      last = { clipId: clip.id, fromTrackId: trackId, toTrackId, start: nextStart, in: nextIn, out: nextOut };
      onPreview(last);
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const changed =
        last.start !== s0 || last.in !== in0 || last.out !== out0 || last.toTrackId !== trackId;
      onCommit(changed ? last : null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const block = (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onPointerDown={(e) => {
        if (ghost) return;
        if ((e.target as HTMLElement).dataset.edge) return;
        if (e.button !== 0) return;
        drag(e, "move");
      }}
      style={{ left: displayStart * scale, width: widthPx }}
      className={clsx(
        "absolute top-1 bottom-1 cursor-grab overflow-hidden rounded-md ring-1 active:cursor-grabbing",
        selected ? "ring-accent bg-audio/25" : "ring-audio/40 bg-audio/12",
        silent && "opacity-70",
        dragging && "z-30 opacity-90 shadow-lg",
        ghost && "pointer-events-none opacity-70",
      )}
      title={`${assetName ?? "аудио"} · ${fmtTimecode(displayStart)}${silent ? " · без звука" : ""}`}
    >
      <AudioClipWave
        assetId={clip.assetId}
        fileDuration={assetDuration}
        inn={displayIn}
        out={displayOut}
        widthPx={widthPx}
        gain={gain}
        muted={silent}
        progress={progress}
      />
      {/* Beat ticks on the waveform */}
      {localBeats.map((b) => (
        <div
          key={`ab-${b}`}
          className={clsx(
            "pointer-events-none absolute top-0 bottom-0 z-[1] w-px",
            downSet.has(b) ? "bg-accent/70" : "bg-accent/35",
          )}
          style={{ left: (b - displayStart) * scale }}
        />
      ))}
      <span className="pointer-events-none absolute bottom-0.5 left-1 right-1 z-[2] truncate text-[9px] font-medium text-fg/85 drop-shadow-[0_1px_1px_rgba(0,0,0,.85)]">
        {assetName ?? "аудио"}
        {silent ? " · mute" : ""}
      </span>
      {!ghost && (
        <>
          <div
            data-edge="in"
            onPointerDown={(e) => {
              e.stopPropagation();
              drag(e, "in");
            }}
            className="absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize hover:bg-accent/40"
          />
          <div
            data-edge="out"
            onPointerDown={(e) => {
              e.stopPropagation();
              drag(e, "out");
            }}
            className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize hover:bg-accent/40"
          />
        </>
      )}
    </div>
  );

  if (ghost) return block;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{block}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-40 min-w-44 rounded-xl border border-line bg-panel p-1 shadow-2xl">
          <TlCtxItem icon={Volume2} onSelect={onToggleMute}>
            {clip.muted ? "Включить звук" : "Выключить звук"}
          </TlCtxItem>
          <TlCtxItem
            icon={Scissors}
            onSelect={() => {
              const ph = useTimeline.getState().playhead;
              const cmd = commands.splitAudioClip(useTimeline.getState().doc, clip.id, trackId, ph);
              if (!cmd) useUI.getState().toast("Поставьте курсор внутрь клипа", "info");
              else {
                useTimeline.getState().run(cmd);
                useUI.getState().toast("Аудио разрезано", "ok");
              }
            }}
          >
            Разрезать по курсору (S)
          </TlCtxItem>
          <TlCtxItem icon={Trash2} danger onSelect={onRemove}>
            Убрать с дорожки
          </TlCtxItem>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function PlanBlock({
  plan,
  displayStart,
  displayDuration,
  scale,
  selected,
  checked,
  dragging,
  trackId,
  snapBeats,
  onSelect,
  onPreview,
  onCommit,
  resolvePreview,
}: {
  plan: Plan;
  displayStart: number;
  displayDuration: number;
  scale: number;
  selected: boolean;
  checked: boolean;
  dragging: boolean;
  trackId: string;
  snapBeats: boolean;
  onSelect: (mods: { toggle?: boolean; range?: boolean }) => void;
  onPreview: (d: PlanDragState | null) => void;
  onCommit: (d: PlanDragState | null) => void;
  resolvePreview: (
    toTrackId: string,
    start: number,
    duration: number,
    mode: "move" | "in" | "out",
  ) => { start: number; duration: number; blocked: boolean };
}) {
  const statusColor =
    plan.status === "done"
      ? "bg-ok/25 ring-ok/50"
      : plan.status === "draft"
        ? "bg-accent/20 ring-accent/50"
        : plan.status === "error"
          ? "bg-bad/20 ring-bad/50"
          : plan.status === "running" || plan.status === "queued"
            ? "bg-warn/20 ring-warn/50"
            : "bg-raised ring-line";

  const drag = (e: React.PointerEvent, mode: "move" | "in" | "out") => {
    e.preventDefault();
    e.stopPropagation();
    const originX = e.clientX;
    const s0 = plan.start;
    const d0 = plan.duration;
    let last: PlanDragState = {
      planId: plan.id,
      fromTrackId: trackId,
      toTrackId: trackId,
      start: s0,
      duration: d0,
      mode,
    };
    onPreview(last);
    // Focus for inspector only — do not toggle batch checkboxes.

    const move = (ev: PointerEvent) => {
      let toTrackId = trackId;
      if (mode === "move") {
        const trackEls = document.querySelectorAll<HTMLElement>("[data-plan-track]");
        for (const el of trackEls) {
          const r = el.getBoundingClientRect();
          if (ev.clientY >= r.top && ev.clientY <= r.bottom) {
            toTrackId = el.dataset.planTrack || trackId;
            break;
          }
        }
      }
      const dx = (ev.clientX - originX) / scale;
      let nextStart = s0;
      let nextDur = d0;
      const docNow = useTimeline.getState().doc;
      const canSnap = snapBeats && timelineBeats(docNow).beats.length > 0;
      if (mode === "move") {
        nextStart = Math.max(0, s0 + dx);
        nextDur = d0;
        if (canSnap) nextStart = snapTime(docNow, nextStart, { force: true });
      } else if (mode === "in") {
        const end = s0 + d0;
        nextStart = Math.max(0, Math.min(end - MIN_PLAN, s0 + dx));
        if (canSnap) nextStart = snapTime(docNow, nextStart, { force: true });
        nextDur = end - nextStart;
      } else {
        nextStart = s0;
        const end = Math.max(s0 + MIN_PLAN, s0 + d0 + dx);
        const snappedEnd = canSnap ? snapTime(docNow, end, { force: true }) : end;
        nextDur = Math.max(MIN_PLAN, snappedEnd - s0);
      }
      nextStart = snapToFrame(nextStart);
      nextDur = Math.max(MIN_PLAN, snapToFrame(nextDur));
      const resolved = resolvePreview(toTrackId, nextStart, nextDur, mode);
      last = {
        planId: plan.id,
        fromTrackId: trackId,
        toTrackId,
        start: resolved.start,
        duration: resolved.duration,
        mode,
      };
      onPreview(last);
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const changed =
        last.start !== s0 || last.duration !== d0 || last.toTrackId !== trackId;
      onCommit(changed ? last : null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        if (e.shiftKey) {
          onSelect({ range: true });
          return;
        }
        onSelect({});
      }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).dataset.edge) return;
        if ((e.target as HTMLElement).closest("[data-plan-check]")) return;
        if (e.button !== 0) return;
        if (e.shiftKey) return;
        drag(e, "move");
      }}
      style={{ left: displayStart * scale, width: Math.max(36, displayDuration * scale) }}
      className={clsx(
        "absolute top-1 bottom-1 cursor-grab overflow-hidden rounded-md pl-5 pr-1 ring-1 active:cursor-grabbing",
        statusColor,
        !!plan.reviewNotes?.length && "ring-warn/70",
        selected && "ring-2 ring-accent",
        checked && "ring-2 ring-accent bg-accent/30",
        dragging && "z-30 opacity-90 shadow-lg",
      )}
      title={`${fmtTimecode(displayStart)} · ${Math.round(displayDuration * H3_FPS)} кадр. · Shift — диапазон${plan.reviewNotes?.length ? " · Замечания редактора" : ""}`}
    >
      <label
        data-plan-check="1"
        className="absolute left-0.5 top-0.5 z-20 flex h-4 w-4 cursor-pointer items-center justify-center"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        title="Выбрать для очереди"
      >
        <input
          type="checkbox"
          className="h-3.5 w-3.5 accent-[var(--color-accent,#7dd3fc)]"
          checked={checked}
          onChange={(e) => {
            if ((e.nativeEvent as MouseEvent).shiftKey) onSelect({ range: true });
            else onSelect({ toggle: true });
          }}
          onClick={(e) => {
            if (e.shiftKey) {
              e.preventDefault();
              onSelect({ range: true });
            }
          }}
        />
      </label>
      <span className="pointer-events-none block truncate text-[10px] text-fg">
        {plan.reviewNotes?.length ? "⚠ " : ""}{plan.name || plan.prompt.slice(0, 24) || "план"}
      </span>
      <span className="pointer-events-none text-[9px] text-faint">
        {fmtDuration(displayDuration)} · {Math.round(displayDuration * H3_FPS)}f
      </span>
      <div
        data-edge="1"
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-ew-resize hover:bg-accent/60"
        onPointerDown={(e) => {
          e.stopPropagation();
          drag(e, "in");
        }}
      />
      <div
        data-edge="1"
        className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-ew-resize hover:bg-accent/60"
        onPointerDown={(e) => {
          e.stopPropagation();
          drag(e, "out");
        }}
      />
    </div>
  );
}

function armTimelineReplace(clipId: string, assetId: number) {
  useUI.getState().setTimelineReplace({ clipId, expectSourceAssetId: assetId });
  useUI.getState().toast("После готовности клип на таймлайне обновится сам", "info");
}

function ClipBlock({
  clip,
  asset,
  selected,
  onSelect,
  tall,
  scale,
  onTrim,
  onRemove,
  absolute,
}: {
  clip: Clip;
  asset?: MediaAsset;
  selected: boolean;
  onSelect: () => void;
  tall: boolean;
  scale: number;
  onTrim: (inn: number, out: number) => void;
  onRemove: () => void;
  absolute?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: clip.id });
  const [draft, setDraft] = useState<{ in: number; out: number } | null>(null);
  const shown = draft ?? { in: clip.in, out: clip.out };
  const width = absolute ? "100%" : Math.max(56, (shown.out - shown.in) * scale);
  const srcDur = Math.max(clip.out, asset?.duration ?? clip.out);
  const generations = useLibrary((s) => s.generations);
  const gen = asset?.generation_id != null ? generations[asset.generation_id] : undefined;
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

  const block = (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, width, height: "100%" }}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      className={clsx(
        "relative overflow-hidden rounded-md bg-raised ring-1",
        absolute ? "h-full w-full" : "shrink-0",
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

  if (!asset) return block;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{block}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-40 min-w-56 rounded-xl border border-line bg-panel p-1 shadow-2xl">
          <TlCtxItem
            icon={ScanFace}
            onSelect={() => {
              armTimelineReplace(clip.id, asset.id);
              useUI.getState().openFaceDialog({ assetId: asset.id });
            }}
          >
            Улучшить лицо…
          </TlCtxItem>
          <TlCtxItem
            icon={Sparkles}
            onSelect={() => {
              armTimelineReplace(clip.id, asset.id);
              useUI.getState().openEnhanceDialog({ assetId: asset.id });
            }}
          >
            Детализация (SeedVR2)…
          </TlCtxItem>
          <TlCtxItem
            icon={Gauge}
            onSelect={() => {
              armTimelineReplace(clip.id, asset.id);
              useUI.getState().openInterpolateDialog({ assetId: asset.id });
            }}
          >
            Интерполяция (RIFE)…
          </TlCtxItem>
          <ContextMenu.Separator className="my-1 h-px bg-line" />
          <TlCtxItem
            icon={Pencil}
            disabled={!gen}
            onSelect={() => {
              if (!gen) {
                useUI.getState().toast("Нет связанной генерации — только для клипов из студии", "info");
                return;
              }
              void actions.editAndRetry(gen);
            }}
          >
            Изменить и повторить
          </TlCtxItem>
          <TlCtxItem
            icon={Film}
            disabled={!gen || (gen.kind !== "generate" && gen.kind !== "generate_nvfp4" && gen.kind !== "generate_nvfp4_fast")}
            onSelect={() => {
              if (gen) void actions.retry(gen, false);
            }}
          >
            Повторить с новым сидом
          </TlCtxItem>
          <ContextMenu.Separator className="my-1 h-px bg-line" />
          <TlCtxItem icon={Trash2} danger onSelect={onRemove}>
            Убрать с таймлайна
          </TlCtxItem>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function TlCtxItem({
  icon: Icon,
  children,
  onSelect,
  danger,
  disabled,
}: {
  icon: LucideIcon;
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <ContextMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={clsx(
        "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] outline-none data-[highlighted]:bg-hover data-[disabled]:opacity-40",
        danger ? "text-bad" : "text-fg",
      )}
    >
      <Icon size={13} />
      {children}
    </ContextMenu.Item>
  );
}
