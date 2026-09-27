import clsx from "clsx";
import { Film, Maximize2, Minimize2, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { urls } from "../../api/client";
import { on } from "../../lib/bus";
import { fmtTimecode } from "../../lib/format";
import { useLibrary } from "../../store/library";
import {
  audioClipsAtTime,
  effectiveVolume,
  hasSequenceContent,
  sequenceVisualAtTime,
  totalDuration,
  useTimeline,
} from "../../store/timeline";
import { IconButton } from "../ui";
import { MonitorVolume } from "./MonitorVolume";

/**
 * Montage preview: master-clock playhead drives picture (plans or V) and A-track audio.
 */
export function SequencePlayer() {
  const doc = useTimeline((s) => s.doc);
  const playhead = useTimeline((s) => s.playhead);
  const setPlayhead = useTimeline((s) => s.setPlayhead);
  const playing = useTimeline((s) => s.playing);
  const setPlaying = useTimeline((s) => s.setPlaying);
  const assets = useLibrary((s) => s.assets);
  const video = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const audioPool = useRef(new Map<string, HTMLAudioElement>());
  const visualKeyRef = useRef<string | null>(null);
  const seekingRef = useRef(false);
  const [fullscreen, setFullscreen] = useState(false);

  const duration = totalDuration(doc);
  const visual = sequenceVisualAtTime(doc, playhead);
  const asset = visual ? assets[visual.assetId] : undefined;
  const fps = asset?.fps || 24;
  const masterMute = !!doc.masterMute;
  const masterVol = doc.masterVolume ?? 1;
  const videoMuted = masterMute || (visual?.clipMuted ?? true) || !visual;
  const videoVol = videoMuted ? 0 : Math.max(0, Math.min(1, masterVol));

  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  // Master clock while playing
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const tl = useTimeline.getState();
      const dur = Math.max(totalDuration(tl.doc), 0.01);
      const next = tl.playhead + dt;
      if (next >= dur - 0.001) {
        tl.setPlayhead(dur);
        tl.setPlaying(false);
      } else {
        tl.setPlayhead(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // Picture: switch / seek video element to match playhead
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (!visual || !asset) {
      visualKeyRef.current = null;
      v.removeAttribute("src");
      v.load();
      return;
    }
    const want = visual.sourceTime;
    const switched = visualKeyRef.current !== visual.key;
    if (switched) {
      visualKeyRef.current = visual.key;
      seekingRef.current = true;
      v.src = urls.assetFile(asset.id);
      const onMeta = () => {
        try {
          v.currentTime = want;
        } catch {
          /* ignore */
        }
        seekingRef.current = false;
        if (useTimeline.getState().playing) void v.play().catch(() => undefined);
        else v.pause();
        v.removeEventListener("loadedmetadata", onMeta);
      };
      v.addEventListener("loadedmetadata", onMeta);
      v.load();
      return;
    }
    if (!seekingRef.current && Math.abs(v.currentTime - want) > 0.12) {
      seekingRef.current = true;
      try {
        v.currentTime = want;
      } catch {
        /* ignore */
      }
      seekingRef.current = false;
    }
  }, [visual?.key, visual?.sourceTime, asset?.id, playhead]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.volume = videoVol;
    v.muted = videoMuted;
  }, [videoVol, videoMuted, visual?.key]);

  useEffect(() => {
    const v = video.current;
    if (!v || !visual) return;
    if (playing) void v.play().catch(() => undefined);
    else v.pause();
  }, [playing, visual?.key]);

  // A-track audio pool synced to playhead
  useEffect(() => {
    const active = audioClipsAtTime(doc, playhead);
    const wantIds = new Set(active.map((a) => a.clip.id));
    const pool = audioPool.current;

    for (const [id, el] of [...pool.entries()]) {
      if (!wantIds.has(id)) {
        el.pause();
        el.removeAttribute("src");
        pool.delete(id);
      }
    }

    for (const { clip, local } of active) {
      let el = pool.get(clip.id);
      if (!el) {
        el = new Audio();
        el.preload = "auto";
        el.src = urls.assetFile(clip.assetId);
        pool.set(clip.id, el);
      }
      const want = clip.in + local;
      const vol = effectiveVolume(doc, clip);
      el.volume = vol;
      el.muted = vol <= 0.001;
      if (Math.abs(el.currentTime - want) > 0.15) {
        try {
          el.currentTime = want;
        } catch {
          /* ignore */
        }
      }
      if (playing && vol > 0.001) void el.play().catch(() => undefined);
      else el.pause();
    }
  }, [doc, playhead, playing]);

  useEffect(() => {
    return () => {
      for (const el of audioPool.current.values()) {
        el.pause();
        el.removeAttribute("src");
      }
      audioPool.current.clear();
    };
  }, []);

  useEffect(() => {
    const offs = [
      on("viewerToggle", () => {
        const tl = useTimeline.getState();
        if (!hasSequenceContent(tl.doc)) return;
        if (tl.playhead >= totalDuration(tl.doc) - 0.02) tl.setPlayhead(0);
        tl.setPlaying(!tl.playing);
      }),
      on("viewerStep", (n) => {
        setPlaying(false);
        setPlayhead(useTimeline.getState().playhead + n / fps);
      }),
      on("viewerRate", (r) => {
        if (r === 0) setPlaying(false);
        else {
          const tl = useTimeline.getState();
          if (tl.playhead >= totalDuration(tl.doc) - 0.02) tl.setPlayhead(0);
          setPlaying(true);
        }
      }),
      on("viewerFullscreen", () => {
        if (document.fullscreenElement) document.exitFullscreen?.();
        else box.current?.requestFullscreen?.();
      }),
    ];
    return () => offs.forEach((f) => f());
  }, [fps, setPlayhead, setPlaying]);

  const seekBar = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    setPlaying(false);
    setPlayhead(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration);
  };

  const togglePlay = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (playhead >= duration - 0.02) setPlayhead(0);
    setPlaying(true);
  };

  if (!hasSequenceContent(doc)) {
    return <SequenceEmptyHint />;
  }

  return (
    <div ref={box} className="flex h-full flex-col bg-bg">
      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black/40 p-3">
        {visual && asset ? (
          <video
            ref={video}
            className="max-h-full max-w-full rounded-md shadow-2xl"
            muted={videoMuted}
            playsInline
            onClick={togglePlay}
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-sm text-muted">
            <Film size={28} className="opacity-40" />
            <p>{audioClipsAtTime(doc, playhead).length ? "Только звук в этой точке" : "Нет картинки под курсором"}</p>
          </div>
        )}
        <span className="absolute left-5 top-5 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] text-white/80">
          Последовательность
        </span>
        {asset && (
          <span className="absolute right-5 top-5 max-w-[40%] truncate rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] text-white">
            {asset.name}
          </span>
        )}
      </div>
      <div className="border-t border-line px-3 py-2">
        <div className="group relative mb-2 h-1.5 cursor-pointer rounded-full bg-line" onMouseDown={seekBar}>
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-accent"
            style={{ width: `${duration ? (playhead / duration) * 100 : 0}%` }}
          />
        </div>
        <div className="flex items-center gap-1">
          <IconButton
            label="Кадр назад"
            size="sm"
            onClick={() => {
              setPlaying(false);
              setPlayhead(playhead - 1 / fps);
            }}
          >
            <SkipBack size={14} />
          </IconButton>
          <IconButton label="Пуск / пауза (Пробел)" onClick={togglePlay}>
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </IconButton>
          <IconButton
            label="Кадр вперёд"
            size="sm"
            onClick={() => {
              setPlaying(false);
              setPlayhead(playhead + 1 / fps);
            }}
          >
            <SkipForward size={14} />
          </IconButton>
          <span className="ml-2 font-mono text-xs text-muted tabular-nums">
            {fmtTimecode(playhead, fps)} <span className="text-faint">/ {fmtTimecode(duration, fps)}</span>
          </span>
          <span className="ml-auto" />
          <MonitorVolume size="md" />
          <IconButton
            label={fullscreen ? "Свернуть" : "Во весь экран"}
            size="sm"
            onClick={() => {
              if (document.fullscreenElement) document.exitFullscreen?.();
              else box.current?.requestFullscreen?.();
            }}
          >
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </IconButton>
        </div>
      </div>
    </div>
  );
}

export function SequenceEmptyHint() {
  return (
    <div className={clsx("flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted")}>
      <Film size={28} className="opacity-40" />
      <p>Соберите монтаж на таймлайне ниже.</p>
      <p className="text-xs text-faint">Планы · аудио · клипы на V · Пробел — пуск</p>
    </div>
  );
}
