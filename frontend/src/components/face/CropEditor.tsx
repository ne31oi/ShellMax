import clsx from "clsx";
import { useRef, type ReactNode } from "react";
import type { CropBox } from "../../api/types";

type Handle = "move" | "nw" | "ne" | "sw" | "se" | "new";
const MIN = 0.04;
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

/**
 * Rectangle over an image, normalized 0..1 (what LoadImageCrop expects).
 * Drag inside to move, drag corners to resize, drag outside to draw a new one.
 */
export function CropEditor({
  src,
  value,
  onChange,
  ratio,
  mediaAspect = 1,
  media,
  heightClass = "max-h-72",
  emptySelection = false,
  minSize = MIN,
}: {
  src: string;
  value: CropBox | null;
  onChange: (c: CropBox) => void;
  ratio?: number | null; // lock the region to this width/height (in pixels)
  mediaAspect?: number; // image width/height, to convert the pixel ratio to normalized units
  media?: ReactNode; // e.g. a <video>; defaults to an <img> of src
  heightClass?: string;
  emptySelection?: boolean;
  minSize?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const crop = value ?? { x: 0, y: 0, w: 1, h: 1 };

  const start = (e: React.PointerEvent, handle: Handle) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = box.current!.getBoundingClientRect();
    const px = (ev: PointerEvent | React.PointerEvent) => ({
      x: clamp((ev.clientX - rect.left) / rect.width),
      y: clamp((ev.clientY - rect.top) / rect.height),
    });
    const origin = px(e);
    const initial = { ...crop };

    const move = (ev: PointerEvent) => {
      const p = px(ev);
      const dx = p.x - origin.x;
      const dy = p.y - origin.y;
      let next: CropBox;
      if (handle === "move") {
        next = { ...initial, x: clamp(initial.x + dx, 0, 1 - initial.w), y: clamp(initial.y + dy, 0, 1 - initial.h) };
      } else if (handle === "new") {
        next = { x: Math.min(origin.x, p.x), y: Math.min(origin.y, p.y), w: Math.abs(dx), h: Math.abs(dy) };
      } else {
        const x0 = handle.includes("w") ? clamp(initial.x + dx, 0, initial.x + initial.w - minSize) : initial.x;
        const y0 = handle.includes("n") ? clamp(initial.y + dy, 0, initial.y + initial.h - minSize) : initial.y;
        const x1 = handle.includes("e") ? clamp(initial.x + initial.w + dx, initial.x + minSize) : initial.x + initial.w;
        const y1 = handle.includes("s") ? clamp(initial.y + initial.h + dy, initial.y + minSize) : initial.y + initial.h;
        next = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      if (ratio && handle !== "move") {
        // normalized height follows width; anchor on the side opposite to the dragged one
        const k = mediaAspect / ratio;
        const bottom = next.y + next.h;
        const up = handle.includes("n") || (handle === "new" && p.y < origin.y);
        const left = handle.includes("w") || (handle === "new" && p.x < origin.x);
        const right = next.x + next.w;
        let w = next.w, h = w * k;
        const maxH = up ? bottom : 1 - next.y;
        const maxW = left ? right : 1 - next.x;
        if (h > maxH) [h, w] = [maxH, maxH / k];
        if (w > maxW) [w, h] = [maxW, maxW * k];
        next = { x: left ? right - w : next.x, y: up ? bottom - h : next.y, w, h };
      }
      if (next.w >= minSize && next.h >= minSize) onChange(round(next));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div ref={box} className={clsx("relative inline-block cursor-crosshair select-none overflow-hidden rounded-lg bg-black", heightClass)} onPointerDown={(e) => start(e, "new")}>
      {media ?? <img src={src} alt="" className={clsx("block w-auto", heightClass)} draggable={false} />}
      {(value !== null || !emptySelection) && <>
      {/* dim everything outside the crop */}
      <div
        className="pointer-events-none absolute border-2 border-accent shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
        style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }}
      />
      <div
        className="absolute cursor-move"
        style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }}
        onPointerDown={(e) => start(e, "move")}
      >
        {(["nw", "ne", "sw", "se"] as const).map((h) => (
          <span
            key={h}
            onPointerDown={(e) => start(e, h)}
            className={clsx(
              "absolute h-3 w-3 rounded-sm border-2 border-accent bg-white",
              h.includes("n") ? "-top-1.5" : "-bottom-1.5",
              h.includes("w") ? "-left-1.5" : "-right-1.5",
              h === "nw" || h === "se" ? "cursor-nwse-resize" : "cursor-nesw-resize",
            )}
          />
        ))}
      </div>
      </>}
    </div>
  );
}

const round = (c: CropBox): CropBox => ({
  x: +c.x.toFixed(4),
  y: +c.y.toFixed(4),
  w: +c.w.toFixed(4),
  h: +c.h.toFixed(4),
});
