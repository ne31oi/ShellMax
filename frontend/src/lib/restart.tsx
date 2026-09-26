/** Full ShellMax restart (API + ComfyUI + assistant) shared by header and System settings. */

import { useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client";
import { Spinner } from "../components/ui";

const CONFIRM =
  "Перезапустить ShellMax целиком?\n\nОстановятся бэкенд, движок ComfyUI и ассистент. Текущая генерация прервётся. Страница обновится сама.";

export function useRestartAll() {
  const [restarting, setRestarting] = useState(false);

  const restartAll = async () => {
    if (!confirm(CONFIRM)) return;
    setRestarting(true);
    try {
      await api.restartAll();
    } catch {
      // connection often drops before the response arrives — that is expected
    }
    const started = Date.now();
    while (Date.now() - started < 180_000) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const r = await fetch("/api/meta", { cache: "no-store" });
        if (r.ok) {
          window.location.reload();
          return;
        }
      } catch {
        /* still down */
      }
    }
    setRestarting(false);
    alert("ShellMax не ответил за 3 минуты. Запустите вручную scripts\\start.bat");
  };

  const overlay =
    restarting &&
    createPortal(
      <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-3 bg-bg/90 text-fg backdrop-blur-sm">
        <Spinner />
        <p className="text-sm font-medium">Перезапуск ShellMax…</p>
        <p className="text-xs text-muted">Страница обновится, когда сервер снова ответит</p>
      </div>,
      document.body,
    );

  return { restarting, restartAll, overlay };
}
