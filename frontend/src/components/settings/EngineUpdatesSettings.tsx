import { Download, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { EngineUpdateStatus } from "../../api/update-types";
import { Button, ErrorMessage, SectionTitle, Spinner } from "../ui";

const revision = (value: string) => /^[a-f0-9]{40}$/.test(value) ? value.slice(0, 8) : value;

export function EngineUpdatesSettings({ onInstallingChange }: { onInstallingChange: (active: boolean) => void }) {
  const [status, setStatus] = useState<EngineUpdateStatus | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [requesting, setRequesting] = useState(false);
  const seen = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await api.engineUpdates();
        if (!alive) return;
        setStatus(next);
        setConnectionError("");
      } catch (e) {
        if (alive) setConnectionError(e instanceof Error ? e.message : "Не удалось получить состояние обновлений");
      } finally {
        if (alive) timer = setTimeout(tick, 2000);
      }
    };
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  useEffect(() => {
    onInstallingChange(status?.installing ?? false);
  }, [status?.installing, onInstallingChange]);

  useEffect(() => {
    if (status?.check_id && status.check_id !== seen.current) {
      seen.current = status.check_id;
      setSelected(status.components.filter((c) => c.available && !c.error && !c.blocked).map((c) => c.id));
    }
  }, [status]);

  const perform = async (action: () => Promise<EngineUpdateStatus>) => {
    setRequesting(true);
    setError("");
    try { setStatus(await action()); }
    catch (e) { setError(e instanceof Error ? e.message : "Не удалось начать обновление"); }
    finally { setRequesting(false); }
  };
  const active = requesting || !!status?.active;
  const hasUpdates = status?.components.some((c) => c.available);

  return (
    <section>
      <SectionTitle>Обновления движка и пакетов</SectionTitle>
      <div className="space-y-3 rounded-xl border border-line p-4">
        <p className="text-xs leading-relaxed text-muted">
          Собственный ComfyUI ShellMax, установленные пакеты нод и их Python-зависимости.
          Версии из основной ветки авторов; Torch и CUDA-ускорители сохраняются.
        </p>
        <div className="flex items-start gap-2 text-[13px]" role="status" aria-live="polite">
          {active && <Spinner size={14} />}
          <p className={`min-w-0 whitespace-pre-wrap ${status?.phase === "error" ? "text-bad" : status?.phase === "done" ? "text-ok" : "text-fg"}`}>
            {status?.message ?? "Загружаю состояние обновлений…"}
          </p>
        </div>
        {status?.checked_at && (
          <p className="text-[11px] text-faint">Проверено: {new Date(status.checked_at * 1000).toLocaleString("ru-RU")}</p>
        )}
        {!!status?.components.length && (
          <div className="max-h-72 divide-y divide-line overflow-auto rounded-lg border border-line">
            {status.components.map((c) => (
              <label key={c.id} className="flex items-start gap-2.5 px-3 py-2.5">
                <input type="checkbox" aria-label={`Обновить ${c.name}`} className="mt-0.5 accent-accent"
                  checked={selected.includes(c.id)} disabled={active || status.phase !== "ready" || !c.available || !!c.blocked || !!c.error}
                  onChange={(e) => setSelected((ids) => e.target.checked ? [...ids, c.id] : ids.filter((id) => id !== c.id))} />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-xs">{c.name}</p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    {c.current_label ?? revision(c.current)}{c.available ? ` → ${c.latest_label ?? revision(c.latest)}` : !c.error ? " · актуально" : ""}
                  </p>
                  {(c.blocked || c.error) && <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-warn">{c.blocked || c.error}</p>}
                </div>
              </label>
            ))}
          </div>
        )}
        {status?.phase === "ready" && !hasUpdates && !status.components.some((c) => c.error) && (
          <p className="text-xs text-ok">Доступных обновлений нет.</p>
        )}
        {!!status?.packages.length && (
          <details className="text-xs text-muted">
            <summary className="cursor-pointer">Изменения зависимостей ({status.packages.length})</summary>
            <ul className="mt-2 max-h-44 space-y-1 overflow-auto font-mono text-[11px]">
              {status.packages.map((p) => <li key={p.name}>{p.name}: {p.current ?? "не установлен"} → {p.latest}</li>)}
            </ul>
          </details>
        )}
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" disabled={active || !status} onClick={() => void perform(api.checkEngineUpdates)}>
            <RefreshCw size={12} /> Проверить обновления
          </Button>
          {status?.phase === "ready" && hasUpdates && (
            <Button size="sm" variant="primary" disabled={active || !selected.length || !status.check_id}
              onClick={() => status.check_id && void perform(() => api.installEngineUpdates(selected, status.check_id!))}>
              <Download size={12} /> Установить выбранные
            </Button>
          )}
          {status?.can_restore && (
            <Button size="sm" variant="ghost" disabled={active} onClick={() => void perform(api.restoreEngineUpdates)}>
              <RotateCcw size={12} /> Вернуть предыдущую установку
            </Button>
          )}
        </div>
        <p className="text-[11px] leading-relaxed text-faint">
          При установке движок остановится, затем запустится и проверит необходимые ноды.
          Зависимости выбранных пакетов устанавливаются вместе с ними. Перед заменой сохраняется копия Python
          в data/engine-updates; потребуется несколько ГБ свободного места.
        </p>
        {status?.backup && <p className="break-all text-[11px] text-faint">Резервная копия: data/engine-updates/{status.backup}</p>}
        {(error || connectionError) && <ErrorMessage text={error || connectionError} />}
        {!!status?.log.length && (
          <details className="text-xs text-muted" open={status.phase === "error"}>
            <summary className="cursor-pointer">Лог проверки и установки</summary>
            <pre className="mt-2 max-h-60 select-text overflow-auto whitespace-pre-wrap break-all rounded-lg bg-bg p-3 font-mono text-[11px]">{status.log.join("\n")}</pre>
          </details>
        )}
      </div>
    </section>
  );
}
