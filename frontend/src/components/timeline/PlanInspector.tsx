import clsx from "clsx";
import { Magnet, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { isH3Aligned, nearestH3Duration, snapToFrame } from "../../lib/planH3";
import {
  bindPlanToForm,
  flushFormToPlan,
  setFormFieldFromPlan,
  unbindPlanForm,
} from "../../lib/planForm";
import { useForm } from "../../store/form";
import { ErrorMessage } from "../ui";
import { useLibrary } from "../../store/library";
import {
  audioTracks,
  commands,
  findPlan,
  flushTimelinePersist,
  openPlanInSidebar,
  timelineBeats,
  useTimeline,
  type Plan,
} from "../../store/timeline";
import { useUI } from "../../store/ui";
import { DurationChip, FormatChip, LookChip, QualityChip, StyleChip, useEstimates } from "../generate/Chips";
import { PromptEditor } from "../generate/PromptEditor";
import { RefsZone } from "../generate/RefsZone";
import { Button, SectionTitle } from "../ui";
import { PlanInspectorActions } from "./PlanInspectorActions";
import { buildChecklist, previousPlanByTime } from "./planChecklist";

const STATUS_LABEL: Record<Plan["status"], string> = {
  empty: "Пусто",
  queued: "В очереди",
  running: "Идёт",
  draft: "Черновик",
  done: "Готово",
  error: "Ошибка",
};

export function PlanInspector() {
  const doc = useTimeline((s) => s.doc);
  const selectedPlanId = useTimeline((s) => s.selectedPlanId);
  const run = useTimeline((s) => s.run);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  const hit = selectedPlanId ? findPlan(doc, selectedPlanId) : null;
  const plan = hit?.plan ?? null;
  const track = hit?.track ?? null;

  const checklist = useMemo(() => (plan ? buildChecklist(doc, plan) : []), [doc, plan]);
  const estimates = useEstimates();
  const h3Near = plan ? nearestH3Duration(plan.duration) : 2;

  // Bind / unbind generation form to the selected plan
  useEffect(() => {
    if (!selectedPlanId) {
      unbindPlanForm();
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void bindPlanToForm(selectedPlanId).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedPlanId]);

  // Keep DurationChip in sync when plan is resized on the timeline
  useEffect(() => {
    if (!plan || loading) return;
    const formDur = useForm.getState().duration;
    if (Math.abs(formDur - plan.duration) > 1e-3) {
      setFormFieldFromPlan({ duration: plan.duration });
    }
  }, [plan?.duration, plan?.id, loading]);

  useEffect(() => {
    return () => unbindPlanForm();
  }, []);

  if (!hit || !plan || !track) {
    return (
      <div className="flex h-full flex-col px-4 py-4 text-xs text-faint">
        Выберите план на дорожке P или создайте новый.
      </div>
    );
  }

  const locked = plan.status === "queued" || plan.status === "running";
  const aTracks = audioTracks(doc);

  const patch = (p: Partial<Plan>) => {
    run(commands.updatePlan(useTimeline.getState().doc, plan.id, track.id, p));
  };

  const enqueue = async (mode: "draft" | "final", ids?: string[]) => {
    flushFormToPlan();
    setBusy(true);
    try {
      const projectId = useUI.getState().projectId;
      const planIds = ids ?? [plan.id];
      // Черновик-кнопка форсит пресет draft; иначе — то, что выбрано чипом «Качество».
      const quality = mode === "draft" ? "draft" : useForm.getState().quality;
      const qLabel =
        useLibrary.getState().meta?.quality?.find((p) => p.id === quality)?.label ?? quality;
      for (const id of planIds) {
        const hit = findPlan(useTimeline.getState().doc, id);
        if (!hit) continue;
        useTimeline.getState().run(commands.updatePlan(useTimeline.getState().doc, id, hit.track.id, { quality, mode }));
      }
      await flushTimelinePersist();
      const res = await api.enqueuePlans(projectId, planIds, mode);
      res.generations.forEach((g) => useLibrary.getState().upsertGeneration(g));
      useTimeline.getState().load(res.timeline as never);
      openPlanInSidebar(plan.id);
      useUI.getState().toast(`В очередь: ${planIds.length} · ${qLabel}`, "ok");
    } catch (e) {
      useUI.getState().toast(e instanceof Error ? e.message : "Не удалось поставить в очередь", "bad");
    } finally {
      setBusy(false);
    }
  };

  const continueFrame = async () => {
    setBusy(true);
    try {
      const prev = previousPlanByTime(doc, plan);
      if (!prev) {
        useUI.getState().toast("Нет предыдущего плана с результатом", "info");
        return;
      }
      const assetId = prev.outputAssetId ?? prev.draftAssetId;
      if (!assetId) {
        useUI.getState().toast("У предыдущего плана ещё нет кадра", "info");
        return;
      }
      const at = Math.max(0, (prev.duration || 2) - 0.05);
      const up = await api.frameToRef(assetId, at);
      useForm.getState().addRefs([up]);
      flushFormToPlan();
      useUI.getState().toast("Кадр предыдущего плана добавлен в рефы", "ok");
    } catch (e) {
      useUI.getState().toast(e instanceof Error ? e.message : "Не удалось взять кадр", "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 pr-10">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-faint">План</h3>
        <span
          className={clsx(
            "rounded px-1.5 py-0.5 text-[10px]",
            plan.status === "done" && "bg-ok/15 text-ok",
            plan.status === "draft" && "bg-accent/15 text-accent",
            plan.status === "error" && "bg-bad/15 text-bad",
            (plan.status === "queued" || plan.status === "running") && "bg-warn/15 text-warn",
            plan.status === "empty" && "bg-raised text-faint",
          )}
        >
          {STATUS_LABEL[plan.status]}
        </span>
        <input
          className="ml-1 h-6 min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 text-[12px] outline-none hover:border-line focus:border-accent/50"
          value={plan.name ?? ""}
          disabled={locked}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder={track.name || "Без названия"}
        />
      </div>

      <div className={clsx("min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-4 pt-4", locked && "pointer-events-none opacity-60")}>
        {loading ? (
          <p className="text-xs text-faint">Загрузка плана…</p>
        ) : (
          <>
            <section>
              <SectionTitle>Референсы</SectionTitle>
              <RefsZone />
            </section>
            <section>
              <SectionTitle>Что происходит в видео</SectionTitle>
              <PromptEditor />
            </section>
            <section className="flex flex-wrap gap-1.5">
              <FormatChip />
              <DurationChip />
              <QualityChip estimates={estimates} />
              <LookChip />
              <StyleChip />
            </section>

            <section className="space-y-2 border-t border-line pt-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">Таймлайн и звук</p>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="mb-1 block text-xs text-muted">Старт, с</span>
                  <input
                    type="number"
                    step={1 / 24}
                    min={0}
                    className="h-8 w-full rounded-lg border border-line bg-raised px-2 text-[13px]"
                    value={Number(plan.start.toFixed(4))}
                    disabled={locked}
                    onChange={(e) => {
                      const start = snapToFrame(Math.max(0, Number(e.target.value) || 0));
                      const cmd = commands.relocatePlan(
                        useTimeline.getState().doc,
                        plan.id,
                        track.id,
                        track.id,
                        start,
                        plan.duration,
                      );
                      if (!cmd) useUI.getState().toast("Нельзя: перекрытие", "info");
                      else run(cmd);
                    }}
                  />
                </label>
                <div className="flex flex-col justify-end gap-1">
                  <Button
                    size="sm"
                    disabled={locked || !timelineBeats(doc).beats.length}
                    onClick={() => {
                      const { beats } = timelineBeats(useTimeline.getState().doc);
                      const endBeat = beats.find((b) => b > plan.start + 0.05) ?? plan.start + plan.duration;
                      const cmd = commands.relocatePlan(
                        useTimeline.getState().doc,
                        plan.id,
                        track.id,
                        track.id,
                        plan.start,
                        Math.max(0.2, endBeat - plan.start),
                      );
                      if (cmd) {
                        run(cmd);
                        setFormFieldFromPlan({ duration: Math.max(0.2, endBeat - plan.start) });
                      }
                    }}
                  >
                    <Magnet size={12} /> К биту
                  </Button>
                  <Button
                    size="sm"
                    disabled={locked || isH3Aligned(plan.duration)}
                    onClick={() => {
                      const cmd = commands.relocatePlan(
                        useTimeline.getState().doc,
                        plan.id,
                        track.id,
                        track.id,
                        plan.start,
                        h3Near,
                      );
                      if (cmd) {
                        run(cmd);
                        setFormFieldFromPlan({ duration: h3Near });
                      }
                    }}
                  >
                    <Sparkles size={12} /> Под H3
                  </Button>
                </div>
              </div>

              <div>
                <p className="mb-1 text-xs text-muted">Аудиодорожки в этот план</p>
                <div className="space-y-1">
                  {aTracks.length === 0 && <p className="text-[11px] text-faint">Нет A-треков</p>}
                  {aTracks.map((t) => {
                    const on = plan.audio[t.id] !== false;
                    return (
                      <label key={t.id} className="flex items-center gap-2 text-[13px]">
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={locked}
                          onChange={(e) => patch({ audio: { ...plan.audio, [t.id]: e.target.checked } })}
                        />
                        <span className="truncate">{t.name || t.id}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <label className="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={plan.lipsync}
                  disabled={locked}
                  onChange={(e) => patch({ lipsync: e.target.checked })}
                />
                Липсинг
              </label>
              <label className="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={plan.mode === "draft"}
                  disabled={locked}
                  onChange={(e) => patch({ mode: e.target.checked ? "draft" : "final" })}
                />
                Кнопка по умолчанию — черновик
              </label>
              <p className="text-[11px] text-faint">
                Качество выбирайте чипом выше (пресеты из Настройки → Качество).
              </p>
            </section>

            {plan.error && <ErrorMessage text={plan.error} />}
            {!!plan.reviewNotes?.length && <ErrorMessage tone="warn" text={plan.reviewNotes.join("\n\n")} />}
            {checklist.length > 0 && (
              <div className="rounded-lg border border-warn/30 bg-warn/5 px-2 py-1.5">
                <p className="mb-1 text-[11px] font-medium text-warn">Перед стартом</p>
                <ul className="list-inside list-disc space-y-0.5 text-[11px] text-muted">
                  {checklist.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      <PlanInspectorActions
        plan={plan}
        track={track}
        busy={busy}
        locked={locked}
        onEnqueue={(mode) => void enqueue(mode)}
        onContinueFrame={() => void continueFrame()}
      />
    </div>
  );
}
