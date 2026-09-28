import clsx from "clsx";
import { fmtDuration, fmtTimecode } from "../../lib/format";
import { H3_FPS, snapToFrame } from "../../lib/planH3";
import { snapTime, timelineBeats, useTimeline, type Plan } from "../../store/timeline";
import { MIN_PLAN } from "./timelineConstants";
import type { PlanDragState } from "./timelineDrag";

export function PlanBlock({
  plan,
  displayStart,
  displayDuration,
  scale,
  selected,
  checked,
  dragging,
  trackId,
  snapBeats,
  onSelect,
  onPreview,
  onCommit,
  resolvePreview,
}: {
  plan: Plan;
  displayStart: number;
  displayDuration: number;
  scale: number;
  selected: boolean;
  checked: boolean;
  dragging: boolean;
  trackId: string;
  snapBeats: boolean;
  onSelect: (mods: { toggle?: boolean; range?: boolean }) => void;
  onPreview: (d: PlanDragState | null) => void;
  onCommit: (d: PlanDragState | null) => void;
  resolvePreview: (
    toTrackId: string,
    start: number,
    duration: number,
    mode: "move" | "in" | "out",
  ) => { start: number; duration: number; blocked: boolean };
}) {
  const statusColor =
    plan.status === "done"
      ? "bg-ok/25 ring-ok/50"
      : plan.status === "draft"
        ? "bg-accent/20 ring-accent/50"
        : plan.status === "error"
          ? "bg-bad/20 ring-bad/50"
          : plan.status === "running" || plan.status === "queued"
            ? "bg-warn/20 ring-warn/50"
            : "bg-raised ring-line";

  const drag = (e: React.PointerEvent, mode: "move" | "in" | "out") => {
    e.preventDefault();
    e.stopPropagation();
    const originX = e.clientX;
    const s0 = plan.start;
    const d0 = plan.duration;
    let last: PlanDragState = {
      planId: plan.id,
      fromTrackId: trackId,
      toTrackId: trackId,
      start: s0,
      duration: d0,
      mode,
    };
    onPreview(last);
    // Focus for inspector only — do not toggle batch checkboxes.

    const move = (ev: PointerEvent) => {
      let toTrackId = trackId;
      if (mode === "move") {
        const trackEls = document.querySelectorAll<HTMLElement>("[data-plan-track]");
        for (const el of trackEls) {
          const r = el.getBoundingClientRect();
          if (ev.clientY >= r.top && ev.clientY <= r.bottom) {
            toTrackId = el.dataset.planTrack || trackId;
            break;
          }
        }
      }
      const dx = (ev.clientX - originX) / scale;
      let nextStart = s0;
      let nextDur = d0;
      const docNow = useTimeline.getState().doc;
      const canSnap = snapBeats && timelineBeats(docNow).beats.length > 0;
      if (mode === "move") {
        nextStart = Math.max(0, s0 + dx);
        nextDur = d0;
        if (canSnap) nextStart = snapTime(docNow, nextStart, { force: true });
      } else if (mode === "in") {
        const end = s0 + d0;
        nextStart = Math.max(0, Math.min(end - MIN_PLAN, s0 + dx));
        if (canSnap) nextStart = snapTime(docNow, nextStart, { force: true });
        nextDur = end - nextStart;
      } else {
        nextStart = s0;
        const end = Math.max(s0 + MIN_PLAN, s0 + d0 + dx);
        const snappedEnd = canSnap ? snapTime(docNow, end, { force: true }) : end;
        nextDur = Math.max(MIN_PLAN, snappedEnd - s0);
      }
      nextStart = snapToFrame(nextStart);
      nextDur = Math.max(MIN_PLAN, snapToFrame(nextDur));
      const resolved = resolvePreview(toTrackId, nextStart, nextDur, mode);
      last = {
        planId: plan.id,
        fromTrackId: trackId,
        toTrackId,
        start: resolved.start,
        duration: resolved.duration,
        mode,
      };
      onPreview(last);
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const changed =
        last.start !== s0 || last.duration !== d0 || last.toTrackId !== trackId;
      onCommit(changed ? last : null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        if (e.shiftKey) {
          onSelect({ range: true });
          return;
        }
        onSelect({});
      }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).dataset.edge) return;
        if ((e.target as HTMLElement).closest("[data-plan-check]")) return;
        if (e.button !== 0) return;
        if (e.shiftKey) return;
        drag(e, "move");
      }}
      style={{ left: displayStart * scale, width: Math.max(36, displayDuration * scale) }}
      className={clsx(
        "absolute top-1 bottom-1 cursor-grab overflow-hidden rounded-md pl-5 pr-1 ring-1 active:cursor-grabbing",
        statusColor,
        !!plan.reviewNotes?.length && "ring-warn/70",
        selected && "ring-2 ring-accent",
        checked && "ring-2 ring-accent bg-accent/30",
        dragging && "z-30 opacity-90 shadow-lg",
      )}
      title={`${fmtTimecode(displayStart)} · ${Math.round(displayDuration * H3_FPS)} кадр. · Shift — диапазон${plan.reviewNotes?.length ? " · Замечания редактора" : ""}`}
    >
      <label
        data-plan-check="1"
        className="absolute left-0.5 top-0.5 z-20 flex h-4 w-4 cursor-pointer items-center justify-center"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        title="Выбрать для очереди"
      >
        <input
          type="checkbox"
          className="h-3.5 w-3.5 accent-[var(--color-accent,#7dd3fc)]"
          checked={checked}
          onChange={(e) => {
            if ((e.nativeEvent as MouseEvent).shiftKey) onSelect({ range: true });
            else onSelect({ toggle: true });
          }}
          onClick={(e) => {
            if (e.shiftKey) {
              e.preventDefault();
              onSelect({ range: true });
            }
          }}
        />
      </label>
      <span className="pointer-events-none block truncate text-[10px] text-fg">
        {plan.reviewNotes?.length ? "⚠ " : ""}{plan.name || plan.prompt.slice(0, 24) || "план"}
      </span>
      <span className="pointer-events-none text-[9px] text-faint">
        {fmtDuration(displayDuration)} · {Math.round(displayDuration * H3_FPS)}f
      </span>
      <div
        data-edge="1"
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-ew-resize hover:bg-accent/60"
        onPointerDown={(e) => {
          e.stopPropagation();
          drag(e, "in");
        }}
      />
      <div
        data-edge="1"
        className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-ew-resize hover:bg-accent/60"
        onPointerDown={(e) => {
          e.stopPropagation();
          drag(e, "out");
        }}
      />
    </div>
  );
}

