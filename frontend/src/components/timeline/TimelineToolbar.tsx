import {
  Download, Eraser, Film, Magnet, Music2, Plus, Redo2, Scissors, Undo2,
} from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import { fmtTimecode } from "../../lib/format";
import { nearestH3Duration } from "../../lib/planH3";
import { useLibrary } from "../../store/library";
import {
  audioTracks,
  clipDuration,
  commands,
  emptyPlan,
  findClip,
  openPlanInSidebar,
  planTracks,
  snapEnabled,
  timelineBeats,
  useTimeline,
  videoTrack,
  type Clip,
} from "../../store/timeline";
import { useUI } from "../../store/ui";
import { IconButton, Slider } from "../ui";
import { PlanBatchBar } from "./PlanBatchBar";
import { splitAtPlayhead } from "./timelineActions";
import { MIN_PLAN } from "./timelineConstants";

/** Top rail controls: batch queue, beats, tracks, export, undo, zoom. */
export function TimelineToolbar({
  zoom,
  setZoom,
  selectedPlanIds,
  selectedClipId,
  onSelectClip,
}: {
  zoom: number;
  setZoom: (z: number) => void;
  selectedPlanIds: string[];
  selectedClipId: string | null;
  onSelectClip: (id: string | null) => void;
}) {
  const doc = useTimeline((s) => s.doc);
  const run = useTimeline((s) => s.run);
  const undo = useTimeline((s) => s.undo);
  const redo = useTimeline((s) => s.redo);
  const pastLen = useTimeline((s) => s.past.length);
  const futureLen = useTimeline((s) => s.future.length);
  const pastLabel = useTimeline((s) => s.past.at(-1)?.label);
  const futureLabel = useTimeline((s) => s.future[0]?.label);
  const vTrack = videoTrack(doc);
  const aTracks = audioTracks(doc);
  const pTracks = planTracks(doc);
  const { beats, downbeats: downsList } = timelineBeats(doc);
  const [analyzing, setAnalyzing] = useState(false);
  const [exporting, setExporting] = useState(false);

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
      for (const t of audioTracks(d)) {
        for (const c of t.clips) {
          const s = c.start ?? 0;
          if (ph >= s - 1e-3 && ph < s + clipDuration(c) + 1e-3) {
            return { clip: c, trackStart: s };
          }
        }
      }
      if (selectedClipId) {
        const onA = audioTracks(d)
          .flatMap((t) => t.clips.map((c) => ({ c, start: c.start ?? 0 })))
          .find((x) => x.c.id === selectedClipId);
        if (onA) return { clip: onA.c, trackStart: onA.start };
        const onV = findClip(d, selectedClipId);
        if (onV) return { clip: onV.clip, trackStart: onV.trackStart };
      }
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

  return (
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
        onClick={() => splitAtPlayhead({ selectedId: selectedClipId, run, onSelectClip })}
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
  );
}
