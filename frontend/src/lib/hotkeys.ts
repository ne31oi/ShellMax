import { useEffect } from "react";
import { useTimeline } from "../store/timeline";
import { useUI } from "../store/ui";
import { emit } from "./bus";

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && !!t.closest("input, textarea, select, [contenteditable=true]");

/** Global shortcuts. Typing contexts keep their own keys (the prompt editor has its own undo). */
export function useHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === "Enter") {
        e.preventDefault();
        emit("generate");
        return;
      }
      if (isTyping(e.target) || document.querySelector("[role=dialog]")) return;

      if (ctrl && e.key.toLowerCase() === "z") {
        e.preventDefault();
        const t = useTimeline.getState();
        const cmd = e.shiftKey ? t.redo() : t.undo();
        if (cmd) useUI.getState().toast(`${e.shiftKey ? "Повторено" : "Отменено"}: ${cmd.label}`, "info");
        return;
      }
      if (ctrl) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          emit("viewerToggle");
          break;
        case "ArrowLeft":
          emit("viewerStep", e.shiftKey ? -10 : -1);
          break;
        case "ArrowRight":
          emit("viewerStep", e.shiftKey ? 10 : 1);
          break;
        case "j":
        case "J":
          emit("viewerRate", -1);
          break;
        case "k":
        case "K":
          emit("viewerRate", 0);
          break;
        case "l":
        case "L":
          emit("viewerRate", 1);
          break;
        case "f":
        case "F":
          emit("viewerFullscreen");
          break;
        case "g":
        case "G": {
          const ui = useUI.getState();
          if (ui.workspace === "assistant") emit("focusPrompt");
          else ui.togglePanel();
          e.preventDefault();
          break;
        }
        case "b":
        case "B": {
          const ui = useUI.getState();
          if (ui.workspace !== "assistant") {
            ui.toggleBin();
            e.preventDefault();
          }
          break;
        }
        case "Escape":
          useUI.getState().compare(null);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
