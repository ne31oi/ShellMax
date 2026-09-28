import clsx from "clsx";
import { useEffect, useId, useMemo, useState } from "react";
import { downsamplePeaks, getCachedAssetPeaks, loadAssetPeaks, slicePeaks } from "../../lib/assetPeaks";

const BAR_PX = 2;
const GAP_PX = 1;
const SLOT_PX = BAR_PX + GAP_PX; // 3

/** Mirrored waveform for an A-track clip (in/out window), with playhead progress. */
export function AudioClipWave({
  assetId,
  fileDuration,
  inn,
  out,
  widthPx,
  muted = false,
  /** 0…1 portion of the clip to the left of the playhead. */
  progress = 0,
  className,
}: {
  assetId: number;
  fileDuration: number | null | undefined;
  inn: number;
  out: number;
  widthPx: number;
  /** Kept for call-site compat; height always shows true amplitude. */
  gain?: number;
  muted?: boolean;
  progress?: number;
  className?: string;
}) {
  const gid = useId().replace(/:/g, "");
  const cached = getCachedAssetPeaks(assetId);
  const [peaks, setPeaks] = useState<number[] | undefined>(cached?.peaks);
  const [dur, setDur] = useState<number | null>(cached?.duration ?? fileDuration ?? null);

  useEffect(() => {
    let cancelled = false;
    const hit = getCachedAssetPeaks(assetId);
    if (hit) {
      setPeaks(hit.peaks);
      setDur(hit.duration);
      return;
    }
    void loadAssetPeaks(assetId)
      .then((r) => {
        if (cancelled) return;
        setPeaks(r.peaks);
        setDur(r.duration);
      })
      .catch(() => {
        if (!cancelled) setPeaks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  const bars = useMemo(() => {
    if (!peaks?.length) return [];
    const srcDur = dur && dur > 0 ? dur : Math.max(out, inn + 0.01);
    const sliced = slicePeaks(peaks, srcDur, inn, out);
    const count = Math.max(1, Math.floor(Math.max(SLOT_PX, widthPx) / SLOT_PX));
    const raw = downsamplePeaks(sliced, count);
    let peak = 0;
    for (const p of raw) if (p > peak) peak = p;
    if (peak < 1e-6) return raw.map(() => 0);
    return raw.map((p) => p / peak);
  }, [peaks, dur, inn, out, widthPx]);

  const prog = Math.max(0, Math.min(1, progress));
  const split = Math.round(prog * bars.length);
  const vbW = Math.max(SLOT_PX, bars.length * SLOT_PX);

  if (!bars.length) {
    return (
      <div className={clsx("absolute inset-0", className)} aria-hidden>
        <div className="absolute inset-y-0 left-0 bg-audio/20" style={{ width: `${prog * 100}%` }} />
        <div className="absolute inset-x-1 top-1/2 h-px bg-audio/40" />
      </div>
    );
  }

  return (
    <div className={clsx("pointer-events-none absolute inset-0", className)} aria-hidden>
      <div className="absolute inset-y-0 left-0 bg-audio/15" style={{ width: `${prog * 100}%` }} />
      {muted && (
        <svg className="absolute inset-0 h-full w-full text-audio/25" aria-hidden>
          <defs>
            <pattern
              id={`${gid}-hatch`}
              width="5"
              height="5"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(35)"
            >
              <line x1="0" y1="0" x2="0" y2="5" stroke="currentColor" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill={`url(#${gid}-hatch)`} />
        </svg>
      )}
      <svg
        viewBox={`0 0 ${vbW} 100`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full text-audio"
      >
        {bars.map((p, i) => {
          const h = Math.max(1.5, p * 92);
          const played = i < split;
          const opacity = muted ? 0.28 : played ? 0.95 : 0.42;
          return (
            <rect
              key={i}
              x={i * SLOT_PX}
              y={50 - h / 2}
              width={BAR_PX}
              height={h}
              fill="currentColor"
              opacity={opacity}
            />
          );
        })}
      </svg>
    </div>
  );
}
