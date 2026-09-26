import Mention from "@tiptap/extension-mention";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { JSONContent } from "@tiptap/core";
import clsx from "clsx";
import { AlertTriangle, AudioLines, FileText, History } from "lucide-react";
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { urls } from "../../api/client";
import type { RefItem } from "../../api/types";
import { emit, on } from "../../lib/bus";
import { KIND_COLOR, REF_TOKEN, danglingTags, fromModelPrompt, tagOf, toModelPrompt } from "../../lib/refs";
import { useForm } from "../../store/form";
import { useLibrary } from "../../store/library";
import { Button, Menu, MenuItem, MenuLabel } from "../ui";

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

  const applyTemplate = () => {
    const tokens = fromModelPrompt(template, refs);
    const current = useForm.getState().prompt.trim();
    useForm.getState().setPrompt(current ? `${tokens}${current}` : tokens, true);
    emit("focusPrompt");
  };

  return (
    <div>
      <div className="prompt-editor rounded-xl border border-line bg-raised focus-within:border-accent/60">
        <EditorContent editor={editor} />
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
          <span className="ml-auto pr-1.5 text-[11px] text-faint">Ctrl+Enter — создать</span>
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
