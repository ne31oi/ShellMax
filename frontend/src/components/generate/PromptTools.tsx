import type { Editor } from "@tiptap/core";
import { BookMarked, FileClock, MoreHorizontal, Plus, RotateCcw } from "lucide-react";
import { useState } from "react";
import { restorePrompt } from "../../lib/actions";
import { capturePrompt, shotMarker } from "../../lib/prompt-presets";
import { referenceTargets } from "../../lib/refs";
import { useForm } from "../../store/form";
import { useUI } from "../../store/ui";
import { Button, Dialog, Menu, MenuItem, MenuLabel, MenuSeparator } from "../ui";
import { PromptLibrary } from "./PromptLibrary";
import { PromptReferenceReplace } from "./PromptReferenceReplace";

export function PromptTools({ editor, disabled }: { editor: Editor | null; disabled: boolean }) {
  const refs = useForm((s) => s.refs);
  const draft = useForm((s) => s.promptDraft);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [cutOpen, setCutOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [cut, setCut] = useState(1);
  const [busy, setBusy] = useState(false);
  const insert = (text: string) => {
    const content = text.split("\n").map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] }));
    editor?.chain().focus().insertContent(content).run();
  };
  return <>
    <Menu align="start" trigger={<Button variant="ghost" size="sm" disabled={disabled || busy} aria-label="Инструменты промпта"><MoreHorizontal size={15} /></Button>}>
      <MenuItem onSelect={() => setLibraryOpen(true)}><BookMarked size={13} /> Библиотека промптов</MenuItem>
      <MenuItem onSelect={() => {
        const f = useForm.getState();
        if (!f.prompt.trim()) return;
        const old = f.promptDraft;
        f.set({ promptDraft: capturePrompt(f) });
        useUI.getState().toast("Черновик сохранён вместе с референсами", "ok", { label: "Отменить", run: () => useForm.getState().set({ promptDraft: old }) });
      }}><FileClock size={13} /> Отложить текущий вариант</MenuItem>
      {draft && <MenuItem onSelect={async () => {
        const before = capturePrompt(useForm.getState());
        setBusy(true);
        try { await restorePrompt(draft); useForm.getState().set({ promptDraft: before }); }
        catch (e) { useUI.getState().toast(e instanceof Error ? e.message : "Не удалось открыть черновик", "bad"); }
        finally { setBusy(false); }
      }}><RotateCcw size={13} /> Вернуть черновик · обменять варианты</MenuItem>}
      {refs.length > 1 && <MenuItem onSelect={() => setReplaceOpen(true)}>Заменить ссылки на референс…</MenuItem>}
      <MenuSeparator />
      <MenuLabel>Вставить в позицию курсора</MenuLabel>
      <MenuItem onSelect={() => {
        if (!/\[Shot\s+\d+\]/i.test(useForm.getState().prompt)) insert("[Shot 1] ");
        else { setCut(Math.min(1, Math.max(0.001, useForm.getState().duration / 2))); setCutOpen(true); }
      }}><Plus size={13} /> План / склейку</MenuItem>
      <MenuItem onSelect={() => {
        const prompt = useForm.getState().prompt;
        const n = Math.max(0, ...[...prompt.matchAll(/<Subject\s+(\d+)\s*>/gi)].map((m) => Number(m[1]))) + 1;
        insert(`<Subject ${n}> `);
      }}>Субъект</MenuItem>
      <MenuItem onSelect={() => insert("(S1) says: <d>[Russian] </d>")}>Реплику на русском</MenuItem>
      <MenuItem onSelect={() => insert("(S1) says: <d>[English] </d>")}>Реплику на английском</MenuItem>
      {referenceTargets(refs).map((target) => <MenuItem key={`${target.uid}-${target.channel}`} onSelect={() => editor?.chain().focus().insertContent([
        { type: "mention", attrs: { id: target.uid, channel: target.channel ?? null } }, { type: "text", text: " " },
      ]).run()}>&lt;{target.tag}&gt; · {target.channel ? "Звук видео" : (target.ref.upload.name || target.ref.upload.orig_name)}</MenuItem>)}
    </Menu>
    <PromptLibrary open={libraryOpen} onOpenChange={setLibraryOpen} />
    <PromptReferenceReplace open={replaceOpen} onOpenChange={setReplaceOpen} />
    <Dialog open={cutOpen} onOpenChange={setCutOpen} title="Время склейки">
      <p className="mb-3 text-xs text-muted">Время от начала видео, в секундах. Вставится следующий номер плана.</p>
      <input type="number" min={0.001} step={0.001} value={cut} aria-label="Время склейки в секундах" onChange={(e) => setCut(Number(e.target.value))} className="mb-3 w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm" />
      <Button disabled={!Number.isFinite(cut) || cut <= 0 || cut >= useForm.getState().duration} onClick={() => { insert(shotMarker(useForm.getState().prompt, cut)); setCutOpen(false); }}>Вставить склейку</Button>
    </Dialog>
  </>;
}
