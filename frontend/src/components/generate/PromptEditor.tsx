import Mention from "@tiptap/extension-mention";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { JSONContent } from "@tiptap/core";
import clsx from "clsx";
import { AlertTriangle, AudioLines, FileText, History, Sparkles, Square } from "lucide-react";
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { urls } from "../../api/client";
import type { RefItem } from "../../api/types";
import { emit, on } from "../../lib/bus";
import { KIND_COLOR, REF_TOKEN, danglingTags, fromModelPrompt, tagOf, toModelPrompt } from "../../lib/refs";
import { frameCount } from "../../lib/format";
import { useAssistant } from "../../store/assistant";
import { EditPromptButton } from "../assistant/EditPromptButton";
import { useForm } from "../../store/form";
import { useUI } from "../../store/ui";
import { useLibrary } from "../../store/library";
import { Button, Menu, MenuItem, MenuLabel, Spinner, Tip } from "../ui";

/** Live assistant text without the ```text fence lines. */
export function stripFence(text: string): string {
  return text.replace(/^[^`]*```[a-z]*\n?/i, "").replace(/```[\s\S]*$/, "");
}

// ---------------------------------------------------------------- token string <-> editor doc
function toDoc(prompt: string): JSONContent {
  const paragraphs = prompt.split("\n").map((line): JSONContent => {
    const content: JSONContent[] = [];
    let last = 0;
    for (const m of line.matchAll(REF_TOKEN)) {
      if (m.index! > last) content.push({ type: "text", text: line.slice(last, m.index) });
      content.push({ type: "mention", attrs: { id: m[1] } });
      last = m.index! + m[0].length;
    }
    if (last < line.length) content.push({ type: "text", text: line.slice(last) });
    return content.length ? { type: "paragraph", content } : { type: "paragraph" };
  });
  return { type: "doc", content: paragraphs };
}

function fromDoc(doc: JSONContent): string {
  return (doc.content ?? [])
    .map((p) =>
      (p.content ?? [])
        .map((n) => (n.type === "mention" ? `{{ref:${n.attrs?.id}}}` : n.type === "hardBreak" ? "\n" : (n.text ?? "")))
        .join(""),
    )
    .join("\n");
}

// ---------------------------------------------------------------- mention chip (live: renumbers on reorder)
function MentionChip({ node }: NodeViewProps) {
  const refs = useForm((s) => s.refs);
  const uid = node.attrs.id as string;
  const ref = refs.find((r) => r.uid === uid);
  const tag = tagOf(refs, uid);
  return (
    <NodeViewWrapper
      as="span"
      className={clsx("ref-mention", !ref && "is-missing")}
      style={ref ? ({ "--mention-color": KIND_COLOR[ref.upload.kind] } as React.CSSProperties) : undefined}
      contentEditable={false}
    >
      {ref && ref.upload.kind !== "audio" && <img src={urls.uploadThumb(ref.upload.id)} alt="" />}
      {ref?.upload.kind === "audio" && <AudioLines size={12} />}
      {tag ?? "удалён"}
    </NodeViewWrapper>
  );
}

// ---------------------------------------------------------------- "@" suggestion popup state
interface SuggestState {
  open: boolean;
  items: RefItem[];
  index: number;
  rect: DOMRect | null;
  pick: ((uid: string) => void) | null;
}
const useSuggest = create<SuggestState>(() => ({ open: false, items: [], index: 0, rect: null, pick: null }));

const RefMention = Mention.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MentionChip);
  },
}).configure({
  suggestion: {
    char: "@",
    items: ({ query }) => {
      const refs = useForm.getState().refs;
      const q = query.toLowerCase();
      return refs.filter((r) => !q || tagOf(refs, r.uid)!.toLowerCase().includes(q) || r.upload.orig_name.toLowerCase().includes(q));
    },
    command: ({ editor, range, props }) => {
      editor.chain().focus().insertContentAt(range, [{ type: "mention", attrs: { id: props.id } }, { type: "text", text: " " }]).run();
    },
    render: () => ({
      onStart: (p) =>
        useSuggest.setState({
          open: true,
          items: p.items as RefItem[],
          index: 0,
          rect: p.clientRect?.() ?? null,
          pick: (uid) => p.command({ id: uid }),
        }),
      onUpdate: (p) =>
        useSuggest.setState({
          items: p.items as RefItem[],
          rect: p.clientRect?.() ?? null,
          pick: (uid) => p.command({ id: uid }),
          index: 0,
        }),
      onKeyDown: ({ event }) => {
        const s = useSuggest.getState();
        if (!s.open || !s.items.length) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const d = event.key === "ArrowDown" ? 1 : -1;
          useSuggest.setState({ index: (s.index + d + s.items.length) % s.items.length });
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          s.pick?.(s.items[s.index].uid);
          return true;
        }
        if (event.key === "Escape") {
          useSuggest.setState({ open: false });
          return true;
        }
        return false;
      },
      onExit: () => useSuggest.setState({ open: false }),
    }),
  },
});

function SuggestPopup({ focused }: { focused: boolean }) {
  const { open, items, index, rect, pick } = useSuggest();
  const refs = useForm((s) => s.refs);
  if (!open || !rect || !focused) return null;
  return (
    <div
      className="fixed z-50 w-60 rounded-xl border border-line bg-panel p-1 shadow-2xl"
      style={{ left: Math.min(rect.left, window.innerWidth - 256), top: rect.bottom + 6 }}
    >
      {items.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-muted">Нет референсов — перетащите файлы в зону выше</p>
      ) : (
        items.map((r, i) => (
          <button
            key={r.uid}
            onMouseDown={(e) => {
              e.preventDefault();
              pick?.(r.uid);
            }}
            className={clsx("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left", i === index ? "bg-hover" : "hover:bg-hover")}
          >
            {r.upload.kind === "audio" ? (
              <AudioLines size={16} className="text-audio" />
            ) : (
              <img src={urls.uploadThumb(r.upload.id)} alt="" className="h-7 w-7 rounded object-cover" />
            )}
            <span className="text-[13px] font-semibold" style={{ color: KIND_COLOR[r.upload.kind] }}>
              {tagOf(refs, r.uid)}
            </span>
            <span className="truncate text-xs text-muted">{r.upload.orig_name}</span>
          </button>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------- editor
export function PromptEditor() {
  const revision = useForm((s) => s.promptRevision);
  const refs = useForm((s) => s.refs);
  const prompt = useForm((s) => s.prompt);
  const history = useForm((s) => s.promptHistory);
  const template = useLibrary((s) => s.meta?.defaults.prompt_template ?? "");
  const historyCursor = useRef(-1);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false, bulletList: false, orderedList: false, listItem: false, blockquote: false,
        codeBlock: false, code: false, horizontalRule: false, bold: false, italic: false, strike: false,
        link: false, underline: false,
      }),
      Placeholder.configure({ placeholder: "Опишите сцену. Нажмите @, чтобы сослаться на референс…" }),
      RefMention,
    ],
    content: toDoc(useForm.getState().prompt),
    onUpdate: ({ editor }) => {
      historyCursor.current = -1;
      useForm.getState().setPrompt(fromDoc(editor.getJSON()));
    },
    editorProps: {
      handleKeyDown: (view, event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          emit("generate");
          return true;
        }
        // ↑ in an empty prompt walks back through recent prompts
        const { promptHistory } = useForm.getState();
        const empty = view.state.doc.textContent.length === 0 && view.state.doc.childCount <= 1;
        if (event.key === "ArrowUp" && (empty || historyCursor.current >= 0) && promptHistory.length) {
          historyCursor.current = Math.min(historyCursor.current + 1, promptHistory.length - 1);
          const text = promptHistory[historyCursor.current];
          editorRef.current?.commands.setContent(toDoc(text), { emitUpdate: false });
          useForm.getState().setPrompt(text);
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const text = event.clipboardData?.getData("text/plain");
        if (!text || event.clipboardData?.files.length) return false;
        // pasted <Picture N> tags become live chips when such a reference exists
        const tokens = fromModelPrompt(text, useForm.getState().refs);
        if (tokens === text) return false;
        editorRef.current?.chain().focus().insertContent(toDoc(tokens).content ?? []).run();
        return true;
      },
    },
  });
  const editorRef = useRef(editor);
  editorRef.current = editor;

  // external replacements (retry, template, history, ref removal)
  useEffect(() => {
    if (!editor) return;
    const current = fromDoc(editor.getJSON());
    const next = useForm.getState().prompt;
    if (current !== next) editor.commands.setContent(toDoc(next), { emitUpdate: false });
  }, [revision, editor]);

  useEffect(
    () =>
      on("insertMention", (uid) => {
        editor?.chain().focus().insertContent([{ type: "mention", attrs: { id: uid } }, { type: "text", text: " " }]).run();
      }),
    [editor],
  );
  useEffect(() => on("focusPrompt", () => editor?.commands.focus("end")), [editor]);

  // chips are tokens, so any raw <Picture N> left in the text was typed by hand
  const dangling = danglingTags(prompt, refs);

  const job = useAssistant((s) => s.job);
  const composing = job?.target === "compose" || job?.target === "edit";
  // a finished, structured prompt is fixed in plain words; a free description is converted
  const structured = /subject_definitions\s*:/i.test(prompt);
  const videoBusy = useLibrary((s) => Object.values(s.generations).some((g) => g.status === "running" || g.status === "queued"));
  const liveBox = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (liveBox.current) liveBox.current.scrollTop = liveBox.current.scrollHeight;
  }, [job?.text]);

  // plain words + reference tags -> a prompt written by the local assistant to the user's specification
  const convert = async () => {
    const f = useForm.getState();
    const text = toModelPrompt(f.prompt, f.refs).trim();
    if (!text) {
      useUI.getState().toast("Опишите обычными словами, что должно происходить в видео", "info");
      emit("focusPrompt");
      return;
    }
    const before = f.prompt;
    const result = await useAssistant.getState().run("compose", "/api/assistant/compose", {
      text,
      refs: f.refs.map((r) => ({ upload_id: r.upload.id, with_audio: r.withAudio })),
      duration: frameCount(f.duration) / 24,
      look: f.look,
    });
    if (!result) return;
    useForm.getState().setPrompt(fromModelPrompt(result, useForm.getState().refs), true);
    useUI.getState().toast("Промпт готов", "ok", { label: "Вернуть как было", run: () => useForm.getState().setPrompt(before, true) });
  };

  // "make it night, add rain" -> the assistant changes only that, keeping the rest and the reference tags
  const editWithAssistant = async (instruction: string) => {
    const f = useForm.getState();
    const before = f.prompt;
    const result = await useAssistant.getState().run("edit", "/api/assistant/edit", {
      prompt: toModelPrompt(f.prompt, f.refs),
      instruction,
      refs: f.refs.map((r) => ({ upload_id: r.upload.id, with_audio: r.withAudio })),
      duration: frameCount(f.duration) / 24,
      look: f.look,
    });
    if (!result) return;
    useForm.getState().setPrompt(fromModelPrompt(result, useForm.getState().refs), true);
    useUI.getState().toast("Промпт исправлен", "ok", { label: "Вернуть как было", run: () => useForm.getState().setPrompt(before, true) });
  };

  const applyTemplate = () => {
    const tokens = fromModelPrompt(template, refs);
    const current = useForm.getState().prompt.trim();
    useForm.getState().setPrompt(current ? `${tokens}${current}` : tokens, true);
    emit("focusPrompt");
  };

  return (
    <div>
      <div className="prompt-editor relative rounded-xl border border-line bg-raised focus-within:border-accent/60">
        <EditorContent editor={editor} />
        {composing && (
          // the assistant's text appears live on top of the editor; it replaces the prompt when done
          <div className="absolute inset-x-0 top-0 bottom-[37px] flex flex-col rounded-t-xl bg-raised">
            <div className="flex items-center gap-2 px-3 pt-2.5 text-xs text-accent">
              <Spinner size={12} />
              {job.stage === "loading"
                ? "Загружаю ассистента… первый раз это может занять минуту"
                : job.target === "edit" ? "Вношу правки…" : "Пишу промпт по спецификации…"}
            </div>
            <pre ref={liveBox} className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-relaxed text-muted">
              {stripFence(job.text)}
            </pre>
          </div>
        )}
        <div className="flex items-center gap-1 border-t border-line/60 px-1.5 py-1">
          <Button variant="ghost" size="sm" onClick={applyTemplate} title="Вставить каркас описания субъекта из воркфлоу">
            <FileText size={13} /> Шаблон
          </Button>
          <Menu
            align="start"
            trigger={
              <Button variant="ghost" size="sm" disabled={!history.length}>
                <History size={13} /> История
              </Button>
            }
          >
            <MenuLabel>Недавние промпты · ↑ в пустом поле</MenuLabel>
            {history.slice(0, 12).map((h, i) => (
              <MenuItem key={i} onSelect={() => useForm.getState().setPrompt(h, true)}>
                <span className="line-clamp-2 max-w-80 text-xs">{toModelPrompt(h, refs).slice(0, 160)}</span>
              </MenuItem>
            ))}
          </Menu>
          <span className="ml-auto" />
          {composing ? (
            <Button variant="outline" size="sm" onClick={() => useAssistant.getState().stop()}>
              <Square size={11} /> Стоп
            </Button>
          ) : structured ? (
            <EditPromptButton
              onSubmit={editWithAssistant}
              disabled={videoBusy || !!job}
              hint={videoBusy ? "Ассистент будет доступен, когда закончится генерация видео" : "Ассистент занят"}
            />
          ) : (
            <Tip text={videoBusy ? "Ассистент будет доступен, когда закончится генерация видео" : "Ассистент перепишет ваше описание в промпт по спецификации. Теги референсов сохранятся"}>
              <span>
                <Button variant="ghost" size="sm" onClick={convert} disabled={videoBusy || !!job} className="text-accent hover:text-accent-strong">
                  <Sparkles size={13} /> В промпт
                </Button>
              </span>
            </Tip>
          )}
        </div>
      </div>
      {dangling.length > 0 && (
        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-warn">
          <AlertTriangle size={12} /> Нет референса для {dangling.join(", ")}
        </p>
      )}
      <SuggestPopup focused={!!editor?.isFocused} />
    </div>
  );
}
