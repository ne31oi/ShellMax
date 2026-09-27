import clsx from "clsx";
import { Film, Maximize2, Minimize2, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { urls } from "../../api/client";
import { on } from "../../lib/bus";
import { fmtTimecode } from "../../lib/format";
import { useLibrary } from "../../store/library";
import { clipAtTime, clipDuration, effectiveVolume, totalDuration, useTimeline, videoTrack, commands } from "../../store/timeline";
import { IconButton } from "../ui";

/** Plays the magnetic video track as one sequence (honours clip in/out). */
export function SequencePlayer() {
  const doc = useTimeline((s) => s.doc);
  const playhead = useTimeline((s) => s.playhead);
  const setPlayhead = useTimeline((s) => s.setPlayhead);
  const playing = useTimeline((s) => s.playing);
  const setPlaying = useTimeline((s) => s.setPlaying);
  const assets = useLibrary((s) => s.assets);
  const video = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const hit = clipAtTime(doc, playhead);
  const asset = hit ? assets[hit.clip.assetId] : undefined;
  const duration = totalDuration(doc);
  const fps = asset?.fps || 24;
  const clipIdRef = useRef<string | null>(null);
  const seekingRef = useRef(false);
  const vol = hit ? effectiveVolume(doc, hit.clip) : 0;
  const muted = vol <= 0.001;

  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  useEffect(() => {
    const v = video.current;
    if (!v || !hit || !asset) return;
    const want = hit.clip.in + hit.local;
    const switched = clipIdRef.current !== hit.clip.id;
    if (switched) {
      clipIdRef.current = hit.clip.id;
      seekingRef.current = true;
      v.src = urls.assetFile(asset.id);
      const onMeta = () => {
        v.currentTime = want;
        seekingRef.current = false;
        if (useTimeline.getState().playing) void v.play().catch(() => undefined);
        v.removeEventListener("loadedmetadata", onMeta);
      };
      v.addEventListener("loadedmetadata", onMeta);
      v.load();
      return;
    }
    if (!seekingRef.current && Math.abs(v.currentTime - want) > 0.25) {
      seekingRef.current = true;
      v.currentTime = want;
      seekingRef.current = false;
    }
  }, [hit?.clip.id, asset?.id]); // eslint-ish: seek on clip change only; playhead scrub handled below

  // External playhead scrub (timeline click) while same clip — not during playback
  useEffect(() => {
    if (playing) return;
    const v = video.current;
    if (!v || !hit || clipIdRef.current !== hit.clip.id) return;
    const want = hit.clip.in + hit.local;
    if (Math.abs(v.currentTime - want) > 0.2) {
      seekingRef.current = true;
      v.currentTime = want;
      seekingRef.current = false;
    }
  }, [playhead, hit, playing]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.volume = Math.max(0, Math.min(1, vol));
    v.muted = muted;
  }, [vol, muted, hit?.clip.id]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (playing) void v.play().catch(() => undefined);
    else v.pause();
  }, [playing]);

  useEffect(() => {
    const offs = [
      on("viewerToggle", () => setPlaying(!useTimeline.getState().playing)),
      on("viewerStep", (n) => {
        setPlaying(false);
        setPlayhead(useTimeline.getState().playhead + n / fps);
      }),
      on("viewerRate", (r) => {
        if (r === 0) setPlaying(false);
        else setPlaying(true);
      }),
      on("viewerFullscreen", () => {
        if (document.fullscreenElement) document.exitFullscreen?.();
        else box.current?.requestFullscreen?.();
      }),
    ];
    return () => offs.forEach((f) => f());
  }, [fps, setPlayhead, setPlaying]);

  const onTimeUpdate = () => {
    const v = video.current;
    if (!v || !hit || seekingRef.current) return;
    if (v.currentTime >= hit.clip.out - 0.04) {
      const nextT = hit.trackStart + clipDuration(hit.clip);
      if (nextT >= duration - 0.02) {
        setPlaying(false);
        setPlayhead(duration);
        return;
      }
      setPlayhead(nextT + 0.001);
      return;
    }
    setPlayhead(hit.trackStart + Math.max(0, v.currentTime - hit.clip.in));
  };

  const seekBar = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    setPlayhead(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration);
  };

  if (!videoTrack(doc).clips.length) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        Добавьте клипы на таймлайн
      </div>
    );
  }

  return (
    <div ref={box} className="flex h-full flex-col bg-bg">
      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black/40 p-3">
          <video
          ref={video}
          className="max-h-full max-w-full rounded-md shadow-2xl"
          muted={muted}
          playsInline
          onClick={() => setPlaying(!playing)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={onTimeUpdate}
          onEnded={() => {
            if (!hit) return;
            const nextT = hit.trackStart + clipDuration(hit.clip);
            if (nextT >= duration - 0.02) {
              setPlaying(false);
              setPlayhead(0);
            } else setPlayhead(nextT + 0.001);
          }}
        />
        <span className="absolute left-5 top-5 rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-semibold text-accent-fg">
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
          <IconButton label="Пуск / пауза (Пробел)" onClick={() => setPlaying(!playing)}>
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
          <IconButton
            label={doc.masterMute ? "Включить звук последовательности" : "Выключить звук последовательности"}
            size="sm"
            onClick={() => useTimeline.getState().run(commands.setMasterMute(useTimeline.getState().doc, !doc.masterMute))}
          >
            {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </IconButton>
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
      <p>Соберите очередь клипов на таймлайне ниже.</p>
      <p className="text-xs text-faint">Обрезка · S — разрез · дорожка звука · экспорт в медиатеку</p>
    </div>
  );
}
