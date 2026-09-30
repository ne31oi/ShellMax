import {
  Camera, Gauge, Maximize2, Minimize2, Pause, Play, Repeat, ScanFace, SkipBack, SkipForward,
  Sparkles, Volume2, VolumeX,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { urls } from "../../api/client";
import type { MediaAsset } from "../../api/types";
import * as actions from "../../lib/actions";
import { on } from "../../lib/bus";
import { fmtTimecode } from "../../lib/format";
import { useUI } from "../../store/ui";
import { IconButton } from "../ui";

export function Player({ asset, badge, overlay }: { asset: MediaAsset; badge?: string; overlay?: ReactNode }) {
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
              <IconButton label="Изменить область по маске" onClick={() => useUI.getState().openMaskEditDialog({ assetId: asset.id })}>
                <Camera size={15} />
              </IconButton>
              <IconButton label="Интерполяция (RIFE)" onClick={() => useUI.getState().openInterpolateDialog({ assetId: asset.id })}>
                <Gauge size={15} />
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
