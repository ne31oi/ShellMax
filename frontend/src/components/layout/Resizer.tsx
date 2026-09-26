import clsx from "clsx";
import { useCallback, useState } from "react";

/** Panel size persisted per key; returns [size, dragHandle]. */
export function usePanelSize(key: string, initial: number, min: number, max: number) {
  const [size, setSize] = useState(() => {
    const saved = Number(localStorage.getItem(`sm.panel.${key}`));
    return saved >= min && saved <= max ? saved : initial;
  });
  const commit = useCallback(
    (v: number) => {
      const c = Math.max(min, Math.min(max, v));
      setSize(c);
      localStorage.setItem(`sm.panel.${key}`, String(c));
    },
    [key, min, max],
  );
  return [size, commit] as const;
}

export function Resizer({
  axis,
  onDrag,
  invert,
}: {
  axis: "x" | "y";
  onDrag: (delta: number) => void;
  invert?: boolean;
}) {
  const [active, setActive] = useState(false);
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    setActive(true);
    let last = axis === "x" ? e.clientX : e.clientY;
    const move = (ev: PointerEvent) => {
      const pos = axis === "x" ? ev.clientX : ev.clientY;
      onDrag((invert ? -1 : 1) * (pos - last));
      last = pos;
    };
    const up = () => {
      setActive(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      onPointerDown={start}
      className={clsx(
        "group relative z-10 shrink-0",
        axis === "x" ? "w-px cursor-col-resize bg-line" : "h-px cursor-row-resize bg-line",
      )}
    >
      <div
        className={clsx(
          "absolute transition-colors",
          axis === "x" ? "-left-1 -right-1 inset-y-0" : "-top-1 -bottom-1 inset-x-0",
          active ? "bg-accent/60" : "group-hover:bg-accent/40",
        )}
      />
    </div>
  );
}
