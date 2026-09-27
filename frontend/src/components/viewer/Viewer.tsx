import clsx from "clsx";
import {
  AlertCircle, Camera, Copy, Dices, Maximize2, Minimize2, Pause, Pencil, Play, Repeat, ScanFace, SkipBack, SkipForward,
  Sparkles, SplitSquareHorizontal, Square, Volume2, VolumeX, X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { urls } from "../../api/client";
import type { FaceStrength, Generation, MediaAsset } from "../../api/types";
import * as actions from "../../lib/actions";
import { on } from "../../lib/bus";
import { stageIndex, stageInfo, stagesOf, stepProgress, timeBreakdown, trackSummary } from "../../lib/stages";
import { fmtDuration, fmtEstimate, fmtTimecode } from "../../lib/format";
import { useElapsed } from "../../lib/useElapsed";
import { useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { Button, Dialog, IconButton, Kbd, Spinner } from "../ui";
import { Welcome } from "./Welcome";

const EMPTY_FACE_STRENGTH: FaceStrength[] = [];

export function Viewer() {
  const selectedGen = useUI((s) => s.selectedGen);
  const selectedAsset = useUI((s) => s.selectedAsset);
  const compareWith = useUI((s) => s.compareWith);
  const gen = useLibrary((s) => (selectedGen ? s.generations[selectedGen] : undefined));
  const other = useLibrary((s) => (compareWith ? s.generations[compareWith] : undefined));
  const assets = useLibrary((s) => s.assets);
  const preview = useLibrary((s) => (selectedGen ? s.previews[selectedGen] : undefined));
  const [resultOnly, setResultOnly] = useState(false);
  useEffect(() => setResultOnly(false), [selectedGen]);

  if (!gen && !selectedAsset) return <Welcome />;

  if (selectedAsset && assets[selectedAsset]) {
    return (
      <div className="flex h-full flex-col">
        <Player asset={assets[selectedAsset]} />
      </div>
    );
  }
  if (!gen) return <Welcome />;

  const draft = gen.draft_asset_id ? assets[gen.draft_asset_id] : undefined;
  const final = gen.output_asset_id ? assets[gen.output_asset_id] : undefined;
  const otherAsset = actions.outputAsset(other, assets);
  const sourceAsset =
    (gen.kind === "face" || gen.kind === "enhance") && gen.source_asset_id
      ? assets[gen.source_asset_id]
      : undefined;
  const showBeforeAfter = !!final && !!sourceAsset && !resultOnly && !otherAsset;

  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        {showBeforeAfter ? (
          // face / enhance: open straight into the before | after wipe against the source clip
          <CompareView
            a={sourceAsset}
            b={final}
            labelA="До"
            labelB="После"
            onClose={() => setResultOnly(true)}
            closeLabel="Только результат"
          />
        ) : gen.kind === "face" && gen.status === "running" && draft ? (
          <Player asset={draft} badge="Трекинг" overlay={<FaceTrackBanner gen={gen} />} />
        ) : final && otherAsset ? (
          <CompareView a={final} b={otherAsset} labelA={`#${gen.id}`} labelB={`#${other!.id}`} />
        ) : final || (draft && gen.status !== "running") ? (
          <Player asset={(final ?? draft)!} badge={!final ? "Черновик" : undefined} />
        ) : gen.status === "running" && draft ? (
          <Player asset={draft} badge="Черновик" overlay={<DraftBanner gen={gen} />} />
        ) : gen.status === "running" || gen.status === "queued" ? (
          <LiveView gen={gen} preview={preview} />
        ) : gen.status === "error" ? (
          <ErrorView gen={gen} />
        ) : (
          <div className="flex h-full items-center justify-center text-muted">Генерация отменена</div>
        )}
      </div>
      <ClipInfo
        gen={gen}
        comparing={showBeforeAfter}
        canToggleCompare={!!final && !!sourceAsset && !otherAsset}
        onToggleCompare={() => setResultOnly((v) => !v)}
      />
    </div>
  );
}

// ---------------------------------------------------------------- live progress
function LiveView({ gen, preview }: { gen: Generation; preview?: string }) {
  const elapsed = useElapsed(gen.status === "running" ? gen.started : null);
  const left = elapsed != null && gen.estimate_s ? Math.max(0, gen.estimate_s - elapsed) : null;

  const stage = stageInfo(gen.stage, gen);
  const step = stepProgress(gen);
  const queued = gen.status === "queued";

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 p-6">
      <div className="relative aspect-video w-full max-w-3xl overflow-hidden rounded-xl bg-raised">
        {preview ? <img src={preview} alt="" className="h-full w-full object-contain" /> : <div className="shimmer h-full w-full" />}
      </div>

      <div className="w-full max-w-3xl">
        {/* current stage: what is happening right now and how far along it is */}
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">{queued ? "В очереди" : stage.label}</p>
            <p className="mt-0.5 text-xs text-muted tabular-nums">
              {queued ? "Начнётся, когда освободится движок" : step ? `шаг ${step.value} из ${step.max}` : "выполняется…"}
            </p>
          </div>
          {!queued && (
            <div className="shrink-0 text-right">
              <span className="text-2xl font-semibold tabular-nums">{step ? `${step.pct}%` : <Spinner size={18} />}</span>
              {elapsed != null && (
                <p className="mt-0.5 text-xs text-muted tabular-nums" title="Время текущего прогона">
                  {fmtDuration(elapsed)}
                  {gen.estimate_s ? ` / ${fmtEstimate(gen.estimate_s)}` : ""}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
          {step ? (
            <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${step.pct}%` }} />
          ) : (
            !queued && <div className="shimmer h-full w-full bg-accent/30" />
          )}
        </div>

        <StageTrack gen={gen} />

        <div className="mt-4 flex items-center justify-between text-xs text-faint tabular-nums">
          <span>
            Всего {Math.round(gen.progress * 100)}%
            {elapsed != null ? ` · идёт ${fmtDuration(elapsed)}` : ""}
            {left != null ? ` · осталось ${fmtEstimate(left)}` : ""}
          </span>
          <Button variant="ghost" size="sm" onClick={() => actions.cancel(gen)}>
            <Square size={12} /> {queued ? "Убрать из очереди" : "Остановить"}
          </Button>
        </div>
        {!gen.draft_asset_id && !queued && (
          <p className="mt-1 text-center text-[11px] text-faint">
            {gen.kind === "face"
              ? "Сначала найдём лицо на каждом кадре — покажем превью трекинга"
              : "Черновик появится после первого прохода — тогда можно будет не ждать финал"}
          </p>
        )}
      </div>
    </div>
  );
}

/** All stages in a row: done / current (with its percent) / upcoming. */
function StageTrack({ gen }: { gen: Generation }) {
  const current = gen.status === "queued" ? -1 : stageIndex(gen.stage, gen);
  const step = stepProgress(gen);
  const stages = stagesOf(gen);
  return (
    <div className="mt-4 grid gap-1" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}>
      {stages.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <div key={s.id} title={s.label} className="min-w-0">
            <div className="h-1 overflow-hidden rounded-full bg-line">
              <div
                className={clsx("h-full rounded-full", done ? "bg-accent" : active ? "bg-accent transition-[width] duration-300" : "")}
                style={{ width: done ? "100%" : active ? `${step?.pct ?? 8}%` : "0%" }}
              />
            </div>
            <p className={clsx("mt-1 truncate text-[10px] tabular-nums", active ? "text-fg" : done ? "text-muted" : "text-faint")}>
              {s.short}
              {active && step ? ` ${step.pct}%` : ""}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function DraftBanner({ gen }: { gen: Generation }) {
  const step = stepProgress(gen);
  const elapsed = useElapsed(gen.started);
  return (
    <div className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-warn/40 bg-panel/95 px-3 py-2 shadow-xl backdrop-blur">
      <span className="text-xs tabular-nums">
        <b className="text-warn">Черновик готов.</b> {stageInfo(gen.stage, gen).short}
        {step ? ` · шаг ${step.value}/${step.max} · ${step.pct}%` : ""}
        <span className="text-faint">
          {" "}· всего {Math.round(gen.progress * 100)}%
          {elapsed != null ? ` · ${fmtDuration(elapsed)}` : ""}
        </span>
      </span>
      <Button size="sm" variant="outline" onClick={() => actions.cancel(gen)}>
        Не нравится — остановить
      </Button>
    </div>
  );
}

/** Face job: the tracking preview is ready - say whether the face was found while refining goes on. */
function FaceTrackBanner({ gen }: { gen: Generation }) {
  const step = stepProgress(gen);
  const elapsed = useElapsed(gen.started);
  const t = trackSummary(gen.info?.track_report);
  return (
    <div className="absolute left-1/2 top-3 flex max-w-[90%] -translate-x-1/2 items-center gap-3 rounded-xl border border-line bg-panel/95 px-3 py-2 shadow-xl backdrop-blur">
      <span className="text-xs tabular-nums">
        {t ? <b className={t.warn ? "text-warn" : "text-ok"}>{t.found}.</b> : <b>Трекинг готов.</b>}{" "}
        {t?.warn ?? t?.size ?? ""}
        <span className="text-faint">
          {" "}· {stageInfo(gen.stage, gen).short}
          {step ? ` ${step.value}/${step.max}` : ""} · всего {Math.round(gen.progress * 100)}%
          {elapsed != null ? ` · ${fmtDuration(elapsed)}` : ""}
        </span>
      </span>
      <Button size="sm" variant="outline" onClick={() => actions.cancel(gen)}>
        Остановить
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- error with one-click fixes
function ErrorView({ gen }: { gen: Generation }) {
  const openSettings = useUI((s) => s.openSettings);
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md rounded-2xl border border-bad/30 bg-bad/5 p-5">
        <div className="mb-2 flex items-center gap-2 text-bad">
          <AlertCircle size={18} />
          <span className="font-semibold">Не получилось</span>
        </div>
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg">{gen.error}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {gen.error_kind === "oom" && gen.kind === "generate" && (
            <>
              <Button size="sm" variant="primary" onClick={() => actions.fixes.lowerQuality(gen)}>Снизить качество</Button>
              <Button size="sm" onClick={() => actions.fixes.enableLowVram().then(() => actions.retry(gen, true))}>Включить экономию VRAM и повторить</Button>
            </>
          )}
          {gen.error_kind === "oom" && gen.kind === "enhance" && gen.source_asset_id && (
            <>
              <Button size="sm" variant="primary" onClick={() => useUI.getState().openEnhanceDialog({ assetId: gen.source_asset_id! })}>
                Уменьшить масштаб и повторить
              </Button>
              <Button size="sm" onClick={() => actions.fixes.enableLowVram().then(() => actions.retry(gen, true))}>
                Включить экономию VRAM и повторить
              </Button>
            </>
          )}
          {gen.error_kind === "oom" && gen.kind === "face" && (
            <Button size="sm" onClick={() => actions.fixes.enableLowVram().then(() => actions.retry(gen, true))}>
              Включить экономию VRAM и повторить
            </Button>
          )}
          {gen.error_kind === "missing_file" && (
            <Button size="sm" variant="primary" onClick={() => openSettings("engine")}>Открыть настройки движка</Button>
          )}
          {gen.error_kind === "engine_down" && (
            <Button size="sm" variant="primary" onClick={() => openSettings("system")}>Состояние движка</Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => actions.retry(gen, true)}>Повторить</Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- player
export function Player({ asset, badge, overlay }: { asset: MediaAsset; badge?: string; overlay?: React.ReactNode }) {
  const video = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(asset.duration ?? 0);
  // sound is off by default; the choice is remembered
  const [muted, setMutedState] = useState(() => localStorage.getItem("sm.muted") !== "0");
  const setMuted = (m: boolean) => {
    localStorage.setItem("sm.muted", m ? "1" : "0");
    setMutedState(m);
  };
  const [loop, setLoop] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const fps = asset.fps || 24;

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else box.current?.requestFullscreen?.();
  };

  useEffect(() => {
    setTime(0);
    setPlaying(false);
  }, [asset.id]);

  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  useEffect(() => {
    const offs = [
      on("viewerToggle", () => {
        const v = video.current;
        if (v) v.paused ? v.play() : v.pause();
      }),
      on("viewerStep", (n) => {
        const v = video.current;
        if (!v) return;
        v.pause();
        v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + n / fps));
      }),
      on("viewerRate", (r) => {
        const v = video.current;
        if (!v) return;
        if (r === 0) v.pause();
        else {
          v.playbackRate = r > 0 ? Math.min(4, (v.paused ? 0 : v.playbackRate) + 1) : 1;
          if (r < 0) v.currentTime = Math.max(0, v.currentTime - 1);
          v.play();
        }
      }),
      on("viewerFullscreen", toggleFullscreen),
    ];
    return () => offs.forEach((f) => f());
  }, [fps]);

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const v = video.current;
    if (!v || !duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    v.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration;
  };

  return (
    <div ref={box} className="flex h-full flex-col bg-bg">
      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black/40 p-3">
        <video
          ref={video}
          key={asset.id}
          src={urls.assetFile(asset.id)}
          className="max-h-full max-w-full rounded-md shadow-2xl"
          loop={loop}
          muted={muted}
          autoPlay
          onClick={() => (video.current?.paused ? video.current.play() : video.current?.pause())}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        />
        {badge && <span className="absolute left-5 top-5 rounded-md bg-warn px-1.5 py-0.5 text-[11px] font-semibold text-black">{badge}</span>}
        {overlay}
      </div>
      <div className="border-t border-line px-3 py-2">
        <div className="group relative mb-2 h-1.5 cursor-pointer rounded-full bg-line" onMouseDown={seek}>
          <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${duration ? (time / duration) * 100 : 0}%` }} />
        </div>
        <div className="flex items-center gap-1">
          <IconButton label="Кадр назад (←)" size="sm" onClick={() => videoStep(video.current, -1, fps)}><SkipBack size={14} /></IconButton>
          <IconButton label="Пуск / пауза (Пробел)" onClick={() => (video.current?.paused ? video.current.play() : video.current?.pause())}>
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </IconButton>
          <IconButton label="Кадр вперёд (→)" size="sm" onClick={() => videoStep(video.current, 1, fps)}><SkipForward size={14} /></IconButton>
          <span className="ml-2 font-mono text-xs text-muted tabular-nums">
            {fmtTimecode(time, fps)} <span className="text-faint">/ {fmtTimecode(duration, fps)}</span>
          </span>
          <span className="ml-auto" />
          {asset.kind === "video" && (
            <>
              <IconButton label="Улучшить лицо" onClick={() => useUI.getState().openFaceDialog({ assetId: asset.id })}>
                <ScanFace size={15} />
              </IconButton>
              <IconButton label="Детализация (SeedVR2)" onClick={() => useUI.getState().openEnhanceDialog({ assetId: asset.id })}>
                <Sparkles size={15} />
              </IconButton>
            </>
          )}
          <IconButton
            label="Этот кадр — в референсы"
            onClick={() => {
              video.current?.pause();
              actions.frameAsRef(asset, video.current?.currentTime ?? 0);
            }}
          >
            <Camera size={15} />
          </IconButton>
          <IconButton label="Повтор" active={loop} size="sm" onClick={() => setLoop(!loop)}><Repeat size={14} /></IconButton>
          <IconButton label={muted ? "Включить звук" : "Выключить звук"} size="sm" onClick={() => setMuted(!muted)}>
            {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </IconButton>
          <IconButton
            label={fullscreen ? "Свернуть (F / Esc)" : "Во весь экран (F)"}
            size="sm"
            onClick={toggleFullscreen}
          >
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function videoStep(v: HTMLVideoElement | null, n: number, fps: number) {
  if (!v) return;
  v.pause();
  v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + n / fps));
}

// ---------------------------------------------------------------- A/B wipe
function CompareView({ a, b, labelA, labelB, onClose, closeLabel = "Закрыть сравнение" }: {
  a: MediaAsset; b: MediaAsset; labelA: string; labelB: string; onClose?: () => void; closeLabel?: string;
}) {
  const va = useRef<HTMLVideoElement>(null);
  const vb = useRef<HTMLVideoElement>(null);
  const [split, setSplit] = useState(0.5);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // keep B locked to A's clock
    const t = setInterval(() => {
      if (va.current && vb.current && Math.abs(va.current.currentTime - vb.current.currentTime) > 0.05) {
        vb.current.currentTime = va.current.currentTime;
      }
    }, 200);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div
        ref={box}
        className="relative m-3 flex-1 cursor-ew-resize overflow-hidden rounded-md bg-black"
        onMouseMove={(e) => {
          if (e.buttons !== 1) return;
          const r = box.current!.getBoundingClientRect();
          setSplit(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
        }}
        onMouseDown={(e) => {
          const r = box.current!.getBoundingClientRect();
          setSplit(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
        }}
      >
        <video ref={va} src={urls.assetFile(a.id)} autoPlay loop muted className="absolute inset-0 h-full w-full object-contain"
          onPlay={() => vb.current?.play()} onPause={() => vb.current?.pause()} />
        <video ref={vb} src={urls.assetFile(b.id)} autoPlay loop muted className="absolute inset-0 h-full w-full object-contain"
          style={{ clipPath: `inset(0 0 0 ${split * 100}%)` }} />
        <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white/80" style={{ left: `${split * 100}%` }} />
        <span className="absolute left-3 top-3 rounded bg-black/70 px-1.5 text-xs">{labelA}</span>
        <span className="absolute right-3 top-3 rounded bg-black/70 px-1.5 text-xs">{labelB}</span>
      </div>
      <div className="flex items-center justify-center gap-2 pb-2 text-xs text-muted">
        Тяните по кадру, чтобы сдвинуть шторку
        <Button size="sm" variant="ghost" onClick={onClose ?? (() => useUI.getState().compare(null))}>
          <X size={12} /> {closeLabel}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- selected clip details + actions
function ClipInfo({
  gen,
  comparing,
  canToggleCompare,
  onToggleCompare,
}: {
  gen: Generation;
  comparing?: boolean;
  canToggleCompare?: boolean;
  onToggleCompare?: () => void;
}) {
  if (gen.kind === "face") {
    return (
      <FaceClipInfo
        gen={gen}
        comparing={comparing}
        canToggleCompare={canToggleCompare}
        onToggleCompare={onToggleCompare}
      />
    );
  }
  if (gen.kind === "enhance") {
    return (
      <EnhanceClipInfo
        gen={gen}
        comparing={comparing}
        canToggleCompare={canToggleCompare}
        onToggleCompare={onToggleCompare}
      />
    );
  }
  return <GenerationClipInfo gen={gen} />;
}

function CompareToggle({
  comparing,
  canToggle,
  onToggle,
}: {
  comparing?: boolean;
  canToggle?: boolean;
  onToggle?: () => void;
}) {
  if (!canToggle || !onToggle) return null;
  return (
    <Button
      size="sm"
      variant={comparing ? "subtle" : "ghost"}
      onClick={onToggle}
      title={comparing ? "Показать только результат" : "Сравнить с исходником"}
    >
      <SplitSquareHorizontal size={13} />
      {comparing ? "Только результат" : "Сравнить"}
    </Button>
  );
}

function EnhanceClipInfo({
  gen,
  comparing,
  canToggleCompare,
  onToggleCompare,
}: {
  gen: Generation;
  comparing?: boolean;
  canToggleCompare?: boolean;
  onToggleCompare?: () => void;
}) {
  const source = useLibrary((s) => (gen.source_asset_id ? s.assets[gen.source_asset_id] : undefined));
  const scale = gen.ui_params.scale ?? 2;
  const color = gen.ui_params.color_correction ?? "none";
  const colorLabel =
    useLibrary((s) => s.meta?.enhance_color?.find((c) => c.id === color)?.label) ?? color;
  return (
    <div className="border-t border-line bg-panel px-4 py-2.5">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1 text-xs leading-relaxed text-muted">
          <p className="text-fg">
            <Sparkles size={13} className="mr-1 inline text-accent" />
            Детализация SeedVR2{source ? ` · «${source.name}»` : ""}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <CompareToggle comparing={comparing} canToggle={canToggleCompare} onToggle={onToggleCompare} />
          {gen.status === "done" && source && (
            <Button size="sm" variant="ghost" onClick={() => useUI.getState().selectAsset(source.id)} title="Открыть исходный клип">
              Исходник
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => actions.retry(gen, false)} title="Ещё одна попытка с другим сидом">
            <Dices size={13} /> Ещё раз
          </Button>
          <Button size="sm" variant="ghost" onClick={() => actions.editAndRetry(gen)}>
            <Pencil size={13} /> Изменить
          </Button>
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-faint tabular-nums">
        <span>#{gen.id}</span>
        <span>×{scale}</span>
        <span>{colorLabel}</span>
        <span>сид {gen.seed}</span>
        {gen.elapsed_s && <span title={timeBreakdown(gen)}>готово за {fmtDuration(gen.elapsed_s)}</span>}
      </div>
    </div>
  );
}

function FaceClipInfo({
  gen,
  comparing,
  canToggleCompare,
  onToggleCompare,
}: {
  gen: Generation;
  comparing?: boolean;
  canToggleCompare?: boolean;
  onToggleCompare?: () => void;
}) {
  const source = useLibrary((s) => (gen.source_asset_id ? s.assets[gen.source_asset_id] : undefined));
  const presets = useLibrary((s) => s.meta?.face_strength) ?? EMPTY_FACE_STRENGTH;
  const preset = presets.find((p) => Math.abs(p.denoise - (gen.ui_params.denoise ?? 0)) < 1e-6);
  const t = trackSummary(gen.info?.track_report);
  return (
    <div className="border-t border-line bg-panel px-4 py-2.5">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1 text-xs leading-relaxed text-muted">
          <p className="text-fg">
            <ScanFace size={13} className="mr-1 inline text-accent" />
            Улучшение лица{source ? ` · «${source.name}»` : ""}
          </p>
          {t && (
            <p className={t.warn ? "text-warn" : ""}>
              {t.found}
              {t.warn ? ` · ${t.warn}` : t.size ? ` · ${t.size}` : ""}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <CompareToggle comparing={comparing} canToggle={canToggleCompare} onToggle={onToggleCompare} />
          {gen.status === "done" && source && (
            <Button size="sm" variant="ghost" onClick={() => useUI.getState().selectAsset(source.id)} title="Открыть исходный клип">
              Исходник
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => actions.retry(gen, false)} title="Ещё одна попытка с другим сидом">
            <Dices size={13} /> Ещё раз
          </Button>
          <Button size="sm" variant="ghost" onClick={() => actions.editAndRetry(gen)}>
            <Pencil size={13} /> Изменить
          </Button>
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-faint tabular-nums">
        <span>#{gen.id}</span>
        <span>сила: {preset?.label ?? gen.ui_params.denoise}</span>
        <span>сид {gen.seed}</span>
        {gen.elapsed_s && <span title={timeBreakdown(gen)}>готово за {fmtDuration(gen.elapsed_s)}</span>}
      </div>
    </div>
  );
}

function GenerationClipInfo({ gen }: { gen: Generation }) {
  const styles = useLibrary((s) => s.styles);
  const quality = useLibrary((s) => s.meta?.quality.find((q) => q.id === gen.ui_params.quality));
  const p = gen.ui_params;
  const aspect = p.aspect;
  const res = aspect && quality?.resolutions?.[aspect]?.final;
  const styleNames = (p.styles ?? []).map((st) => styles.find((s) => s.id === st.style_id)?.name).filter(Boolean);
  const [promptOpen, setPromptOpen] = useState(false);
  // Exact prompt sent to ComfyUI (style triggers / look already applied)
  const prompt = (typeof gen.full_params?.prompt === "string" ? gen.full_params.prompt : p.prompt)?.trim() ?? "";

  return (
    <div className="border-t border-line bg-panel px-4 py-2.5">
      <div className="flex items-start gap-4">
        {prompt ? (
          <button
            type="button"
            onClick={() => setPromptOpen(true)}
            className="line-clamp-2 min-w-0 flex-1 text-left text-xs leading-relaxed text-muted hover:text-fg"
            title="Промпт, ушедший в генерацию"
          >
            {prompt}
          </button>
        ) : (
          <p className="min-w-0 flex-1 text-xs text-faint">Без промпта</p>
        )}
        <div className="flex shrink-0 gap-1">
          {prompt && (
            <Button size="sm" variant="ghost" onClick={() => setPromptOpen(true)} title="Промпт генерации">
              Промпт
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => actions.retry(gen, false)} title="Повторить с новым сидом">
            <Dices size={13} /> Ещё раз
          </Button>
          <Button size="sm" variant="ghost" onClick={() => actions.retry(gen, true)} title="Тот же сид — тот же результат">
            <Copy size={13} /> Точно
          </Button>
          <Button size="sm" variant="ghost" onClick={() => actions.editAndRetry(gen)}>
            <Pencil size={13} /> Изменить
          </Button>
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-faint tabular-nums">
        <span>#{gen.id}</span>
        {aspect && <span>{aspect.split(" ")[0]}</span>}
        {res && <span>{res[0]}×{res[1]}</span>}
        {quality?.label && <span>{quality.label}</span>}
        <span>сид {gen.seed}</span>
        {styleNames.length > 0 && <span>стиль: {styleNames.join(", ")}</span>}
        {(p.refs?.length ?? 0) > 0 && <span>референсов: {p.refs!.length}</span>}
        {gen.elapsed_s && <span title={timeBreakdown(gen)}>создано за {fmtDuration(gen.elapsed_s)}</span>}
        <span className="ml-auto hidden xl:inline">
          <Kbd>Пробел</Kbd> пуск · <Kbd>←</Kbd>
          <Kbd>→</Kbd> кадр · <Kbd>F</Kbd> экран
        </span>
      </div>
      <PromptDialog open={promptOpen} onOpenChange={setPromptOpen} prompt={prompt} genId={gen.id} />
    </div>
  );
}

function PromptDialog({
  open,
  onOpenChange,
  prompt,
  genId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  prompt: string;
  genId: number;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      useUI.getState().toast("Не удалось скопировать", "bad");
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Промпт генерации · #${genId}`} wide>
      <div className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2">
          <p className="flex-1 text-[11px] text-muted">Точный текст, ушедший в граф (с триггерами стилей).</p>
          <Button size="sm" variant="outline" onClick={copy}>
            <Copy size={13} /> {copied ? "Скопировано" : "Копировать"}
          </Button>
        </div>
        <pre className="max-h-[min(70vh,32rem)] overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-raised p-3 font-mono text-[12px] leading-relaxed text-fg">
          {prompt}
        </pre>
      </div>
    </Dialog>
  );
}
