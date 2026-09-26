import { create } from "zustand";
import { api } from "../api/client";
import type { Chat, ChatAttachment, ChatInfo } from "../api/types";
import { frameCount } from "../lib/format";
import { toModelPrompt } from "../lib/refs";
import { useAssistant } from "./assistant";
import { useForm } from "./form";

/** Ideas chats (studio assistant-chats-store), kept on the server so they survive reloads. */
interface ChatsState {
  list: ChatInfo[];
  active: Chat | null;
  loaded: boolean;
  load: () => Promise<void>;
  open: (id: string) => Promise<void>;
  create: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Send a message; the reply streams through useAssistant.job (target "chat") and is committed server-side. */
  send: (text: string, attachment: ChatAttachment | null) => Promise<void>;
}

export const useChats = create<ChatsState>((set, get) => ({
  list: [],
  active: null,
  loaded: false,

  load: async () => {
    const list = await api.chats();
    set({ list, loaded: true });
    if (!get().active && list[0]) await get().open(list[0].id);
  },

  open: async (id) => set({ active: await api.chat(id) }),

  create: async () => {
    const chat = await api.createChat();
    set({ active: chat, list: await api.chats() });
  },

  remove: async (id) => {
    await api.deleteChat(id);
    const list = await api.chats();
    set({ list });
    if (get().active?.id === id) set({ active: list[0] ? await api.chat(list[0].id) : null });
  },

  send: async (text, attachment) => {
    let chat = get().active;
    if (!chat) {
      await get().create();
      chat = get().active!;
    }
    const f = useForm.getState();
    const optimistic = { role: "user" as const, content: text, ...(attachment ? { attachment } : {}) };
    set({ active: { ...chat, messages: [...chat.messages, optimistic] } });
    await useAssistant.getState().run("chat", `/api/assistant/chats/${chat.id}/send`, {
      text,
      attachment,
      refs: f.refs.map((r) => ({ upload_id: r.upload.id, with_audio: r.withAudio })),
      draft: toModelPrompt(f.prompt, f.refs),
      duration: frameCount(f.duration) / 24,
    });
    // the server stored both messages (or only the user's one if the answer failed)
    const id = chat.id;
    const [fresh, list] = await Promise.all([api.chat(id).catch(() => null), api.chats()]);
    set({ list, active: get().active?.id === id ? fresh : get().active });
  },
}));
