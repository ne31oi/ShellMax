import { AlertTriangle, Check, ChevronDown } from "lucide-react";
import { useMemo } from "react";
import { checkPrompt } from "../../lib/prompt-checks";
import { frameCount } from "../../lib/format";
import { useForm } from "../../store/form";
import { Popover } from "../ui";

export function PromptChecks({ hidden = false }: { hidden?: boolean }) {
  const prompt = useForm((s) => s.prompt);
  const refs = useForm((s) => s.refs);
  const duration = useForm((s) => s.duration);
  const issues = useMemo(() => checkPrompt(prompt, refs, frameCount(duration) / 24), [prompt, refs, duration]);
  if (hidden || !prompt.trim()) return null;
  const structured = /^(subject_definitions|summary|detailed_description)\s*:/im.test(prompt);
  if (!issues.length && !structured) return null;
  if (!issues.length) return <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted"><Check size={12} className="text-ok" /> Структура и ссылки проверены</p>;
  const errors = issues.filter((i) => i.level === "error").length;
  return (
    <Popover side="bottom" trigger={
      <button className={`mt-1.5 flex max-w-full items-center gap-1.5 text-left text-xs ${errors ? "text-bad" : "text-warn"}`} aria-label="Проверка промпта">
        <AlertTriangle size={12} className="shrink-0" />
        <span className="truncate">{errors ? `Исправить ошибок: ${errors}` : `Замечаний: ${issues.length}`}</span>
        <ChevronDown size={12} />
      </button>
    } className="w-80 max-w-[calc(100vw-24px)]">
      <p className="mb-2 text-sm font-semibold">Проверка промпта</p>
      <div className="max-h-72 space-y-2 overflow-y-auto" aria-live="polite">
        {issues.map((issue, i) => <p key={`${issue.code}-${i}`} className={`text-xs leading-relaxed ${issue.level === "error" ? "text-bad" : "text-warn"}`}>{issue.message}</p>)}
      </div>
      <p className="mt-3 text-[11px] text-faint">Проверяем формат и связи. Постановку и качество будущего видео эта проверка не оценивает.</p>
    </Popover>
  );
}
