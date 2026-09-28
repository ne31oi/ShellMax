import { nearestH3Duration, snapToFrame } from "../../lib/planH3";
import {
  clampPlanResize,
  commands,
  emptyPlan,
  openPlanInSidebar,
  planTracks,
  resolvePlanPlacement,
  snapEnabled,
  snapTime,
  useTimeline,
} from "../../store/timeline";
import { useUI } from "../../store/ui";
import { PlanBlock } from "./PlanBlock";
import { TrackRow } from "./TrackRow";
import type { PlanDragState } from "./timelineDrag";

type Props = {
  contentW: number;
  scale: number;
  planDrag: PlanDragState | null;
  setPlanDrag: (d: PlanDragState | null) => void;
  playhead: number;
  selectedPlanId: string | null;
  selectedPlanIds: string[];
};

export function TimelinePlanLanes({
  contentW,
  scale,
  planDrag,
  setPlanDrag,
  playhead,
  selectedPlanId,
  selectedPlanIds,
}: Props) {
  const doc = useTimeline((s) => s.doc);
  const run = useTimeline((s) => s.run);
  const pTracks = planTracks(doc);

  return (
    <>
      {pTracks.map((pt, idx) => (
        <TrackRow
          key={pt.id}
          label={`P${idx + 1}`}
          name={pt.name || `Планы ${idx + 1}`}
          muted={pt.muted}
          over={planDrag?.toTrackId === pt.id}
          onAddPlan={() => {
            const start = snapToFrame(snapTime(doc, playhead, { force: true }));
            const duration = nearestH3Duration(2);
            const placed = resolvePlanPlacement(pt.plans, start, duration);
            if (placed == null) {
              useUI.getState().toast("На дорожке нет места без перекрытия", "info");
              return;
            }
            const plan = emptyPlan({ start: placed, duration });
            run(commands.addPlan(plan, pt.id));
            openPlanInSidebar(plan.id);
          }}
          onMute={() => run(commands.setTrackMuted(useTimeline.getState().doc, pt.id, !pt.muted))}
          onRemove={
            pTracks.length > 1
              ? () => {
                  const cmd = commands.removeTrack(useTimeline.getState().doc, pt.id);
                  if (!cmd) {
                    useUI.getState().toast("Нужна хотя бы одна дорожка планов", "info");
                    return;
                  }
                  run(cmd);
                  useTimeline.getState().selectPlan(null);
                }
              : undefined
          }
        >
          <div
            className="relative h-full"
            style={{ width: contentW }}
            data-rail="1"
            data-plan-track={pt.id}
          >
            {pt.plans.map((p) => {
              const dragging = planDrag?.planId === p.id;
              const onThisTrack = !dragging || planDrag.toTrackId === pt.id;
              if (dragging && planDrag.fromTrackId === pt.id && planDrag.toTrackId !== pt.id) {
                return null; // shown as ghost / on destination
              }
              if (!onThisTrack) return null;
              const start = dragging ? planDrag.start : p.start;
              const duration = dragging ? planDrag.duration : p.duration;
              return (
                <PlanBlock
                  key={p.id}
                  plan={p}
                  displayStart={start}
                  displayDuration={duration}
                  scale={scale}
                  selected={selectedPlanId === p.id}
                  checked={selectedPlanIds.includes(p.id)}
                  dragging={!!dragging}
                  trackId={pt.id}
                  onSelect={(mods) => {
                    if (mods.toggle) {
                      useTimeline.getState().togglePlanSelected(p.id);
                      return;
                    }
                    if (mods.range) {
                      const ordered = planTracks(useTimeline.getState().doc).flatMap((t) =>
                        t.plans.map((x) => x.id),
                      );
                      const anchor = selectedPlanIds[0] ?? selectedPlanId ?? p.id;
                      const a = ordered.indexOf(anchor);
                      const b = ordered.indexOf(p.id);
                      if (a >= 0 && b >= 0) {
                        const lo = Math.min(a, b);
                        const hi = Math.max(a, b);
                        useTimeline.getState().selectPlans(ordered.slice(lo, hi + 1));
                        return;
                      }
                    }
                    openPlanInSidebar(p.id);
                  }}
                  onPreview={(preview) => setPlanDrag(preview)}
                  onCommit={(final) => {
                    setPlanDrag(null);
                    if (!final) return;
                    const cmd = commands.relocatePlan(
                      useTimeline.getState().doc,
                      final.planId,
                      final.fromTrackId,
                      final.toTrackId,
                      final.start,
                      final.duration,
                    );
                    if (!cmd) {
                      useUI.getState().toast("Нельзя: перекрытие с другим планом на дорожке", "info");
                      return;
                    }
                    run(cmd);
                  }}
                  snapBeats={snapEnabled(doc)}
                  resolvePreview={(toTrackId, start, duration, mode) => {
                    const dest = useTimeline.getState().doc.tracks.find((t) => t.id === toTrackId);
                    const peers = dest?.plans ?? [];
                    if (mode === "move") {
                      const placed = resolvePlanPlacement(peers, start, duration, p.id);
                      return placed == null
                        ? { start, duration, blocked: true }
                        : { start: placed, duration, blocked: false };
                    }
                    const clamped = clampPlanResize(peers, p.id, start, duration, mode);
                    return clamped
                      ? { start: clamped.start, duration: clamped.duration, blocked: false }
                      : { start, duration, blocked: true };
                  }}
                />
              );
            })}
            {planDrag && planDrag.toTrackId === pt.id && planDrag.fromTrackId !== pt.id && (
              <div
                className="pointer-events-none absolute top-1 bottom-1 rounded-md bg-accent/25 ring-2 ring-accent"
                style={{
                  left: planDrag.start * scale,
                  width: Math.max(28, planDrag.duration * scale),
                }}
              />
            )}
          </div>
        </TrackRow>
      ))}
    </>
  );
}
