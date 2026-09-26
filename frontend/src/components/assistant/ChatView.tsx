import clsx from "clsx";
import { ArrowUp, Check, Copy, ImagePlus, Lightbulb, MessageSquarePlus, Square, Trash2, Wand2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, urls } from "../../api/client";
import type { ChatAttachment, ChatMessage } from "../../api/types";
import { fromModelPrompt } from "../../lib/refs";
import { useAssistant } from "../../store/assistant";
import { useChats } from "../../store/chats";
import { useForm } from "../../store/form";
import { useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { Button, Spinner, Tip } from "../ui";
import { Markdown } from "./Markdown";

const SUGGESTIONS = [
  "Придумай 5 идей для короткого клипа с моим персонажем",
  "Идеи для рекламы кофе на 10 секунд",
  "Атмосферная сцена в жанре нуар под дождём — варианты",
  "Смешной диалог двух персонажей в кафе — идеи",
];

/** Ideas assistant: several chats, image attachments, "В промпт" under a finished prompt (Minimax Studio V6). */
export function ChatView() {
  const { list, active, loaded, load, open, create, remove } = useChats();
  const job = useAssistant((s) => s.job);
  const chatting = job?.target === "chat";
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel">
        <div className="p-2">
          <Button variant="outline" className="w-full justify-center" onClick={() => void create()} disabled={chatting}>
            <MessageSquarePlus size={14} /> Новый чат
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {list.map((c) => (
            <div
              key={c.id}
              className={clsx(
                "group flex items-center gap-1 rounded-lg px-2.5 py-2 text-[13px]",
                active?.id === c.id ? "bg-hover text-fg" : "text-muted hover:bg-hover/60 hover:text-fg",
              )}
            >
              <button className="min-w-0 flex-1 truncate text-left" onClick={() => void open(c.id)} disabled={chatting}>
                {c.title}
              </button>
              {confirmDelete === c.id ? (
                <button className="shrink-0 text-[11px] text-bad" onClick={() => { setConfirmDelete(null); void remove(c.id); }}>
                  Удалить?
                </button>
              ) : (
                <button
                  onClick={() => setConfirmDelete(c.id)}
                  onBlur={() => setConfirmDelete(null)}
                  aria-label="Удалить чат"
                  className="hidden shrink-0 text-faint hover:text-bad group-hover:block"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      </aside>
      <Conversation />
    </div>
  );
}

function Conversation() {
  const active = useChats((s) => s.active);
  const send = useChats((s) => s.send);
  const job = useAssistant((s) => s.job);
  const chatting = job?.target === "chat";
  const scroller = useRef<HTMLDivElement>(null);
  const messages = active?.messages ?? [];

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, job?.text]);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-bg">
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-5 px-6 py-6">
          {messages.length === 0 && !chatting && (
            <div className="pt-16 text-center">
              <Lightbulb size={28} className="mx-auto text-accent" />
              <p className="mt-3 text-[15px] font-medium">Придумаем сцену</p>
              <p className="mt-1 text-xs text-muted">
                Спросите идеи, выберите понравившуюся и попросите промпт — кнопка «В промпт» отправит его в генерацию.
              </p>
              <div className="mx-auto mt-5 flex max-w-xl flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => void send(s, null)} className="rounded-full border border-line px-3 py-1.5 text-xs text-muted hover:border-accent/60 hover:text-fg">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => <Message key={i} m={m} />)}
          {chatting && (
            <Message
              m={{ role: "assistant", content: job.text }}
              live
              status={job.stage === "loading" ? "Загружаю ассистента… первый раз это может занять минуту" : job.text ? undefined : "Думаю…"}
            />
          )}
        </div>
      </div>
      <Composer />
    </div>
  );
}

/** Reply split into prose and fenced prompts (the fence may still be open while streaming). */
function segments(text: string): { kind: "text" | "prompt"; body: string; closed: boolean }[] {
  const out: { kind: "text" | "prompt"; body: string; closed: boolean }[] = [];
  const re = /```[a-zA-Z]*\n?([\s\S]*?)(```|$)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ kind: "text", body: text.slice(last, m.index), closed: true });
    out.push({ kind: "prompt", body: m[1].trim(), closed: m[2] === "```" });
    last = m.index! + m[0].length;
    if (!m[0]) break;
  }
  if (last < text.length) out.push({ kind: "text", body: text.slice(last), closed: true });
  return out.filter((s) => s.body.trim());
}

function Message({ m, live, status }: { m: ChatMessage; live?: boolean; status?: string }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] space-y-2 rounded-2xl rounded-br-md bg-accent/15 px-4 py-2.5 text-[13px] leading-relaxed">
          {m.attachment && (
            <img src={urls.chatAttachment(m.attachment.id)} alt={m.attachment.name} className="max-h-48 rounded-lg" />
          )}
          {m.content && <p className="whitespace-pre-wrap">{m.content}</p>}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3 text-[13px] leading-relaxed text-fg">
      {status && (
        <p className="flex items-center gap-2 text-xs text-accent"><Spinner size={12} /> {status}</p>
      )}
      {segments(m.content).map((s, i) =>
        s.kind === "text" ? <Markdown key={i} text={s.body} /> : <PromptCard key={i} prompt={s.body} ready={s.closed && !live} />,
      )}
    </div>
  );
}

