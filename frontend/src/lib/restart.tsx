/** Full ShellMax restart / shutdown (API + ComfyUI + assistant) shared by header and System settings. */

import { useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client";
import { Spinner } from "../components/ui";

const CONFIRM_RESTART =
  "Перезапустить ShellMax целиком?\n\nОстановятся бэкенд, движок ComfyUI и ассистент. Текущая генерация прервётся. Страница обновится сама.";

const CONFIRM_SHUTDOWN =
  "Выключить ShellMax целиком?\n\nОстановятся бэкенд, движок ComfyUI и ассистент. Текущая генерация прервётся. Запуск снова — scripts\\start.bat.";

async function readMetaPid(): Promise<number | null> {
  try {
    const r = await fetch("/api/meta", { cache: "no-store" });
    if (!r.ok) return null;
    const data = (await r.json()) as { pid?: number };
    return typeof data.pid === "number" ? data.pid : null;
  } catch {
    return null;
  }
}

function busyOverlay(title: string, hint: string) {
  return createPortal(
    <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-3 bg-bg/90 text-fg backdrop-blur-sm">
      <Spinner />
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted">{hint}</p>
    </div>,
    document.body,
  );
}

export function useRestartAll() {
  const [restarting, setRestarting] = useState(false);

  const restartAll = async () => {
    if (!confirm(CONFIRM_RESTART)) return;
    setRestarting(true);
    const previousPid = await readMetaPid();
    try {
      await api.restartAll();
    } catch {
      // connection often drops before the response arrives — that is expected
    }
    const started = Date.now();
    while (Date.now() - started < 180_000) {
      await new Promise((r) => setTimeout(r, 1000));
      const pid = await readMetaPid();
      // Same process still answering during shutdown — keep waiting for a new pid.
      if (pid != null && (previousPid == null || pid !== previousPid)) {
        window.location.reload();
        return;
      }
    }
    setRestarting(false);
    alert("ShellMax не ответил за 3 минуты. Запустите вручную scripts\\start.bat");
  };

  const overlay =
    restarting &&
    busyOverlay("Перезапуск ShellMax…", "Страница обновится, когда сервер снова ответит");

  return { restarting, restartAll, overlay };
}

export function useShutdownAll() {
  const [shuttingDown, setShuttingDown] = useState(false);
  const [done, setDone] = useState(false);

  const shutdownAll = async () => {
    if (!confirm(CONFIRM_SHUTDOWN)) return;
    setShuttingDown(true);
    try {
      await api.shutdownAll();
    } catch {
      // connection often drops before the response arrives — that is expected
    }
    const started = Date.now();
    while (Date.now() - started < 60_000) {
      await new Promise((r) => setTimeout(r, 500));
      if ((await readMetaPid()) == null) {
        setDone(true);
        return;
      }
    }
    // Even if meta still answers, treat as done — user asked to power off.
    setDone(true);
  };

  const overlay =
    shuttingDown &&
    (done
      ? createPortal(
          <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-3 bg-bg/90 text-fg backdrop-blur-sm">
            <p className="text-sm font-medium">ShellMax выключен</p>
            <p className="text-xs text-muted">Запуск снова: scripts\start.bat</p>
          </div>,
          document.body,
        )
      : busyOverlay("Выключение ShellMax…", "Останавливаются бэкенд, движок и ассистент"));

  return { shuttingDown, shutdownAll, overlay };
}
