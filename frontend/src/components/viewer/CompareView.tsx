import { Pause, Play, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { urls } from "../../api/client";
import type { MediaAsset } from "../../api/types";
import { on } from "../../lib/bus";
import { useUI } from "../../store/ui";
import { Button, IconButton } from "../ui";

export function CompareView({ a, b, labelA, labelB, onClose, closeLabel = "Закрыть сравнение" }: {
  a: MediaAsset; b: MediaAsset; labelA: string; labelB: string; onClose?: () => void; closeLabel?: string;
}) {
  const va = useRef<HTMLVideoElement>(null);
  const vb = useRef<HTMLVideoElement>(null);
  const [split, setSplit] = useState(0.5);
  const [playing, setPlaying] = useState(true);
  const playingRef = useRef(true);
  const box = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);
  const synced = useRef(false);
  const lastMirror = useRef(-1);
  playingRef.current = playing;

  /** B is a paused slave of A — free-running clocks drift and the wipe shows mismatched frames. */
  const mirror = (force = false) => {
    const master = va.current;
    const slave = vb.current;
    if (!master || !slave || slave.seeking) return;
    if (!slave.paused) slave.pause();
    const t = master.currentTime;
    if (!force && Math.abs(t - lastMirror.current) < 0.0005) return;
    if (!force && Math.abs(t - slave.currentTime) < 0.001) {
      lastMirror.current = t;
      return;
    }
    try {
      slave.currentTime = t;
      lastMirror.current = t;
    } catch {
      /* ignore mid-load */
    }
  };

  const trySync = () => {
    const master = va.current;
    const slave = vb.current;
    if (!master || !slave || synced.current) return;
    if (master.readyState < 2 || slave.readyState < 2) return;
    synced.current = true;
    master.pause();
    slave.pause();
    lastMirror.current = -1;
    master.currentTime = 0;
    const afterSeek = () => {
      slave.removeEventListener("seeked", afterSeek);
      mirror(true);
      if (playingRef.current) void master.play().catch(() => undefined);
    };
    slave.addEventListener("seeked", afterSeek, { once: true });
    slave.currentTime = 0;
  };

  useEffect(() => {
    synced.current = false;
    lastMirror.current = -1;
    setPlaying(true);
    playingRef.current = true;
    let raf = 0;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      mirror(false);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // One side may keep the same asset id (e.g. two enhances of one source) — loadedData won't re-fire.
    const boot = requestAnimationFrame(() => trySync());
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(boot);
      va.current?.pause();
      vb.current?.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.id, b.id]);

  useEffect(() => {
    return on("viewerToggle", () => {
      const v = va.current;
      if (!v) return;
      if (v.paused) void v.play().catch(() => undefined);
      else {
        v.pause();
        mirror(true);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.id, b.id]);

  const togglePlay = () => {
    const v = va.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => undefined);
    else {
      v.pause();
      mirror(true);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div
        ref={box}
        className="relative m-3 flex-1 cursor-ew-resize overflow-hidden rounded-md bg-black"
        onMouseMove={(e) => {
          if (e.buttons !== 1) return;
          scrubbing.current = true;
          const r = box.current!.getBoundingClientRect();
          setSplit(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
        }}
        onMouseDown={(e) => {
          scrubbing.current = false;
          const r = box.current!.getBoundingClientRect();
          setSplit(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
        }}
        onClick={() => {
          if (scrubbing.current) {
            scrubbing.current = false;
            return;
          }
          togglePlay();
        }}
      >
        <video
          key={`cmp-a-${a.id}`}
          ref={va}
          src={urls.assetFile(a.id)}
          muted
          loop
          playsInline
          preload="auto"
          className="absolute inset-0 h-full w-full object-contain"
          onLoadedData={trySync}
          onPlay={() => setPlaying(true)}
          onPause={() => {
            setPlaying(false);
            mirror(true);
          }}
          onSeeked={() => mirror(true)}
        />
        <video
          key={`cmp-b-${b.id}`}
          ref={vb}
          src={urls.assetFile(b.id)}
          muted
          playsInline
          preload="auto"
          className="pointer-events-none absolute inset-0 h-full w-full object-contain"
          style={{ clipPath: `inset(0 0 0 ${split * 100}%)` }}
          onLoadedData={trySync}
        />
        <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white/80" style={{ left: `${split * 100}%` }} />
        <span className="pointer-events-none absolute left-3 top-3 rounded bg-black/70 px-1.5 text-xs">{labelA}</span>
        <span className="pointer-events-none absolute right-3 top-3 rounded bg-black/70 px-1.5 text-xs">{labelB}</span>
        {!playing && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="rounded-full bg-black/55 p-3 text-white">
              <Play size={28} fill="currentColor" />
            </span>
          </span>
        )}
      </div>
      <div className="flex items-center justify-center gap-2 pb-2 text-xs text-muted">
        <IconButton label={playing ? "Пауза (Пробел)" : "Пуск (Пробел)"} onClick={togglePlay}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </IconButton>
        <span>Тяните по кадру — шторка · клик / Пробел — пуск и пауза</span>
        <Button size="sm" variant="ghost" onClick={onClose ?? (() => useUI.getState().compare(null))}>
          <X size={12} /> {closeLabel}
        </Button>
      </div>
    </div>
  );
}