function PromptCard({ prompt, ready }: { prompt: string; ready: boolean }) {
  const [copied, setCopied] = useState(false);
  const insert = () => {
    const f = useForm.getState();
    const before = f.prompt;
    f.setPrompt(fromModelPrompt(prompt, f.refs), true);
    useUI.getState().setWorkspace("generate");
    useUI.getState().toast("Промпт вставлен в редактор", "ok", { label: "Вернуть как было", run: () => useForm.getState().setPrompt(before, true) });
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      useUI.getState().toast("Не удалось скопировать", "bad");
    }
  };
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap px-4 py-3 font-mono text-[11px] leading-relaxed text-muted">{prompt}</pre>
      {ready && (
        <div className="flex items-center justify-end gap-1 border-t border-line px-2 py-1.5">
          <Button size="sm" variant="ghost" onClick={copy}>
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Скопировано" : "Копировать"}
          </Button>
          <Button size="sm" variant="primary" onClick={insert}>
            <Wand2 size={13} /> В промпт
          </Button>
        </div>
      )}
    </div>
  );
}

function Composer() {
  const send = useChats((s) => s.send);
  const job = useAssistant((s) => s.job);
  const chatting = job?.target === "chat";
  const videoBusy = useLibrary((s) => Object.values(s.generations).some((g) => g.status === "running" || g.status === "queued"));
  const [text, setText] = useState("");
  const [attachment, setAttachment] = useState<ChatAttachment | null>(null);
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 188)}px`;
  }, [text]);

  const attach = async (f: File | undefined) => {
    if (!f || !f.type.startsWith("image/")) return;
    setUploading(true);
    try {
      setAttachment(await api.uploadChatAttachment(f));
    } catch {
      useUI.getState().toast("Не удалось прикрепить картинку", "bad");
    } finally {
      setUploading(false);
    }
  };

  const blocked = videoBusy || !!job || uploading;
  const submit = () => {
    if (blocked || (!text.trim() && !attachment)) return;
    const [t, a] = [text.trim(), attachment];
    setText("");
    setAttachment(null);
    void send(t, a);
  };

  return (
    <div className="border-t border-line bg-panel px-6 py-3">
      <div className="mx-auto max-w-3xl">
        {attachment && (
          <div className="mb-2 flex items-center gap-2">
            <div className="relative">
              <img src={urls.chatAttachment(attachment.id)} alt="" className="h-14 rounded-lg ring-1 ring-line" />
              <button onClick={() => setAttachment(null)} aria-label="Убрать вложение" className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-line bg-panel text-muted hover:text-fg">
                <X size={11} />
              </button>
            </div>
            <span className="text-[11px] text-faint">Только для обсуждения — в генерацию не попадёт</span>
          </div>
        )}
        <div
          className="flex items-end gap-2 rounded-xl border border-line bg-raised px-2 py-1.5 focus-within:border-accent/60"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); void attach(e.dataTransfer.files[0]); }}
        >
          <Tip text="Прикрепить картинку для обсуждения">
            <button onClick={() => file.current?.click()} className="mb-1 rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label="Прикрепить картинку">
              {uploading ? <Spinner size={15} /> : <ImagePlus size={16} />}
            </button>
          </Tip>
          <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { void attach(e.target.files?.[0]); e.target.value = ""; }} />
          <textarea
            ref={area}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const img = [...e.clipboardData.files].find((f) => f.type.startsWith("image/"));
              if (img) { e.preventDefault(); void attach(img); }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="Опишите идею сцены или попросите варианты… (Enter — отправить, Shift+Enter — новая строка)"
            className="max-h-[188px] min-h-[36px] flex-1 resize-none bg-transparent py-2 text-[13px] outline-none placeholder:text-faint"
          />
          {chatting ? (
            <button onClick={() => useAssistant.getState().stop()} className="mb-1 flex h-8 w-8 items-center justify-center rounded-lg bg-hover text-fg" aria-label="Стоп">
              <Square size={13} />
            </button>
          ) : (
            <Tip text={videoBusy ? "Идёт генерация видео — ассистент будет доступен после неё" : job ? "Ассистент занят" : "Отправить"}>
              <span>
                <button
                  onClick={submit}
                  disabled={blocked || (!text.trim() && !attachment)}
                  className="mb-1 flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-fg disabled:opacity-40"
                  aria-label="Отправить"
                >
                  <ArrowUp size={16} />
                </button>
              </span>
            </Tip>
          )}
        </div>
        <p className="mt-1.5 text-center text-[11px] text-faint">
          Ассистент видит референсы и черновик промпта с вкладки «Генерация», начиная со второго сообщения чата.
        </p>
      </div>
    </div>
  );
}
