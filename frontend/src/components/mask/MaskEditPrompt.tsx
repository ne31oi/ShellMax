import { useEffect, useRef, useState } from "react";
import { PencilLine, Sparkles, Square } from "lucide-react";
import type { MaskEditParams, RefItem } from "../../api/types";
import { fromModelPrompt, toModelPrompt } from "../../lib/refs";
import { useAssistant } from "../../store/assistant";
import { useLibrary } from "../../store/library";
import { Button, ErrorMessage, Spinner } from "../ui";

export function MaskEditPrompt({ draft, refs, frames, disabled, onChange, onBusy, sourcePrompt }: {
  draft: MaskEditParams; refs: RefItem[]; frames: number; disabled: boolean;
  onChange: (prompt: string) => void; onBusy: (busy: boolean) => void; sourcePrompt: string;
}) {
  const job = useAssistant((s) => s.job);
  const videoBusy = useLibrary((s) => Object.values(s.generations).some((g) => g.status === "running" || g.status === "queued"));
  const [running, setRunning] = useState(false);
  const [editing, setEditing] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState("");
  const [before, setBefore] = useState<string | null>(null);
  const mounted = useRef(true);
  const ownsJob = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (ownsJob.current && useAssistant.getState().job?.target === "mask") useAssistant.getState().stop();
    };
  }, []);
  const structured = /subject_definitions\s*:/i.test(draft.prompt);
  const unavailable = disabled || videoBusy || !!job || running || frames < 5;
  const hint = videoBusy ? "Ассистент будет доступен после обработки видео" : frames < 5 ? "Выберите фрагмент длиной хотя бы 5 кадров" : undefined;
  const write = async (edit: boolean) => {
    if (unavailable) return;
    const text = edit ? instruction.trim() : toModelPrompt(draft.prompt, refs).trim();
    if (!text) { setError(edit ? "Напишите, что исправить в промпте" : "Опишите обычными словами, что заменить в выбранной области"); return; }
    const original = draft.prompt;
    setError("");
    setRunning(true);
    onBusy(true);
    ownsJob.current = true;
    try {
      const result = await useAssistant.getState().run("mask", "/api/assistant/mask-prompt", {
        source_asset_id: draft.source_asset_id, text,
        prompt: edit ? toModelPrompt(draft.prompt, refs) : "",
        refs: refs.map((r) => ({ upload_id: r.upload.id, with_audio: false })),
        start: draft.start, end: draft.start + frames / 24,
        keep_audio: draft.keep_audio, invert: draft.invert, target_hint: draft.sam_selection?.text ?? "",
      });
      if (!mounted.current) return;
      if (!result) { setError(useAssistant.getState().lastError ?? ""); return; }
      setBefore(original);
      onChange(fromModelPrompt(result, refs));
      setEditing(false);
      setInstruction("");
    } finally {
      ownsJob.current = false;
      if (mounted.current) { setRunning(false); onBusy(false); }
    }
  };
  return <div className="space-y-2">
    <p className="text-xs text-muted">Опишите замену по-русски — ассистент составит промпт по рефам и кадрам исходника.</p>
    <textarea aria-label="Промпт редактирования маски" disabled={disabled || running}
      value={toModelPrompt(draft.prompt, refs)} onChange={(e) => onChange(fromModelPrompt(e.target.value, refs))} rows={5}
      className="w-full resize-y rounded-lg border border-line bg-raised p-3 text-sm"
      placeholder="Например: замени человека внутри маски на человека с <Picture 1>, сохрани исходные движения и свет." />
    <div className="flex flex-wrap items-center gap-2">
      {sourcePrompt && <Button size="sm" disabled={disabled || running} onClick={() => onChange(sourcePrompt)}>Взять промпт исходного клипа</Button>}
      {before !== null && <Button size="sm" disabled={disabled || running} onClick={() => { onChange(before); setBefore(null); }}>Вернуть как было</Button>}
      {running ? <>
        <Spinner size={14} /><span className="text-xs text-accent">{job?.stage === "loading" ? "Подготавливаю ассистента…" : job?.stage === "repairing" ? "Проверяю промпт…" : "Пишу промпт для маски…"}</span>
        <Button size="sm" onClick={() => useAssistant.getState().stop()}><Square size={12} /> Стоп</Button>
      </> : structured ? <Button size="sm" disabled={unavailable} title={hint} onClick={() => setEditing(!editing)}><PencilLine size={13} /> Поправить</Button> :
        <Button size="sm" disabled={unavailable} title={hint} onClick={() => { void write(false); }}><Sparkles size={13} /> В промпт</Button>}
    </div>
    {editing && structured && !running && <div className="space-y-2 rounded-lg border border-line p-3">
      <textarea aria-label="Что исправить в промпте маски" disabled={unavailable} value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={2}
        className="w-full resize-y rounded-lg border border-line bg-raised p-2 text-sm" placeholder="Например: одежду тоже возьми с референса, движение оставь исходным." />
      <Button size="sm" disabled={unavailable || !instruction.trim()} onClick={() => { void write(true); }}><PencilLine size={13} /> Применить правку</Button>
    </div>}
    {hint && <p className="text-xs text-faint">{hint}</p>}
    {error && <ErrorMessage text={error} />}
  </div>;
}
