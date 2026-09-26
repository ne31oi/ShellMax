import { CheckCircle2, Download, Sparkles } from "lucide-react";
import { useEffect } from "react";
import { fmtSize } from "../../lib/format";
import { useAssistant } from "../../store/assistant";
import { useUI } from "../../store/ui";
import { Button, Dialog } from "../ui";

/** Shown when the assistant is used before its model is downloaded (studio "Модель ассистента не скачана"). */
export function AssistantSetup() {
  const open = useAssistant((s) => s.setupOpen);
  const status = useAssistant((s) => s.status);
  const { download, openSetup, refresh } = useAssistant.getState();

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const total = status?.total_bytes ?? 0;
  const got = status?.received_bytes ?? 0;
  const pct = total ? Math.round((got / total) * 100) : 0;
  const failed = status?.files.find((f) => f.status === "error");

  return (
    <Dialog open={open} onOpenChange={openSetup} title="Ассистент промптов">
      <div className="space-y-4 p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
            <Sparkles size={18} />
          </div>
          <p className="text-[13px] leading-relaxed text-muted">
            Ассистент превращает ваше описание обычными словами в промпт по спецификации и пишет промпты для улучшения лица.
            Он работает локально на вашей видеокарте, без интернета. Нужна разовая загрузка модели{" "}
            <b className="text-fg">{status?.label ?? "Bonsai 2 27B"}</b> — движок, модель и «зрение» для референсов.
          </p>
        </div>

        {status?.ready ? (
          <div className="flex items-center gap-2 rounded-xl border border-ok/30 bg-ok/5 px-3 py-2.5 text-[13px]">
            <CheckCircle2 size={16} className="text-ok" /> Модель готова — нажмите «В промпт» ещё раз.
          </div>
        ) : status?.downloading ? (
          <div>
            <div className="mb-1.5 flex justify-between text-xs text-muted tabular-nums">
              <span>Скачиваю… {pct}%</span>
              <span>{fmtSize(got)} из {fmtSize(total)}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${pct}%` }} />
            </div>
            <ul className="mt-2 space-y-0.5 text-[11px] text-faint">
              {status.files.map((f) => (
                <li key={f.id} className="flex justify-between tabular-nums">
                  <span>{f.label}</span>
                  <span>{f.status === "ready" ? "готово" : f.status === "downloading" ? `${Math.round((f.received / (f.total || 1)) * 100)}%` : f.status === "error" ? "ошибка" : "ждёт"}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-faint">Окно можно закрыть — загрузка продолжится.</p>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted">
              {failed ? <span className="text-bad">Ошибка: {failed.error}</span> : `Размер: ~${fmtSize(total - got)}`}
            </span>
            <Button variant="primary" onClick={download}>
              <Download size={14} /> {failed ? "Повторить" : "Скачать"}
            </Button>
          </div>
        )}

        <button
          onClick={() => {
            openSetup(false);
            useUI.getState().openSettings("assistant");
          }}
          className="text-xs text-muted underline-offset-2 hover:text-fg hover:underline"
        >
          Выбрать другую модель…
        </button>
      </div>
    </Dialog>
  );
}
