import { Square } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import * as actions from "../../lib/actions";
import { flushFormToPlan } from "../../lib/planForm";
import { nearestH3Duration } from "../../lib/planH3";
import { useForm } from "../../store/form";
import { useLibrary } from "../../store/library";
import {
  commands,
  emptyPlan,
  findPlan,
  flushTimelinePersist,
  openPlanInSidebar,
  planTracks,
  timelineBeats,
  useTimeline,
} from "../../store/timeline";
import { useUI } from "../../store/ui";
import { Button, Select } from "../ui";

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
