import clsx from "clsx";
import { X } from "lucide-react";
import { useUI } from "../../store/ui";

export function Toasts() {
  const toasts = useUI((s) => s.toasts);
  const dismiss = useUI((s) => s.dismiss);
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={clsx(
            "pointer-events-auto flex max-w-lg items-center gap-3 rounded-xl border px-3.5 py-2.5 text-[13px] shadow-2xl backdrop-blur",
            t.tone === "bad" ? "border-bad/40 bg-panel/95 text-fg" : t.tone === "ok" ? "border-ok/30 bg-panel/95" : "border-line bg-panel/95",
          )}
        >
          <span className={clsx("h-2 w-2 shrink-0 rounded-full", t.tone === "bad" ? "bg-bad" : t.tone === "ok" ? "bg-ok" : "bg-accent")} />
          <span className="flex-1">{t.text}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
              className="shrink-0 font-medium text-accent hover:text-accent-strong"
            >
              {t.action.label}
            </button>
          )}
          <button onClick={() => dismiss(t.id)} className="shrink-0 text-faint hover:text-fg" aria-label="Закрыть">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
