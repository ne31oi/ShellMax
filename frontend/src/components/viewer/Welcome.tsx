import { CheckCircle2, CircleAlert, Loader2, Terminal } from "lucide-react";
import { defaultProfile, useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { Button, Kbd } from "../ui";

/** Empty viewer = first-run checklist until everything is ready, then a short how-to. */
export function Welcome() {
  const engine = useLibrary((s) => s.engine);
  const profiles = useLibrary((s) => s.profiles);
  const openSettings = useUI((s) => s.openSettings);
  const setWorkspace = useUI((s) => s.setWorkspace);
  const profile = defaultProfile(profiles);
  const problems = profile?.problems ?? [];

  const engineOk = engine?.state === "ready" || engine?.state === "external";
  const engineBusy = engine?.state === "starting";
  const allReady = engineOk && problems.length === 0;

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-md">
        <h1 className="text-lg font-semibold">{allReady ? "Всё готово" : "Подготовка"}</h1>
        <p className="mb-5 mt-1 text-[13px] text-muted">
          {allReady
            ? "Добавьте референсы, опишите сцену справа и нажмите «Создать»."
            : "ShellMax проверяет движок и модели. Обычно ничего настраивать не нужно."}
        </p>

        <ul className="space-y-2.5">
          <Check
            state={engineOk ? "ok" : engineBusy ? "busy" : "bad"}
            title={
              engineOk ? "Движок запущен" : engineBusy ? "Движок запускается…" : engine?.state === "not_installed" ? "Движок не установлен" : "Движок остановлен"
            }
            detail={
              engine?.state === "not_installed" ? (
                <span>
                  Выполните в PowerShell: <code className="font-mono text-fg">scripts\install_comfy.ps1</code>
                </span>
              ) : engine?.state === "error" ? (
                <span className="line-clamp-3">{engine.detail}</span>
              ) : engineBusy ? (
                "Первый запуск занимает до пары минут"
              ) : undefined
            }
            action={
              !engineOk && !engineBusy && engine?.state !== "not_installed" ? (
                <Button size="sm" onClick={() => openSettings("system")}>
                  <Terminal size={13} /> Подробнее
                </Button>
              ) : undefined
            }
          />
          <Check
            state={problems.length === 0 ? "ok" : "bad"}
            title={problems.length === 0 ? `Модели найдены · профиль «${profile?.name ?? "—"}»` : `Не найдено файлов: ${problems.length}`}
            detail={problems.length ? problems.map((p) => p.path.split(/[\\/]/).pop()).join(", ") : undefined}
            action={
              problems.length ? (
                <Button size="sm" onClick={() => openSettings("engine")}>
                  Указать пути
                </Button>
              ) : undefined
            }
          />
        </ul>

        {allReady && (
          <>
            <ol className="mt-6 space-y-1.5 text-xs text-muted">
              <li>
                <span className="mr-1.5 tabular-nums text-faint">1.</span>
                Сгенерируйте короткий клип (2 с, «Стандарт»)
              </li>
              <li>
                <span className="mr-1.5 tabular-nums text-faint">2.</span>
                При необходимости — «Улучшить лицо» или детализация с карточки
              </li>
              <li>
                <span className="mr-1.5 tabular-nums text-faint">3.</span>
                Добавьте клип в таймлайн и экспортируйте ролик
              </li>
            </ol>
            <div className="mt-4">
              <Button size="sm" onClick={() => setWorkspace("edit")}>
                Открыть монтаж
              </Button>
            </div>
            <div className="mt-6 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-muted">
              <span>
                <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> создать
              </span>
              <span>
                <Kbd>@</Kbd> сослаться на референс
              </span>
              <span>
                <Kbd>Ctrl</Kbd>+<Kbd>V</Kbd> вставить картинку
              </span>
              <span>
                <Kbd>↑</Kbd> прошлый промпт
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Check({ state, title, detail, action }: { state: "ok" | "bad" | "busy"; title: string; detail?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 rounded-xl border border-line bg-raised/40 px-3 py-2.5">
      <span className="mt-0.5 shrink-0">
        {state === "ok" ? (
          <CheckCircle2 size={16} className="text-ok" />
        ) : state === "busy" ? (
          <Loader2 size={16} className="animate-spin text-accent" />
        ) : (
          <CircleAlert size={16} className="text-bad" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-fg">{title}</p>
        {detail && <p className="mt-0.5 text-xs text-muted">{detail}</p>}
        {action && <div className="mt-2">{action}</div>}
      </div>
    </li>
  );
}
