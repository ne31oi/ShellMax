import { Copy, Frame, Play, RefreshCw, Trash2 } from "lucide-react";
import { api } from "../../api/client";
import { flushFormToPlan, planFromForm, unbindPlanForm } from "../../lib/planForm";
import { commands, planTracks, useTimeline, type Plan, type Track } from "../../store/timeline";
import { useUI } from "../../store/ui";
import { Button } from "../ui";

type Props = {
  plan: Plan;
  track: Track;
  busy: boolean;
  locked: boolean;
  onEnqueue: (mode: "draft" | "final") => void;
  onContinueFrame: () => void;
};

export function PlanInspectorActions({ plan, track, busy, locked, onEnqueue, onContinueFrame }: Props) {
  const doc = useTimeline((s) => s.doc);
  const run = useTimeline((s) => s.run);
  const otherTracks = planTracks(doc).filter((t) => t.id !== track.id);

  return (
    <div className="space-y-1.5 border-t border-line p-3">
      <div className="flex gap-1.5">
        <Button
          size="sm"
          variant="primary"
          className="flex-1"
          disabled={busy || locked}
          onClick={() => onEnqueue(plan.mode === "final" ? "final" : "draft")}
        >
          <Play size={12} /> {plan.mode === "final" ? "В очередь" : "В очередь · черновик"}
        </Button>
        <Button size="sm" disabled={busy || locked} title="Переген" onClick={() => onEnqueue(plan.mode === "final" ? "final" : "draft")}>
          <RefreshCw size={12} />
        </Button>
      </div>
      {plan.status === "draft" && (
        <Button size="sm" className="w-full" disabled={busy} onClick={() => onEnqueue("final")}>
          В очередь с выбранным качеством
        </Button>
      )}
      {(plan.status === "queued" || plan.status === "running") && plan.generationId && (
        <Button
          size="sm"
          variant="danger"
          className="w-full"
          disabled={busy}
          onClick={async () => {
            try {
              await api.cancel(plan.generationId!);
              useUI.getState().toast("План отменён", "ok");
            } catch (e) {
              useUI.getState().toast(e instanceof Error ? e.message : "Не удалось отменить", "bad");
            }
          }}
        >
          Отменить в очереди
        </Button>
      )}
      <div className="flex gap-1.5">
        <Button
          size="sm"
          className="flex-1"
          disabled={busy || locked}
          onClick={() => {
            flushFormToPlan();
            const { prompt } = planFromForm();
            void navigator.clipboard.writeText(prompt || "");
            useUI.getState().toast("Бриф скопирован", "ok");
          }}
        >
          <Copy size={12} /> Бриф
        </Button>
        <Button size="sm" className="flex-1" disabled={busy || locked} onClick={() => void onContinueFrame()}>
          <Frame size={12} /> Continue
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={locked}
          onClick={() => {
            unbindPlanForm();
            run(commands.removePlan(useTimeline.getState().doc, plan.id, track.id));
            useTimeline.getState().selectPlan(null);
            useUI.getState().setPanelOpen(false);
          }}
        >
          <Trash2 size={12} />
        </Button>
      </div>
      {otherTracks.length > 0 && (
        <div className="flex gap-1.5">
          {otherTracks.slice(0, 2).map((t) => (
            <Button
              key={t.id}
              size="sm"
              className="flex-1"
              disabled={locked}
              onClick={() => {
                flushFormToPlan();
                run(commands.duplicatePlanToTrack(useTimeline.getState().doc, plan.id, track.id, t.id));
                useUI.getState().toast(`Дубль на «${t.name}»`, "ok");
              }}
            >
              → {t.name?.replace("Планы ", "P") ?? t.id}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
