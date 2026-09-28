import clsx from "clsx";
import { Copy, Frame, Magnet, Play, RefreshCw, Sparkles, Square, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import * as actions from "../../lib/actions";
import { isH3Aligned, nearestH3Duration, snapToFrame } from "../../lib/planH3";
import {
  bindPlanToForm,
  ensurePlanFormSync,
  flushFormToPlan,
  planFromForm,
  setFormFieldFromPlan,
  unbindPlanForm,
} from "../../lib/planForm";
import { useForm } from "../../store/form";
import { useLibrary } from "../../store/library";
import {
  audioTracks,
  commands,
  emptyPlan,
  findPlan,
  flushTimelinePersist,
  openPlanInSidebar,
  planTracks,
  timelineBeats,
  useTimeline,
  type Plan,
} from "../../store/timeline";
import { useUI } from "../../store/ui";
import { DurationChip, FormatChip, LookChip, QualityChip, StyleChip, useEstimates } from "../generate/Chips";
import { PromptEditor } from "../generate/PromptEditor";
import { RefsZone } from "../generate/RefsZone";
import { Button, SectionTitle, Select } from "../ui";

const STATUS_LABEL: Record<Plan["status"], string> = {
  empty: "Пусто",
  queued: "В очереди",
  running: "Идёт",
  draft: "Черновик",
  done: "Готово",
  error: "Ошибка",
};

ensurePlanFormSync();

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

            {plan.error && <p className="rounded-lg bg-bad/10 px-2 py-1.5 text-[12px] text-bad">{plan.error}</p>}
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

      <div className="space-y-1.5 border-t border-line p-3">
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="primary"
            className="flex-1"
            disabled={busy || locked}
            onClick={() => void enqueue(plan.mode === "final" ? "final" : "draft")}
          >
            <Play size={12} /> {plan.mode === "final" ? "В очередь" : "В очередь · черновик"}
          </Button>
          <Button size="sm" disabled={busy || locked} title="Переген" onClick={() => void enqueue(plan.mode === "final" ? "final" : "draft")}>
            <RefreshCw size={12} />
          </Button>
        </div>
        {plan.status === "draft" && (
          <Button size="sm" className="w-full" disabled={busy} onClick={() => void enqueue("final")}>
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
          <Button size="sm" className="flex-1" disabled={busy || locked} onClick={() => void continueFrame()}>
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
        {planTracks(doc).filter((t) => t.id !== track.id).length > 0 && (
          <div className="flex gap-1.5">
            {planTracks(doc)
              .filter((t) => t.id !== track.id)
              .slice(0, 2)
              .map((t) => (
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
    </div>
  );
}

/** Batch bar used from TimelineStrip toolbar. */
export function PlanBatchBar({ selectedIds }: { selectedIds: string[] }) {
  const doc = useTimeline((s) => s.doc);
  const [busy, setBusy] = useState(false);
  const presets = useLibrary((s) => s.meta?.quality ?? []);
  const [finalQuality, setFinalQuality] = useState(() => localStorage.getItem("sm.planFinalQuality") || "high");
  const allIds = [...new Set(planTracks(doc).flatMap((t) => t.plans.map((p) => p.id)))];
  const picked = [...new Set(selectedIds)];
  const ids = picked.length ? picked : allIds;
  const usingAll = picked.length === 0 && allIds.length > 0;

  // If stored id disappeared from settings, fall back to last preset / high / first.
  const qualityOptions = presets.map((p) => ({ value: p.id, label: p.label }));
  const effectiveFinal =
    qualityOptions.some((o) => o.value === finalQuality)
      ? finalQuality
      : qualityOptions.find((o) => o.value === "high")?.value
        ?? qualityOptions[qualityOptions.length - 1]?.value
        ?? "high";

  const runBatch = async (mode: "draft" | "final") => {
    if (!ids.length) {
      useUI.getState().toast("Нет планов", "info");
      return;
    }
    flushFormToPlan();
    setBusy(true);
    try {
      const projectId = useUI.getState().projectId;
      const quality = mode === "draft" ? "draft" : effectiveFinal;
      const qLabel = presets.find((p) => p.id === quality)?.label ?? quality;
      for (const id of ids) {
        const hit = findPlan(useTimeline.getState().doc, id);
        if (!hit) continue;
        useTimeline.getState().run(commands.updatePlan(useTimeline.getState().doc, id, hit.track.id, { quality, mode }));
      }
      await flushTimelinePersist();
      const res = await api.enqueuePlans(projectId, ids, mode);
      res.generations.forEach((g) => useLibrary.getState().upsertGeneration(g));
      useTimeline.getState().load(res.timeline as never);
      useUI.getState().toast(`Очередь: ${ids.length} · ${qLabel}`, "ok");
    } catch (e) {
      useUI.getState().toast(e instanceof Error ? e.message : "Ошибка очереди", "bad");
    } finally {
      setBusy(false);
    }
  };

  const queueCount = useLibrary((s) =>
    Object.values(s.generations).filter((g) => g.status === "queued" || g.status === "running").length,
  );
  const queueLabel = useLibrary((s) => {
    let n = 0;
    let eta = 0;
    for (const g of Object.values(s.generations)) {
      if (g.status === "queued" || g.status === "running") {
        n += 1;
        eta += g.estimate_s ?? 0;
      }
    }
    return n === 0 ? "" : `очередь: ${n}${eta > 0 ? ` · ~${Math.ceil(eta / 60)} мин` : ""}`;
  });
  const [night, setNight] = useState(() => localStorage.getItem("sm.nightMode") === "1");

  const stopAll = async () => {
    setBusy(true);
    try {
      await actions.cancelAll();
      const projectId = useUI.getState().projectId;
      try {
        const proj = await api.project(projectId);
        if (proj?.timeline) useTimeline.getState().load(proj.timeline as never);
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      {picked.length > 0 ? (
        <span className="text-[11px] tabular-nums text-accent" title="Чекбокс на плане · Shift+чекбокс — диапазон · Esc — сбросить">
          выбрано: {picked.length}
        </span>
      ) : (
        <span className="text-[11px] text-faint" title="Отметьте планы чекбоксом на таймлайне">
          {allIds.length ? "все планы" : "нет планов"}
        </span>
      )}
      {queueLabel && <span className="text-[11px] tabular-nums text-faint">{queueLabel}</span>}
      <Button
        size="sm"
        variant="danger"
        disabled={busy || queueCount === 0}
        title="Остановить текущую и снять все из очереди"
        onClick={() => void stopAll()}
      >
        <Square size={11} className="fill-current" /> Стоп все
      </Button>
      <label className="flex items-center gap-1 text-[11px] text-faint" title="Без ассистента и без preview-кадров">
        <input
          type="checkbox"
          checked={night}
          onChange={(e) => {
            const on = e.target.checked;
            setNight(on);
            localStorage.setItem("sm.nightMode", on ? "1" : "0");
            if (on) void api.assistantUnload().catch(() => undefined);
          }}
        />
        ночь
      </label>
      <Button size="sm" disabled={busy || !ids.length} onClick={() => void runBatch("draft")} title="Пресет «Черновик» из настроек качества">
        Все → черновик
      </Button>
      <div className="w-[7.5rem] shrink-0" title="Пресет из Настройки → Качество">
        <Select
          value={effectiveFinal}
          onChange={(v) => {
            setFinalQuality(v);
            localStorage.setItem("sm.planFinalQuality", v);
          }}
          options={qualityOptions.length ? qualityOptions : [{ value: "high", label: "Высокое" }]}
        />
      </div>
      <Button
        size="sm"
        disabled={busy || !ids.length}
        onClick={() => void runBatch("final")}
        title={
          usingAll
            ? "Нет выбора — в очередь уйдут все планы. Отметьте чекбоксами на таймлайне."
            : "Поставить выбранные планы с качеством из списка слева"
        }
      >
        {usingAll ? "Все → очередь" : "Выбранные → очередь"}
      </Button>
      <Button
        size="sm"
        disabled={busy || !timelineBeats(doc).beats.length}
        title="Разложить бриф из панели генерации по битам"
        onClick={() => {
          const { beats: tb, downbeats: td } = timelineBeats(useTimeline.getState().doc);
          const marks = td.length ? td : tb;
          if (marks.length < 2) {
            useUI.getState().toast("Сначала найдите биты", "info");
            return;
          }
          const prompt = useForm.getState().prompt.trim();
          const pt = planTracks(doc)[0];
          if (!pt) return;
          let lastId: string | null = null;
          for (let i = 0; i < marks.length - 1; i++) {
            const start = marks[i];
            const raw = marks[i + 1] - start;
            const plan = emptyPlan({
              start,
              duration: nearestH3Duration(Math.max(0.2, raw)),
              prompt: prompt ? `${prompt} — часть ${i + 1}` : "",
              name: `План ${i + 1}`,
              mode: "draft",
            });
            useTimeline.getState().run(commands.addPlan(plan, pt.id));
            lastId = plan.id;
          }
          if (lastId) openPlanInSidebar(lastId);
          useUI.getState().toast(`Идея разложена на ${marks.length - 1} план(ов)`, "ok");
        }}
      >
        По битам
      </Button>
      <Button
        size="sm"
        disabled={busy}
        title="Новый план у курсора"
        onClick={() => {
          const d = useTimeline.getState().doc;
          const pt = planTracks(d)[0];
          if (!pt) return;
          const start = useTimeline.getState().playhead;
          const plan = emptyPlan({ start, duration: nearestH3Duration(2), mode: "draft" });
          useTimeline.getState().run(commands.addPlan(plan, pt.id));
          openPlanInSidebar(plan.id);
        }}
      >
        + План
      </Button>
    </div>
  );
}

function previousPlanByTime(doc: ReturnType<typeof useTimeline.getState>["doc"], plan: Plan): Plan | null {
  const all = planTracks(doc)
    .flatMap((t) => t.plans)
    .filter((p) => p.id !== plan.id && p.start + p.duration <= plan.start + 0.01)
    .sort((a, b) => b.start + b.duration - (a.start + a.duration));
  return all.find((p) => p.outputAssetId || p.draftAssetId) ?? null;
}

function buildChecklist(doc: ReturnType<typeof useTimeline.getState>["doc"], plan: Plan): string[] {
  const out: string[] = [];
  if (!plan.prompt.trim()) out.push("Пустой бриф");
  const enabledAudio = audioTracks(doc).filter((t) => plan.audio[t.id] !== false && !t.muted);
  let audioHits = 0;
  for (const t of enabledAudio) {
    for (const c of t.clips) {
      const a0 = c.start ?? 0;
      const a1 = a0 + Math.max(0, c.out - c.in);
      if (Math.min(plan.start + plan.duration, a1) - Math.max(plan.start, a0) >= 0.2) audioHits++;
    }
  }
  if (audioHits > 3) out.push(`Аудио пересечений: ${audioHits} (лимит 3)`);
  if (plan.lipsync && audioHits === 0) out.push("Липсинг включён, но нет пересечения с A-треком");
  if (audioHits > 0 && !/<Audio\s+\d+>/i.test(plan.prompt)) {
    out.push("A-трек пересекается — в промпт добавятся метки <Audio N> при постановке в очередь");
  }
  if (!isH3Aligned(plan.duration)) out.push(`Длительность вне сетки H3 (→ ${nearestH3Duration(plan.duration).toFixed(2)} с)`);
  return out;
}
