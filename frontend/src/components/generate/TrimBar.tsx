import { useRef } from "react";

const MIN_LEN = 0.5; // backend refuses shorter fragments

export function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

/**
 * Fragment picker over a waveform: drag the handles to set start/end, drag the selection to move it,
 * click outside it to seek. Reused later for clip in/out on the timeline.
 */
export function TrimBar({
  duration,
  start,
  end,
  onChange,
  peaks,
  playhead,
  onSeek,
}: {
  duration: number;
  start: number;
  end: number;
  onChange: (start: number, end: number) => void;
  peaks?: number[];
  playhead?: number | null;
  onSeek?: (t: number) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const pct = (t: number) => `${(t / duration) * 100}%`;

  const drag = (e: React.PointerEvent, which: "start" | "end" | "range" | "seek") => {
    e.preventDefault();
    e.stopPropagation();
    const rect = bar.current!.getBoundingClientRect();
    const at = (ev: PointerEvent | React.PointerEvent) =>
      Math.max(0, Math.min(duration, ((ev.clientX - rect.left) / rect.width) * duration));
    const t0 = at(e);
    const [s0, e0] = [start, end];
    if (which === "seek") {
      onSeek?.(t0);
      return;
    }
    const move = (ev: PointerEvent) => {
      const t = at(ev);
      if (which === "start") {
        const s = Math.min(t, e0 - MIN_LEN);
        onChange(Math.max(0, s), e0);
        onSeek?.(Math.max(0, s));
      } else if (which === "end") {
        const en = Math.max(t, s0 + MIN_LEN);
        onChange(s0, Math.min(duration, en));
        onSeek?.(Math.min(duration, en));
      } else {
        const len = e0 - s0;
        const s = Math.max(0, Math.min(duration - len, s0 + (t - t0)));
        onChange(s, s + len);
        onSeek?.(s);
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div>
      <div
        ref={bar}
        onPointerDown={(e) => drag(e, "seek")}
        className="relative h-16 cursor-pointer select-none overflow-hidden rounded-lg bg-raised ring-1 ring-line"
      >
        {peaks && peaks.length > 0 ? (
          <svg viewBox={`0 0 ${peaks.length} 100`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full text-audio/70">
            {peaks.map((p, i) => {
              const h = Math.max(1.5, p * 96);
              return <rect key={i} x={i} y={50 - h / 2} width={0.8} height={h} fill="currentColor" />;
            })}
          </svg>
        ) : (
          <div className="absolute inset-x-0 top-1/2 h-px bg-line-strong" />
        )}
        {/* dim what is cut away */}
        <div className="pointer-events-none absolute inset-y-0 left-0 bg-black/60" style={{ width: pct(start) }} />
        <div className="pointer-events-none absolute inset-y-0 right-0 bg-black/60" style={{ left: pct(end) }} />
        <div
          onPointerDown={(e) => drag(e, "range")}
          className="absolute inset-y-0 cursor-grab border-y-2 border-accent active:cursor-grabbing"
          style={{ left: pct(start), width: `calc(${pct(end)} - ${pct(start)})` }}
        />
        {(["start", "end"] as const).map((h) => (
          <div
            key={h}
            onPointerDown={(e) => drag(e, h)}
            className="absolute inset-y-0 flex w-3 -translate-x-1/2 cursor-ew-resize items-center justify-center"
            style={{ left: pct(h === "start" ? start : end) }}
          >
            <span className="h-full w-1.5 rounded-sm bg-accent" />
          </div>
        ))}
        {playhead != null && (
          <div className="pointer-events-none absolute inset-y-0 w-px bg-white" style={{ left: pct(playhead) }} />
        )}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] tabular-nums text-muted">
        <span>{fmtTime(start)}</span>
        <span className="text-fg">фрагмент {fmtTime(end - start)}</span>
        <span>{fmtTime(end)}</span>
      </div>
    </div>
  );
}
