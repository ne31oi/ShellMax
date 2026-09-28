import clsx from "clsx";
import { Check, Copy, X } from "lucide-react";
import { useState } from "react";
import { useUI } from "../../store/ui";
import { copyText } from "../ui";

export function Toasts() {
  const toasts = useUI((s) => s.toasts);
  const dismiss = useUI((s) => s.dismiss);
  const [copied, setCopied] = useState<number | null>(null);
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
          <span className="min-w-0 flex-1 break-words">{t.text}</span>
          {t.tone === "bad" && <button onClick={() => void copyText(t.text).then(() => {
            setCopied(t.id);
            window.setTimeout(() => setCopied((id) => id === t.id ? null : id), 1500);
          }).catch(() => undefined)} title="Скопировать ошибку" aria-label="Скопировать ошибку"
            className="shrink-0 text-muted hover:text-fg">{copied === t.id ? <Check size={14} /> : <Copy size={14} />}</button>}
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
