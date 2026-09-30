import { Pause, Play, X } from "lucide-react";
import { useRef, useState } from "react";
import { urls } from "../../api/client";
import { useUI } from "../../store/ui";
import { Button, IconButton } from "../ui";
import { useComparisonPlayback } from "./useComparisonPlayback";

export function CompareView({ a, b, labelA, labelB, aStart = 0, bStart = 0, durationLimit, onClose, closeLabel = "Закрыть сравнение" }: {
  a: { id: number }; b: { id: number }; labelA: string; labelB: string; onClose?: () => void; closeLabel?: string;
  aStart?: number; bStart?: number; durationLimit?: number;
}) {
  const { va, vb, time, duration, playing, togglePlay, seek, trySync, restart, onTimeUpdate, onPlay, onPause, onSeeked } =
    useComparisonPlayback(a.id, b.id, aStart, bStart, durationLimit);
  const [split, setSplit] = useState(0.5);
  const [layout, setLayout] = useState<"wipe" | "side">("wipe");
  const box = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);

  return (
    <div className="flex h-full flex-col">
      <div
        ref={box}
        className={`relative m-3 flex-1 overflow-hidden rounded-md bg-black ${layout === "wipe" ? "cursor-ew-resize" : "cursor-pointer"}`}
        onMouseMove={(e) => {
          if (layout !== "wipe") return;
          if (e.buttons !== 1) return;
          scrubbing.current = true;
          const r = box.current!.getBoundingClientRect();
          setSplit(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
        }}
        onMouseDown={(e) => {
          if (layout !== "wipe") return;
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
          playsInline
          preload="auto"
          className={layout === "wipe" ? "absolute inset-0 h-full w-full object-contain" : "absolute inset-y-0 left-0 h-full w-1/2 object-contain"}
          onLoadedData={trySync}
          onLoadedMetadata={trySync}
          onTimeUpdate={onTimeUpdate}
          onPlay={onPlay}
          onPause={onPause}
          onSeeked={onSeeked}
          onEnded={restart}
        />
        <video
          key={`cmp-b-${b.id}`}
          ref={vb}
          src={urls.assetFile(b.id)}
          muted
          playsInline
          preload="auto"
          className={layout === "wipe" ? "pointer-events-none absolute inset-0 h-full w-full object-contain" : "pointer-events-none absolute inset-y-0 right-0 h-full w-1/2 object-contain"}
          style={layout === "wipe" ? { clipPath: `inset(0 0 0 ${split * 100}%)` } : undefined}
          onLoadedData={trySync}
          onLoadedMetadata={trySync}
        />
        {layout === "wipe" && <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white/80" style={{ left: `${split * 100}%` }} />}
        {layout === "side" && <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-white/40" />}
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
      <div className="flex flex-wrap items-center justify-center gap-2 px-3 pb-2 text-xs text-muted">
        <IconButton label={playing ? "Пауза (Пробел)" : "Пуск (Пробел)"} onClick={togglePlay}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </IconButton>
        <Button size="sm" variant={layout === "wipe" ? "primary" : "ghost"} onClick={() => setLayout("wipe")}>Шторка</Button>
        <Button size="sm" variant={layout === "side" ? "primary" : "ghost"} onClick={() => setLayout("side")}>Рядом</Button>
        <input type="range" aria-label="Позиция сравнения" className="min-w-24 flex-1" min={0} max={duration || 1} step={1 / 24} value={Math.min(time, duration || 1)} onChange={(e) => seek(Number(e.target.value))} />
        <span className="tabular-nums">{time.toFixed(1)} / {duration.toFixed(1)} с</span>
        <Button size="sm" variant="ghost" onClick={onClose ?? (() => useUI.getState().compare(null))}>
          <X size={12} /> {closeLabel}
        </Button>
      </div>
    </div>
  );
}
