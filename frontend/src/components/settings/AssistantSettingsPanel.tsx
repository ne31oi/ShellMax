import clsx from "clsx";
import { Check, ChevronRight, Download } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { AssistantModel, AssistantSettings } from "../../api/types";
import { fmtSize } from "../../lib/format";
import { useAssistant } from "../../store/assistant";
import { Button, SectionTitle, Select, Switch } from "../ui";

export function AssistantSettingsPanel() {
  const [s, setS] = useState<AssistantSettings | null>(null);
  const [models, setModels] = useState<AssistantModel[]>([]);
  const [expert, setExpert] = useState(false);
  const status = useAssistant((st) => st.status);

  const reload = () => {
    api.assistantSettings().then(setS);
    api.assistantModels().then(setModels);
  };
  useEffect(reload, []);
  useEffect(() => {
    api.assistantModels().then(setModels);
  }, [status?.ready, status?.downloading]);

  if (!s) return null;
  const save = async (patch: Partial<AssistantSettings>) => {
    const next = { ...s, ...patch };
    setS(next);
    await api.saveAssistantSettings(next);
    await useAssistant.getState().refresh();
    api.assistantModels().then(setModels);
  };
  const pct = status?.total_bytes ? Math.round((status.received_bytes / status.total_bytes) * 100) : 0;

  return (
    <div className="space-y-6 p-5">
      <p className="text-xs leading-relaxed text-muted">
        Локальная модель для кнопок «В промпт» и «Составить ассистентом». Промпты пишутся по спецификации
        MiniMax H3 Singularity. Набор моделей и параметры — как в Minimax Studio V6. Перед генерацией видео ассистент
        сам выгружается из видеопамяти.
      </p>

      <section>
        <SectionTitle>Модель</SectionTitle>
        <div className="space-y-1.5">
          {models.map((m) => (
            <button
              key={m.id}
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
    </div>
  );
}
