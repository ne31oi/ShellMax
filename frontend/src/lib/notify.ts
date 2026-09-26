import type { Generation } from "../api/types";
import { useUI } from "../store/ui";

const KEY = "sm.notify";

export const notifySettings = {
  get(): { desktop: boolean; sound: boolean } {
    try {
      return { desktop: true, sound: true, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
    } catch {
      return { desktop: true, sound: true };
    }
  },
  set(v: { desktop: boolean; sound: boolean }) {
    localStorage.setItem(KEY, JSON.stringify(v));
    if (v.desktop && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  },
};

/** Soft two-note chime, no asset needed. */
function chime() {
  try {
    const ctx = new AudioContext();
    [660, 880].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      o.type = "sine";
      const t = ctx.currentTime + i * 0.14;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.08, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.4);
    });
  } catch {
    /* audio blocked */
  }
}

export function notifyDone(g: Generation) {
  const { desktop, sound } = notifySettings.get();
  const toast = useUI.getState().toast;
  if (g.status === "done") {
    if (sound) chime();
    if (desktop && document.hidden && "Notification" in window && Notification.permission === "granted") {
      new Notification("ShellMax: видео готово", { body: `Генерация #${g.id} завершена` });
    }
    toast(`Видео #${g.id} готово`, "ok", { label: "Показать", run: () => useUI.getState().selectGen(g.id) });
  } else if (g.status === "error") {
    toast(g.error || "Ошибка генерации", "bad");
  }
}
