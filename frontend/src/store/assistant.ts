import { create } from "zustand";
import { api, ApiError, streamAssistant } from "../api/client";
import type { AssistantStatus } from "../api/types";
import { useUI } from "./ui";

// edit: fix the generation prompt in plain words; chat: the ideas assistant tab
export type AssistantTarget = "compose" | "edit" | "face" | "mask" | "chat";

interface AssistantJob {
  target: AssistantTarget;
  stage: "loading" | "writing" | "repairing";
  text: string; // raw reply so far (shown live)
}

interface AssistantState {
  status: AssistantStatus | null;
  job: AssistantJob | null;
  lastError: string | null;
  setupOpen: boolean; // "model not downloaded" dialog
  refresh: (force?: boolean) => Promise<void>;
  download: () => Promise<void>;
  openSetup: (open: boolean) => void;
  /** Runs a job; resolves with the finished prompt, or null if stopped/failed/unavailable. */
  run: (target: AssistantTarget, url: string, body: unknown) => Promise<string | null>;
  stop: () => void;
}

let abort: AbortController | null = null;

export const useAssistant = create<AssistantState>((set, get) => ({
  status: null,
  job: null,
  lastError: null,
  setupOpen: false,

  refresh: async (force = false) => {
    try {
      set({ status: await api.assistantStatus(force) });
    } catch {
      /* backend restarting */
    }
  },

  download: async () => {
    await api.assistantDownload();
    await get().refresh();
  },

  openSetup: (setupOpen) => set({ setupOpen }),

  run: async (target, url, body) => {
    if (get().job) return null;
    set({ lastError: null });
    await get().refresh();
    if (get().job) return null;
    if (!get().status?.ready) {
      set({ setupOpen: true, lastError: "Ассистент не настроен — откройте его настройки" });
      return null;
    }
    abort = new AbortController();
    set({ job: { target, stage: "loading", text: "" } });
    let result: string | null = null;
    try {
      await streamAssistant(
        url,
        body,
        (e) => {
          if ("stage" in e) set((s) => ({ job: s.job && { ...s.job, stage: e.stage } }));
          else if ("delta" in e) set((s) => ({ job: s.job && { ...s.job, stage: "writing", text: s.job.text + e.delta } }));
          else if ("replace" in e) set((s) => ({ job: s.job && { ...s.job, stage: "writing", text: e.replace } }));
          else if ("error" in e) {
            if (e.error === "model_missing") set({ setupOpen: true, lastError: "Модель ассистента не установлена — откройте его настройки" });
            else { set({ lastError: e.error }); useUI.getState().toast(e.error, "bad"); }
          } else if ("done" in e && !e.cancelled && e.prompt.trim()) result = e.prompt;
        },
        abort.signal,
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        const message = e instanceof ApiError ? e.message : "Ассистент недоступен";
        set({ lastError: message });
        useUI.getState().toast(message, e instanceof ApiError && e.status === 409 ? "info" : "bad");
      }
    } finally {
      abort = null;
      set({ job: null });
      void get().refresh();
    }
    return result;
  },

  stop: () => {
    void api.assistantStop().catch(() => undefined);
    abort?.abort();
  },
}));
