import { useState } from "react";
import { api } from "../../api/client";
import { useAssistant } from "../../store/assistant";
import { Button, ErrorMessage, Spinner } from "../ui";

/** Connection information is shared by settings and the first-use dialog. */
export function CodexConnection() {
  const status = useAssistant((s) => s.status);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const current = status?.provider === "codex" ? status : null;

  const check = async () => {
    setChecking(true);
    setError("");
    try {
      useAssistant.setState({ status: await api.assistantStatus(true) });
    } catch {
      setError("Не удалось проверить подключение. Повторите попытку.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-line p-4">
      <p className="text-[13px] leading-relaxed text-muted">
        Codex пишет и правит промпты с учётом спецификации H3, режиссёрских правил, текущих референсов,
        камеры и света. Используется ваш вход в Codex; локальную модель скачивать не нужно.
      </p>
      <p className="text-xs leading-relaxed text-faint">
        Нужен интернет. Текст запроса и прикреплённые изображения передаются в Codex.
        Модель выбирается из доступных в настройках ассистента.
      </p>
      {current?.ready && <p className="text-xs text-ok">Подключено · {current.label}</p>}
      {current?.notice && <p className="text-xs leading-relaxed text-muted">{current.notice}</p>}
      {(error || current?.error) && <ErrorMessage text={error || current!.error!} />}
      <Button size="sm" disabled={checking} onClick={() => void check()}>
        {checking && <Spinner size={12} />} {checking ? "Проверяю…" : "Проверить подключение"}
      </Button>
    </div>
  );
}
