import { useEffect } from "react";
import { useTimeline } from "../store/timeline";
import { useUI } from "../store/ui";
import { emit } from "./bus";

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && !!t.closest("input, textarea, select, [contenteditable=true]");

/**
 * Letter for a physical key (`KeyA`…`KeyZ`) — independent of keyboard layout.
 * Prefer this over `e.key` for shortcuts (RU layout: Ctrl+C → key "с").
 */
export function physicalLetter(e: KeyboardEvent): string | null {
  const m = /^Key([A-Z])$/.exec(e.code);
  return m ? m[1].toLowerCase() : null;
}

/** Global shortcuts. Typing contexts keep their own keys (the prompt editor has its own undo). */
export function useHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const letter = physicalLetter(e);

      if (ctrl && e.code === "Enter") {
        e.preventDefault();
        emit("generate");
        return;
      }
      if (isTyping(e.target) || document.querySelector("[role=dialog]")) return;

      if (ctrl && letter === "z") {
        e.preventDefault();
        const t = useTimeline.getState();
        const cmd = e.shiftKey ? t.redo() : t.undo();
        if (cmd) useUI.getState().toast(`${e.shiftKey ? "Повторено" : "Отменено"}: ${cmd.label}`, "info");
        return;
      }
      if (ctrl) return;

      if (e.code === "Space") {
        e.preventDefault();
        emit("viewerToggle");
        return;
      }
      if (e.code === "ArrowLeft") {
        emit("viewerStep", e.shiftKey ? -10 : -1);
        return;
      }
      if (e.code === "ArrowRight") {
        emit("viewerStep", e.shiftKey ? 10 : 1);
        return;
      }
      if (e.code === "Escape") {
        useUI.getState().compare(null);
        return;
      }

      switch (letter) {
        case "j":
          emit("viewerRate", -1);
          break;
        case "k":
          emit("viewerRate", 0);
          break;
        case "l":
          emit("viewerRate", 1);
          break;
        case "f":
          emit("viewerFullscreen");
          break;
        case "g": {
          const ui = useUI.getState();
          if (ui.workspace === "assistant") emit("focusPrompt");
          else ui.togglePanel();
          e.preventDefault();
          break;
        }
        case "b": {
          const ui = useUI.getState();
          if (ui.workspace !== "assistant") {
            ui.toggleBin();
            e.preventDefault();
          }
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
