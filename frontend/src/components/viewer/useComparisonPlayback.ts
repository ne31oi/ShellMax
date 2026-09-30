import { useEffect, useRef, useState } from "react";
import { on } from "../../lib/bus";
import { comparisonTimes, comparisonWindow } from "./comparison-window";

/** One playing source clock drives the paused result, including trimmed source offsets. */
export function useComparisonPlayback(aId: number, bId: number, aStart: number, bStart: number, limit?: number) {
  const va = useRef<HTMLVideoElement>(null);
  const vb = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const synced = useRef(false);
  const lastMirror = useRef(-1);
  const shouldPlay = useRef(true);

  const window = () => comparisonWindow(va.current?.duration ?? 0, vb.current?.duration ?? 0, aStart, bStart, limit);
  const mirror = (force = false) => {
    const master = va.current, slave = vb.current;
    if (!master || !slave || slave.seeking || !synced.current) return;
    if (!slave.paused) slave.pause();
    const target = comparisonTimes(master.currentTime - aStart, window()).b;
    if (!force && Math.abs(target - lastMirror.current) < 0.0005) return;
    if (Math.abs(target - slave.currentTime) >= 0.001) slave.currentTime = target;
    lastMirror.current = target;
  };
  const trySync = () => {
    const master = va.current, slave = vb.current;
    if (!master || !slave) return;
    const range = window();
    setDuration(range.duration);
    if (synced.current || master.readyState < 2 || slave.readyState < 2 || !range.duration) return;
    master.pause(); slave.pause();
    master.currentTime = range.startA;
    slave.currentTime = range.startB;
    synced.current = true;
    setTime(0);
    if (shouldPlay.current) void master.play().catch(() => setPlaying(false));
  };
  const seek = (relative: number) => {
    const master = va.current;
    if (!master) return;
    const times = comparisonTimes(relative, window());
    master.currentTime = times.a;
    setTime(times.relative);
    mirror(true);
  };
  const togglePlay = () => {
    const master = va.current;
    if (!master) return;
    shouldPlay.current = master.paused;
    if (master.paused) void master.play().catch(() => setPlaying(false));
    else { master.pause(); mirror(true); }
  };
  const restart = () => {
    seek(0);
    if (shouldPlay.current) void va.current?.play().catch(() => setPlaying(false));
  };

  useEffect(() => {
    synced.current = false;
    lastMirror.current = -1;
    shouldPlay.current = true;
    setPlaying(true); setTime(0); setDuration(0);
    let raf = 0;
    const tick = () => {
      const master = va.current;
      if (synced.current && master) {
        const range = window();
        if (!master.seeking && range.duration && (master.currentTime < range.startA - 0.001 || master.currentTime >= range.startA + range.duration)) restart();
        mirror();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    trySync();
    const stopToggle = on("viewerToggle", togglePlay);
    const stopStep = on("viewerStep", (frames) => {
      shouldPlay.current = false;
      va.current?.pause();
      seek((va.current?.currentTime ?? aStart) - aStart + frames / 24);
    });
    return () => {
      cancelAnimationFrame(raf); stopToggle(); stopStep();
      va.current?.pause(); vb.current?.pause();
    };
    // Media callbacks and the frame loop share the same comparison window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aId, bId, aStart, bStart, limit]);

  return { va, vb, time, duration, playing, togglePlay, seek, trySync, restart,
    onTimeUpdate: () => { setTime(Math.max(0, (va.current?.currentTime ?? aStart) - aStart)); },
    onPlay: () => setPlaying(true), onPause: () => { setPlaying(false); mirror(true); },
    onSeeked: () => mirror(true) };
}
