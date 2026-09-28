import clsx from "clsx";
import { Play, Power, RefreshCw, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { useRestartAll } from "../../lib/restart";
import { notifySettings } from "../../lib/notify";
import { useLibrary } from "../../store/library";
import { Button, ErrorMessage, SectionTitle, Switch } from "../ui";
import { ENGINE_LABEL } from "../layout/EngineStatus";

export function SystemSettings() {
  const engine = useLibrary((s) => s.engine);
  const [lines, setLines] = useState<string[]>([]);
  const [notify, setNotify] = useState(notifySettings.get());
  const { restarting, restartAll, overlay } = useRestartAll();
  const logBox = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const { lines } = await api.engineLog().catch(() => ({ lines: [] as string[] }));
      if (!alive) return;
      setLines(lines);
      requestAnimationFrame(() => logBox.current && (logBox.current.scrollTop = logBox.current.scrollHeight));
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const setN = (v: typeof notify) => {
    setNotify(v);
    notifySettings.set(v);
  };
  const state = engine?.state ?? "stopped";
  const running = state === "ready" || state === "starting" || state === "external";

  return (
    <div className="space-y-6 p-5">
      <section>
        <SectionTitle>Движок (ComfyUI)</SectionTitle>
        <div className="rounded-xl border border-line p-4">
          <div className="flex items-center gap-3">
            <span className={clsx("h-2.5 w-2.5 rounded-full", state === "ready" || state === "external" ? "bg-ok" : state === "starting" ? "bg-warn animate-pulse" : "bg-bad")} />
            <div className="flex-1">
              <p className="text-[13px]">{ENGINE_LABEL[state]}</p>
              <p className="text-[11px] text-faint">
                {engine?.url}
                {engine?.pid ? ` · pid ${engine.pid}` : ""}
              </p>
            </div>
            {state !== "not_installed" && (
              <div className="flex gap-1.5">
                {!running && (
                  <Button size="sm" variant="primary" onClick={() => api.engineAction("start")}>
                    <Play size={12} /> Запустить
                  </Button>
                )}
                {running && (
                  <Button size="sm" onClick={() => api.engineAction("restart")}>
                    <RefreshCw size={12} /> Перезапустить
                  </Button>
                )}
                {running && state !== "external" && (
                  <Button size="sm" variant="ghost" onClick={() => api.engineAction("stop")}>
                    <Square size={12} /> Остановить
                  </Button>
                )}
              </div>
            )}
          </div>
          {state === "not_installed" && (
            <div className="mt-3 rounded-lg bg-raised p-3 text-xs leading-relaxed text-muted">
              Отдельная копия ComfyUI ставится в <code className="font-mono text-fg">F:\ShellMax\comfy</code> одной командой в PowerShell:
              <pre className="mt-2 select-text rounded-md bg-bg p-2 font-mono text-[11px] text-fg">powershell -ExecutionPolicy Bypass -File scripts\install_comfy.ps1</pre>
              Модели не копируются — используются из текущей папки моделей.
            </div>
          )}
          {engine?.detail && state === "error" && <ErrorMessage text={engine.detail} className="mt-3" />}
        </div>
        <pre ref={logBox} className="mt-3 h-64 select-text overflow-auto rounded-xl border border-line bg-bg p-3 font-mono text-[11px] leading-relaxed text-muted">
          {lines.length ? lines.join("\n") : "Лог движка появится после запуска"}
        </pre>
      </section>

      <section>
        <SectionTitle>ShellMax</SectionTitle>
        <div className="rounded-xl border border-line p-4">
          <p className="mb-3 text-xs leading-relaxed text-muted">
            Полный перезапуск: API, ComfyUI и ассистент. Та же кнопка — в шапке рядом со статусом движка. После обновления
            бэкенда или если всё «зависло». Модели загрузятся снова.
          </p>
          <Button size="sm" variant="danger" disabled={restarting} onClick={restartAll}>
            <Power size={12} /> Перезапустить всё
          </Button>
        </div>
      </section>

      <section>
        <SectionTitle>Уведомления</SectionTitle>
        <div className="space-y-3">
          <label className="flex items-center justify-between">
            <span className="text-[13px]">Системное уведомление, когда видео готово (если окно в фоне)</span>
            <Switch checked={notify.desktop} onChange={(desktop) => setN({ ...notify, desktop })} />
          </label>
          <label className="flex items-center justify-between">
            <span className="text-[13px]">Тихий звуковой сигнал</span>
            <Switch checked={notify.sound} onChange={(sound) => setN({ ...notify, sound })} />
          </label>
        </div>
      </section>

      {overlay}
    </div>
  );
}
