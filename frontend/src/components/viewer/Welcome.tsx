import { CheckCircle2, CircleAlert, Loader2, Terminal } from "lucide-react";
import { defaultProfile, useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { Button, Kbd } from "../ui";

/** Empty viewer = first-run checklist until everything is ready, then a short how-to. */
export function Welcome() {
  const engine = useLibrary((s) => s.engine);
  const profiles = useLibrary((s) => s.profiles);
  const openSettings = useUI((s) => s.openSettings);
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
          <div className="mt-6 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-muted">
            <span><Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> создать</span>
            <span><Kbd>@</Kbd> сослаться на референс</span>
            <span><Kbd>Ctrl</Kbd>+<Kbd>V</Kbd> вставить картинку</span>
            <span><Kbd>↑</Kbd> прошлый промпт</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Check({ state, title, detail, action }: { state: "ok" | "bad" | "busy"; title: string; detail?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 rounded-xl border border-line bg-panel px-3.5 py-3">
      {state === "ok" ? (
        <CheckCircle2 size={18} className="mt-px shrink-0 text-ok" />
      ) : state === "busy" ? (
        <Loader2 size={18} className="mt-px shrink-0 animate-spin text-accent" />
      ) : (
        <CircleAlert size={18} className="mt-px shrink-0 text-warn" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-[13px]">{title}</p>
        {detail && <div className="mt-0.5 text-xs text-muted">{detail}</div>}
      </div>
      {action}
    </li>
  );
}
