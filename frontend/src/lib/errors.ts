import { ApiError } from "../api/client";
import { useUI } from "../store/ui";

/** True when the API signals a missing model/file the user can fix in Engine settings. */
export function isMissingFileError(e: unknown): e is ApiError {
  return (
    e instanceof ApiError &&
    !!e.detail &&
    typeof e.detail === "object" &&
    (e.detail as { kind?: string }).kind === "missing_file"
  );
}

/**
 * Toast (+ optional settings action for missing_file) and optionally set inline error text.
 * Use from actions and post-job dialogs so fix UX stays consistent with Viewer.
 */
export function reportJobError(e: unknown, setInline?: (msg: string) => void): void {
  const msg = e instanceof Error ? e.message : String(e);
  if (isMissingFileError(e)) {
    useUI.getState().toast(msg, "bad", {
      label: "Открыть настройки",
      run: () => useUI.getState().openSettings("engine"),
    });
  } else {
    useUI.getState().toast(msg, "bad");
  }
  setInline?.(msg);
}
