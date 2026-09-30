import { useState } from "react";
import { replacePromptReferences, tagOf } from "../../lib/refs";
import { useForm } from "../../store/form";
import { useUI } from "../../store/ui";
import { Button, Dialog, Select } from "../ui";

export function PromptReferenceReplace({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const refs = useForm((s) => s.refs);
  const prompt = useForm((s) => s.prompt);
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState("replace");
  const from = refs.some((r) => r.uid === source) ? source : (refs[0]?.uid ?? "");
  const sourceRef = refs.find((r) => r.uid === from);
  const candidates = refs.filter((r) => r.uid !== from && r.upload.kind === sourceRef?.upload.kind
    && (!prompt.includes(`{{ref:${from}:audio}}`) || r.withAudio));
  const to = candidates.some((r) => r.uid === target) ? target : (candidates[0]?.uid ?? "");
  const preview = replacePromptReferences(prompt, refs, from, to, mode === "swap");
  const label = (uid: string) => {
    const r = refs.find((ref) => ref.uid === uid);
    return `${tagOf(refs, uid)} · ${r?.upload.name || r?.upload.orig_name}`;
  };
  return <Dialog open={open} onOpenChange={onOpenChange} title="Заменить ссылки на референс">
    <div className="space-y-3">
      <p className="text-xs text-muted">Меняются ссылки во всём промпте. Файлы и порядок карточек сохраняются.</p>
      <Select label="Какие ссылки" value={from} onChange={setSource} options={refs.map((r) => ({ value: r.uid, label: label(r.uid) }))} />
      {candidates.length ? <Select label="На какой референс" value={to} onChange={setTarget} options={candidates.map((r) => ({ value: r.uid, label: label(r.uid) }))} />
        : <p className="text-xs text-warn">Добавьте другой референс того же типа. Для замены звука видео включите 🔊 на его карточке.</p>}
      <Select label="Действие" value={mode} onChange={setMode} options={[{ value: "replace", label: "Заменить ссылки" }, { value: "swap", label: "Обменять ссылки местами" }]} />
      <p className="text-xs text-muted">Будет изменено ссылок: {preview.count}</p>
      <Button disabled={!preview.count || !candidates.length} onClick={() => {
        const before = useForm.getState().prompt;
        const result = replacePromptReferences(before, useForm.getState().refs, from, to, mode === "swap");
        useForm.getState().setPrompt(result.prompt, true);
        onOpenChange(false);
        useUI.getState().toast(`Ссылок изменено: ${result.count}`, "ok", { label: "Вернуть как было", run: () => useForm.getState().setPrompt(before, true) });
      }}>Применить</Button>
    </div>
  </Dialog>;
}
