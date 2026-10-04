import clsx from "clsx";
import { Check, ChevronRight, Download } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError } from "../../api/client";
import type { AssistantModel, AssistantSettings } from "../../api/types";
import { fmtSize } from "../../lib/format";
import { useAssistant } from "../../store/assistant";
import { useUI } from "../../store/ui";
import { Button, SectionTitle, Select, Switch } from "../ui";
import { AudioModelSettings } from "../assistant/AudioModelSettings";
import { CodexConnection } from "../assistant/CodexConnection";

const REASONING_LABELS: Record<string, string> = {
  none: "Без рассуждения (none)", minimal: "Минимальная (minimal)", low: "Низкая (low)",
  medium: "Средняя (medium)", high: "Высокая (high)", xhigh: "Очень высокая (xhigh)",
  max: "Максимальная (max)", ultra: "Ультра (ultra)",
};

export function AssistantSettingsPanel() {
  const [s, setS] = useState<AssistantSettings | null>(null);
  const [models, setModels] = useState<AssistantModel[]>([]);
  const [expert, setExpert] = useState(false);
  const [saving, setSaving] = useState(false);
  const status = useAssistant((st) => st.status);
  const job = useAssistant((st) => st.job);

  const reload = () => {
    api.assistantSettings().then(setS);
    api.assistantModels().then(setModels);
    void useAssistant.getState().refresh();
  };
  useEffect(reload, []);
  useEffect(() => {
    api.assistantModels().then(setModels);
  }, [status?.ready, status?.downloading]);

  if (!s) return null;
  const save = async (patch: Partial<AssistantSettings>) => {
    const next = { ...s, ...patch };
    setSaving(true);
    try {
      await api.saveAssistantSettings(next);
      setS(next);
      await useAssistant.getState().refresh(true);
      api.assistantModels().then(setModels);
    } catch (error) {
      useUI.getState().toast(error instanceof ApiError ? error.message : "Не удалось изменить настройки ассистента", "bad");
    } finally {
      setSaving(false);
    }
  };
  const pct = status?.total_bytes ? Math.round((status.received_bytes / status.total_bytes) * 100) : 0;
  const codexModels = status?.provider === "codex" ? status.models ?? [] : [];
  const reasoningEfforts = codexModels.find((model) => model.id === status?.model)?.reasoning_efforts ?? [];
  const autoReasoning = !s.codex_reasoning_effort && status?.provider === "codex" && status.reasoning_effort
    ? `Авто · ${REASONING_LABELS[status.reasoning_effort] ?? status.reasoning_effort}` : "Авто · из настроек Codex";

  return (
    <div className="space-y-6 p-5">
      <AudioModelSettings />
      <p className="text-xs leading-relaxed text-muted">
        Ассистент для кнопок «В промпт», «Поправить», промптов лица и чата идей.
        Промпты пишутся по действующей спецификации MiniMax H3 Singularity.
      </p>

      <Select label="Кто пишет промпты" value={s.provider} disabled={saving || !!job || status?.busy}
        onChange={(value) => void save({ provider: value as AssistantSettings["provider"] })}
        options={[{ value: "codex", label: "Codex" }, { value: "local", label: "Локальная модель" }]} />

      {s.provider === "codex" ? <div className="space-y-4">
        <Select label="Модель Codex" value={s.codex_model} disabled={saving || !!job || status?.busy}
          onChange={(value) => {
            const nextModel = codexModels.find((model) => model.id === value);
            void save({ codex_model: value,
              codex_reasoning_effort: nextModel?.reasoning_efforts.includes(s.codex_reasoning_effort) ? s.codex_reasoning_effort : "" });
          }}
          options={[{ value: "", label: "Авто · из настроек Codex" },
            ...codexModels.map((model) => ({ value: model.id, label: model.label }))]} />
        <Select label="Глубина рассуждения (reasoning)" value={s.codex_reasoning_effort}
          disabled={saving || !!job || status?.busy}
          onChange={(value) => void save({ codex_reasoning_effort: value })}
          options={[{ value: "", label: autoReasoning },
            ...reasoningEfforts.map((effort) => ({ value: effort, label: REASONING_LABELS[effort] ?? effort }))]} />
        <CodexConnection />
      </div> : <>
      <section>
        <SectionTitle>Модель</SectionTitle>
        <div className="space-y-1.5">
          {models.map((m) => (
            <button
              key={m.id}
              disabled={saving || !!job || status?.busy}
              onClick={() => save({ model: m.id })}
              className={clsx(
                "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                s.model === m.id ? "border-accent/60 bg-accent/10" : "border-line hover:bg-hover",
              )}
            >
              <span className={clsx("flex h-4 w-4 shrink-0 items-center justify-center rounded-full border", s.model === m.id ? "border-accent bg-accent text-accent-fg" : "border-line-strong")}>
                {s.model === m.id && <Check size={10} strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px]">{m.label}</span>
                <span className="block text-[11px] text-faint">{m.hint}</span>
              </span>
              <span className={clsx("shrink-0 text-[11px]", m.ready ? "text-ok" : "text-faint")}>
                {m.ready ? "скачана" : `нужно ~${fmtSize(m.size)}`}
              </span>
            </button>
          ))}
        </div>
        {status && !status.ready && (
          <div className="mt-3 flex items-center gap-3">
            {status.downloading ? (
              <div className="flex-1">
                <div className="mb-1 text-xs text-muted tabular-nums">Скачиваю «{status.label}»… {pct}%</div>
                <div className="h-1.5 overflow-hidden rounded-full bg-line">
                  <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
                </div>
              </div>
            ) : (
              <Button size="sm" variant="primary" onClick={() => useAssistant.getState().download()}>
                <Download size={13} /> Скачать «{status.label}»
              </Button>
            )}
          </div>
        )}
      </section>

      <section>
        <button onClick={() => setExpert(!expert)} className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint hover:text-muted">
          <ChevronRight size={13} className={clsx("transition-transform", expert && "rotate-90")} /> Эксперт
        </button>
        {expert && (
          <div className="mt-3 space-y-4 rounded-xl border border-line p-4">
            <div className="grid grid-cols-2 gap-x-6 gap-y-3">
              <Select label="Где считать" value={s.device} onChange={(v) => save({ device: v as AssistantSettings["device"] })}
                options={[{ value: "gpu", label: "Видеокарта" }, { value: "cpu", label: "Процессор (медленно)" }]} defaultValue="gpu" />
              <Select label="Контекст, токенов" value={String(s.context_size)} onChange={(v) => save({ context_size: Number(v) })}
                options={[16384, 25600, 32768, 65536].map((v) => ({ value: String(v), label: v.toLocaleString("ru-RU") }))} defaultValue="25600" />
              <Select label="Макс. длина ответа, токенов" value={String(s.max_output_tokens)} onChange={(v) => save({ max_output_tokens: Number(v) })}
                options={[2048, 4096, 8192].map((v) => ({ value: String(v), label: v.toLocaleString("ru-RU") }))} defaultValue="4096" />
              <Select label="Сжатие KV-кэша" value={s.kv_cache} onChange={(v) => save({ kv_cache: v as AssistantSettings["kv_cache"] })}
                options={[{ value: "q4_0", label: "q4_0 — экономия памяти" }, { value: "q8_0", label: "q8_0" }, { value: "q5_1", label: "q5_1" }, { value: "off", label: "без сжатия (fp16)" }]} defaultValue="q4_0" />
            </div>
            <label className="flex items-center justify-between gap-4">
              <span>
                <span className="block text-[13px]">Свои параметры сэмплинга</span>
                <span className="block text-[11px] text-faint">Выключено — значения, подобранные под модель (как в студии)</span>
              </span>
              <Switch checked={s.sampling_override} onChange={(v) => save({ sampling_override: v })} />
            </label>
            {s.sampling_override && (
              <div className="grid grid-cols-4 gap-2">
                {(["temperature", "top_p", "top_k", "min_p", "presence_penalty", "frequency_penalty", "repeat_penalty"] as const).map((k) => (
                  <label key={k} className="block">
                    <span className="mb-1 block text-[11px] text-muted">{k}</span>
                    <input type="number" step={k === "top_k" ? 1 : 0.05} value={s[k]}
                      onChange={(e) => e.target.value !== "" && save({ [k]: Number(e.target.value) })}
                      className="h-7 w-full rounded-md border border-line bg-raised px-2 text-xs tabular-nums outline-none focus:border-accent/60" />
                  </label>
                ))}
              </div>
            )}
            {status?.running && (
              <Button size="sm" variant="ghost" onClick={() => api.assistantUnload().then(() => useAssistant.getState().refresh())}>
                Выгрузить ассистента из памяти
              </Button>
            )}
          </div>
        )}
      </section>
      </>}
    </div>
  );
}
