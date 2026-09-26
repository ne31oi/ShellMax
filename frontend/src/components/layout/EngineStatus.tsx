import clsx from "clsx";
import type { EngineStateName } from "../../api/types";
import { useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { Tip } from "../ui";

export const ENGINE_LABEL: Record<EngineStateName, string> = {
  not_installed: "Движок не установлен",
  stopped: "Движок остановлен",
  starting: "Движок запускается…",
  ready: "Движок готов",
  error: "Ошибка движка",
  external: "Движок готов (внешний)",
};

export function EngineStatus() {
  const engine = useLibrary((s) => s.engine);
  const gens = useLibrary((s) => s.generations);
  const openSettings = useUI((s) => s.openSettings);
  const state = engine?.state ?? "stopped";
  const ok = state === "ready" || state === "external";
  const running = Object.values(gens).filter((g) => g.status === "running").length;
  const queued = Object.values(gens).filter((g) => g.status === "queued").length;

  return (
    <div className="flex items-center gap-2">
      {(running > 0 || queued > 0) && (
        <Tip text={`Генерируется: ${running} · в очереди: ${queued}`}>
          <span className="flex items-center gap-1.5 rounded-full bg-accent/15 px-2.5 py-1 text-[11px] font-medium text-accent tabular-nums">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            {running + queued} в работе
          </span>
        </Tip>
      )}
      <Tip text={engine?.detail || ENGINE_LABEL[state]}>
        <button
          onClick={() => openSettings("system")}
          className="flex items-center gap-2 rounded-full border border-line px-2.5 py-1 text-[11px] text-muted hover:bg-hover hover:text-fg"
        >
          <span className={clsx("h-2 w-2 rounded-full", ok ? "bg-ok" : state === "starting" ? "animate-pulse bg-warn" : "bg-bad")} />
          {ENGINE_LABEL[state]}
        </button>
      </Tip>
    </div>
  );
}
