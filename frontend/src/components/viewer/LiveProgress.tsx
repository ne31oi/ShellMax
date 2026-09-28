import clsx from "clsx";
import { Square } from "lucide-react";
import type { Generation } from "../../api/types";
import * as actions from "../../lib/actions";
import { stageIndex, stageInfo, stagesOf, stepProgress, trackSummary } from "../../lib/stages";
import { fmtDuration, fmtEstimate } from "../../lib/format";
import { useElapsed } from "../../lib/useElapsed";
import { Button, Spinner } from "../ui";

export function LiveView({ gen, preview }: { gen: Generation; preview?: string }) {
  const elapsed = useElapsed(gen.status === "running" ? gen.started : null);
  const left = elapsed != null && gen.estimate_s ? Math.max(0, gen.estimate_s - elapsed) : null;

  const stage = stageInfo(gen.stage, gen);
  const step = stepProgress(gen);
  const queued = gen.status === "queued";

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 p-6">
      <div className="relative aspect-video w-full max-w-3xl overflow-hidden rounded-xl bg-raised">
        {preview ? <img src={preview} alt="" className="h-full w-full object-contain" /> : <div className="shimmer h-full w-full" />}
      </div>

      <div className="w-full max-w-3xl">
        {/* current stage: what is happening right now and how far along it is */}
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">{queued ? "В очереди" : stage.label}</p>
            <p className="mt-0.5 text-xs text-muted tabular-nums">
              {queued ? "Начнётся, когда освободится движок" : step ? `шаг ${step.value} из ${step.max}` : "выполняется…"}
            </p>
          </div>
          {!queued && (
            <div className="shrink-0 text-right">
              <span className="text-2xl font-semibold tabular-nums">{step ? `${step.pct}%` : <Spinner size={18} />}</span>
              {elapsed != null && (
                <p className="mt-0.5 text-xs text-muted tabular-nums" title="Время текущего прогона">
                  {fmtDuration(elapsed)}
                  {gen.estimate_s ? ` / ${fmtEstimate(gen.estimate_s)}` : ""}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
          {step ? (
            <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${step.pct}%` }} />
          ) : (
            !queued && <div className="shimmer h-full w-full bg-accent/30" />
          )}
        </div>

        <StageTrack gen={gen} />

        <div className="mt-4 flex items-center justify-between text-xs text-faint tabular-nums">
          <span>
            Всего {Math.round(gen.progress * 100)}%
            {elapsed != null ? ` · идёт ${fmtDuration(elapsed)}` : ""}
            {left != null ? ` · осталось ${fmtEstimate(left)}` : ""}
          </span>
          <Button variant="ghost" size="sm" onClick={() => actions.cancel(gen)}>
            <Square size={12} /> {queued ? "Убрать из очереди" : "Остановить"}
          </Button>
        </div>
        {!gen.draft_asset_id && !queued && (
          <p className="mt-1 text-center text-[11px] text-faint">
            {gen.kind === "face"
              ? "Сначала найдём лицо на каждом кадре — покажем превью трекинга"
              : "Черновик появится после первого прохода — тогда можно будет не ждать финал"}
          </p>
        )}
      </div>
    </div>
  );
}

/** All stages in a row: done / current (with its percent) / upcoming. */
export function StageTrack({ gen }: { gen: Generation }) {
  const current = gen.status === "queued" ? -1 : stageIndex(gen.stage, gen);
  const step = stepProgress(gen);
  const stages = stagesOf(gen);
  return (
    <div className="mt-4 grid gap-1" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}>
      {stages.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <div key={s.id} title={s.label} className="min-w-0">
            <div className="h-1 overflow-hidden rounded-full bg-line">
              <div
                className={clsx("h-full rounded-full", done ? "bg-accent" : active ? "bg-accent transition-[width] duration-300" : "")}
                style={{ width: done ? "100%" : active ? `${step?.pct ?? 8}%` : "0%" }}
              />
            </div>
            <p className={clsx("mt-1 truncate text-[10px] tabular-nums", active ? "text-fg" : done ? "text-muted" : "text-faint")}>
              {s.short}
              {active && step ? ` ${step.pct}%` : ""}
            </p>
          </div>
        );
      })}
    </div>
  );
}

export function DraftBanner({ gen }: { gen: Generation }) {
  const step = stepProgress(gen);
  const elapsed = useElapsed(gen.started);
  return (
    <div className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-warn/40 bg-panel/95 px-3 py-2 shadow-xl backdrop-blur">
      <span className="text-xs tabular-nums">
        <b className="text-warn">Черновик готов.</b> {stageInfo(gen.stage, gen).short}
        {step ? ` · шаг ${step.value}/${step.max} · ${step.pct}%` : ""}
        <span className="text-faint">
          {" "}· всего {Math.round(gen.progress * 100)}%
          {elapsed != null ? ` · ${fmtDuration(elapsed)}` : ""}
        </span>
      </span>
      <Button size="sm" variant="outline" onClick={() => actions.cancel(gen)}>
        Не нравится — остановить
      </Button>
    </div>
  );
}

/** Face job: the tracking preview is ready - say whether the face was found while refining goes on. */
export function FaceTrackBanner({ gen }: { gen: Generation }) {
  const step = stepProgress(gen);
  const elapsed = useElapsed(gen.started);
  const t = trackSummary(gen.info?.track_report);
  return (
    <div className="absolute left-1/2 top-3 flex max-w-[90%] -translate-x-1/2 items-center gap-3 rounded-xl border border-line bg-panel/95 px-3 py-2 shadow-xl backdrop-blur">
      <span className="text-xs tabular-nums">
        {t ? <b className={t.warn ? "text-warn" : "text-ok"}>{t.found}.</b> : <b>Трекинг готов.</b>}{" "}
        {t?.warn ?? t?.size ?? ""}
        <span className="text-faint">
          {" "}· {stageInfo(gen.stage, gen).short}
          {step ? ` ${step.value}/${step.max}` : ""} · всего {Math.round(gen.progress * 100)}%
          {elapsed != null ? ` · ${fmtDuration(elapsed)}` : ""}
        </span>
      </span>
      <Button size="sm" variant="outline" onClick={() => actions.cancel(gen)}>
        Остановить
      </Button>
    </div>
  );
}
