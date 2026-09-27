import clsx from "clsx";
import { useEffect, useMemo, useState } from "react";
import { downsamplePeaks, getCachedAssetPeaks, loadAssetPeaks, slicePeaks } from "../../lib/assetPeaks";

/** Mirrored waveform bars for an A-track clip (in/out window of the source). */
export function AudioClipWave({
  assetId,
  fileDuration,
  inn,
  out,
  widthPx,
  className,
}: {
  assetId: number;
  fileDuration: number | null | undefined;
  inn: number;
  out: number;
  widthPx: number;
  className?: string;
}) {
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
    const maxBars = Math.max(8, Math.floor(Math.max(16, widthPx) / 2));
    return downsamplePeaks(sliced, maxBars);
  }, [peaks, dur, inn, out, widthPx]);

  if (!bars.length) {
    return <div className={clsx("absolute inset-x-1 top-1/2 h-px bg-audio/40", className)} />;
  }

  return (
    <svg
      viewBox={`0 0 ${bars.length} 100`}
      preserveAspectRatio="none"
      className={clsx("pointer-events-none absolute inset-0 h-full w-full text-audio/80", className)}
      aria-hidden
    >
      {bars.map((p, i) => {
        const h = Math.max(2, p * 88);
        return <rect key={i} x={i} y={50 - h / 2} width={0.85} height={h} fill="currentColor" />;
      })}
    </svg>
  );
}
