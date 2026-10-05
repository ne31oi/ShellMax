import clsx from "clsx";
import { Check, ChevronRight, Copy, RotateCcw, Star, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { EngineProfile, ExpertParams, ProfileRow } from "../../api/types";
import { defaultProfile, useLibrary } from "../../store/library";
import { flushFormPersist, useForm } from "../../store/form";
import { useUI } from "../../store/ui";
import { Button, IconButton, Select as SelectField, SectionTitle, Switch } from "../ui";
import { PathField, type ModelCategory } from "./PathField";
import { FaceRecipeSection, LoraGroup, NumField } from "./EngineSettingsParts";

const MODEL_FIELDS: { key: keyof EngineProfile; label: string; hint: string; category: ModelCategory }[] = [
  { key: "unet", label: "Модель", hint: "Диффузионная модель MiniMax H3", category: "unet" },
  { key: "nvfp4_unet", label: "Финальная модель", hint: "Смешанная NVFP4 для финального прохода", category: "unet" },
  { key: "pdmd_lora", label: "PDMD LoRA", hint: "Сила задаётся в «Эксперте»", category: "lora" },
  { key: "text_encoder", label: "Текстовый энкодер", hint: "Qwen3-VL для MiniMax H3", category: "text_encoder" },
  { key: "vae_video", label: "VAE видео", hint: "", category: "vae" },
  { key: "vae_audio", label: "VAE аудио", hint: "", category: "vae" },
  { key: "upscaler", label: "Латентный апскейлер", hint: "Для второго прохода DualSampling", category: "upscaler" },
];

const PIPELINE_OPTIONS = [
  { value: "generate_memory", label: "Singularity · экономия памяти" },
  { value: "generate_nvfp4", label: "NVFP4 · 10 интервалов финала" },
  { value: "generate", label: "Singularity DualSampling (по умолчанию)" },
  { value: "generate_nvfp4_fast", label: "NVFP4 · 5 интервалов финала" },
  { value: "generate_pdmd", label: "PDMD · DualSampling" },
];

export function EngineSettings() {
  const profiles = useLibrary((s) => s.profiles);
  const reload = useLibrary((s) => s.reloadProfiles);
  const formProfileId = useForm((s) => s.profileId);
  const [activeId, setActiveId] = useState<number | null>(formProfileId);
  const row = profiles.find((p) => p.id === activeId) ?? defaultProfile(profiles);
  const [draft, setDraft] = useState<EngineProfile | null>(null);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");
  const [problems, setProblems] = useState<ProfileRow["problems"]>([]);
  const [expert, setExpert] = useState(false);
  const [options, setOptions] = useState<{ sampler: string[]; scheduler: string[] }>({ sampler: [], scheduler: [] });
  useEffect(() => {
    if (expert) api.engineOptions().then(setOptions).catch(() => undefined);
  }, [expert]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<{ id: number; data: EngineProfile; isDefault: boolean } | null>(null);

  useEffect(() => {
    if (row) {
      setDraft(structuredClone(row.data));
      setProblems(row.problems);
    }
  }, [row?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const flushSave = async () => {
    clearTimeout(timer.current);
    const job = pending.current;
    if (!job) return;
    pending.current = null;
    setSaved("saving");
    try {
      const res = await api.updateProfile(job.id, job.data, job.isDefault);
      setProblems(res.problems);
      setSaved("saved");
      await reload();
    } catch (e) {
      setSaved("idle");
      useUI.getState().toast(e instanceof Error ? e.message : "Не удалось сохранить профиль", "bad");
    }
  };

  // Flush pending autosave on dialog close / tab hide / page unload.
  useEffect(() => {
    const onHide = () => {
      void flushSave();
    };
    window.addEventListener("beforeunload", onHide);
    const onVis = () => {
      if (document.visibilityState === "hidden") onHide();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("visibilitychange", onVis);
      void flushSave();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pending kept in ref
  }, []);

  if (!row || !draft) return null;

  // autosave: settings are "fill once", no Save button to forget
  const update = (patch: Partial<EngineProfile>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    setSaved("saving");
    pending.current = { id: row.id, data: next, isDefault: row.is_default };
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void flushSave();
    }, 600);
  };
  const updateExpert = (patch: Partial<ExpertParams>) => update({ expert: { ...draft.expert, ...patch } });
  const bad = new Set(problems.map((p) => p.field));

  const duplicate = async () => {
    const { id } = await api.createProfile({ ...draft, name: `${draft.name} (копия)` });
    await reload();
    setActiveId(id);
  };
  const resetToWorkflow = async () => {
    const wf = await api.workflowDefaults(draft.pipeline);
    update({ expert: wf.expert, low_vram: wf.low_vram,
      ...(draft.pipeline === "generate_pdmd" ? { pdmd_strength: wf.pdmd_strength, pdmd_sparse: wf.pdmd_sparse } : {}) });
    useUI.getState().toast("Внутренние параметры сброшены к воркфлоу", "ok");
  };

  const changePipeline = async (pipeline: NonNullable<EngineProfile["pipeline"]>) => {
    if (pipeline === "generate_pdmd" || draft.pipeline === "generate_pdmd") {
      const wf = await api.workflowDefaults(pipeline);
      update({ pipeline, pdmd_lora: wf.pdmd_lora, pdmd_strength: wf.pdmd_strength, pdmd_sparse: wf.pdmd_sparse, expert: wf.expert,
        loras_main: wf.loras_main, loras_final: wf.loras_final });
    } else update({ pipeline });
  };

  return (
    <div className="space-y-6 p-5">
      {/* profile bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-lg bg-raised p-1">
          {profiles.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                void (async () => {
                  await flushSave();
                  setActiveId(p.id);
                  useForm.getState().set({ profileId: p.id });
                  void flushFormPersist();
                  if (!p.is_default) {
                    await api.updateProfile(p.id, p.data, true);
                    await reload();
                  }
                })();
              }}
              className={clsx("flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs", p.id === row.id ? "bg-hover text-fg" : "text-muted hover:text-fg")}
            >
              {p.is_default && <Star size={11} className="fill-current text-warn" />}
              {p.name}
              {p.problems.length > 0 && <span className="h-1.5 w-1.5 rounded-full bg-bad" />}
            </button>
          ))}
        </div>
        <IconButton label="Новый профиль (копия текущего)" size="sm" onClick={duplicate}>
          <Copy size={13} />
        </IconButton>
        {!row.is_default && (
          <>
            <IconButton
              label="Сделать основным"
              size="sm"
              onClick={async () => {
                await api.updateProfile(row.id, draft, true);
                useForm.getState().set({ profileId: row.id });
                void flushFormPersist();
                reload();
              }}
            >
              <Star size={13} />
            </IconButton>
            <IconButton
              label="Удалить профиль"
              size="sm"
              onClick={async () => {
                await api.deleteProfile(row.id).catch((e) => useUI.getState().toast(e.message, "bad"));
                setActiveId(null);
                reload();
              }}
            >
              <Trash2 size={13} />
            </IconButton>
          </>
        )}
        <span className="ml-auto text-[11px] text-faint">
          {saved === "saving" ? "Сохраняю…" : saved === "saved" ? (
            <span className="inline-flex items-center gap-1 text-ok"><Check size={12} /> Сохранено</span>
          ) : "Изменения сохраняются сами"}
        </span>
      </div>

      <label className="block">
        <span className="mb-1 block text-xs text-muted">Название профиля</span>
        <input
          value={draft.name}
          onChange={(e) => update({ name: e.target.value })}
          className="h-8 w-full max-w-xs rounded-lg border border-line bg-raised px-2.5 text-[13px] outline-none focus:border-accent/60"
        />
      </label>

      <section>
        <SectionTitle>Пайплайн</SectionTitle>
        <SelectField
          label="Граф генерации"
          value={draft.pipeline ?? "generate"}
          onChange={(pipeline) => void changePipeline(pipeline as NonNullable<EngineProfile["pipeline"]>).catch((e) => useUI.getState().toast(e.message, "bad"))}
          options={PIPELINE_OPTIONS}
          defaultValue="generate"
        />
        <p className="mt-1.5 text-xs text-muted">
          {draft.pipeline === "generate_pdmd"
            ? "Все параметры PDMD доступны в «Эксперте»: шаги, разделение, сэмплер, планировщик, сила LoRA и sparse attention. Исходный рецепт — Euler/simple, 4 шага, разделение 2+2, сила 1,0."
            : draft.pipeline === "generate_memory"
            ? "Модель и шаги Singularity сохраняются. H3 Sparse: полное video-attention на начальном проходе и последнем шаге финала, 30% между ними. Результат может отличаться; крупные тензоры считаются по частям."
            : "Singularity сохраняет исходный рецепт. Оба NVFP4 используют INT8 сначала и NVFP4 на финале: 10 интервалов ближе к эталону, 5 — быстрее."}
        </p>
      </section>

      <section>
        <SectionTitle>Модели</SectionTitle>
        <div className="space-y-3">
          {MODEL_FIELDS.filter((f) => (f.key !== "nvfp4_unet" || draft.pipeline === "generate_nvfp4" || draft.pipeline === "generate_nvfp4_fast")
            && (f.key !== "pdmd_lora" || draft.pipeline === "generate_pdmd")).map((f) => (
            <div key={f.key} className="grid grid-cols-[150px_1fr] items-center gap-3">
              <div>
                <p className={clsx("text-[13px]", bad.has(f.key) && "text-bad")}>{f.label}</p>
                {f.hint && <p className="text-[11px] text-faint">{f.hint}</p>}
              </div>
              <PathField value={(draft[f.key] as string) ?? ""} onChange={(v) => update({ [f.key]: v })} category={f.category} />
            </div>
          ))}
        </div>
      </section>

      <section>
        <SectionTitle>Технические LoRA</SectionTitle>
        <p className="-mt-1 mb-3 text-xs text-muted">
          Часть рецепта воркфлоу. Творческие LoRA добавляйте во вкладке «Стили», они выбираются прямо в панели генерации.
        </p>
        <LoraGroup
          title="Ускорение · основной проход"
          hint="Применяется к модели и энкодеру во всех проходах"
          items={draft.loras_main}
          onChange={(loras_main) => update({ loras_main })}
          badPrefix="loras_main"
          bad={bad}
        />
        <LoraGroup
          title="Финальная детализация"
          hint="Только финальный проход: детали, реализм, звук"
          items={draft.loras_final}
          onChange={(loras_final) => update({ loras_final })}
          badPrefix="loras_final"
          bad={bad}
        />
      </section>

      <FaceRecipeSection face={draft.face} onChange={(patch) => update({ face: { ...draft.face, ...patch } })} options={options} onOpenExpert={() => !expert && setExpert(true)} />

      <section className="flex items-start justify-between gap-6 rounded-xl border border-line bg-raised/50 p-4">
        <div>
          <p className="text-[13px]">Экономия видеопамяти</p>
          <p className="mt-0.5 text-xs text-muted">
            {draft.pipeline === "generate_memory"
              ? "Включена в выбранном пайплайне. Обрабатывает крупные промежуточные тензоры по частям и сохраняет точность чекпойнта."
              : "Считает внимание по частям. Генерация может быть медленнее. Включайте, если видите ошибку «не хватило видеопамяти»."}
          </p>
        </div>
        {draft.pipeline !== "generate_memory" && <Switch checked={draft.low_vram} onChange={(low_vram) => update({ low_vram })} label="Экономия видеопамяти" />}
      </section>

      <section>
        <button onClick={() => setExpert(!expert)} className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint hover:text-muted">
          <ChevronRight size={13} className={clsx("transition-transform", expert && "rotate-90")} /> Эксперт
        </button>
        {expert && (
          <div className="mt-3 rounded-xl border border-warn/30 bg-warn/5 p-4">
            <div className="mb-4 flex items-start justify-between gap-4">
              <p className="text-xs text-warn">Эти параметры меняют результат относительно оригинального воркфлоу.</p>
              <Button size="sm" variant="outline" onClick={resetToWorkflow}>
                <RotateCcw size={12} /> Сбросить к воркфлоу
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-3">
              <NumField label="Шаги планировщика" value={draft.expert.steps} onChange={(steps) => updateExpert({ steps })} min={1} />
              <NumField label="Шаг разделения сигм" value={draft.expert.split_step} onChange={(split_step) => updateExpert({ split_step })} min={0} />
              {draft.pipeline === "generate_pdmd" && draft.expert.split_step === 0 &&
                <p className="text-xs text-muted">Все шаги на итоговом разрешении, без раннего черновика.</p>}
              <SelectField label="Сэмплер" value={draft.expert.sampler} onChange={(sampler) => updateExpert({ sampler })}
                options={options.sampler.map((v) => ({ value: v, label: v }))} defaultValue={draft.pipeline === "generate_pdmd" ? "euler" : "seeds_2"} />
              <SelectField label="Планировщик" value={draft.expert.scheduler} onChange={(scheduler) => updateExpert({ scheduler })}
                options={options.scheduler.map((v) => ({ value: v, label: v }))} defaultValue="simple" />
              <NumField label="Доп. промежуточные сигмы" value={draft.expert.extend_steps} onChange={(extend_steps) => updateExpert({ extend_steps })} min={0} />
              <SelectField
                label="Размер референсов"
                value={draft.expert.ref_image_size}
                onChange={(v) => updateExpert({ ref_image_size: v as "match" | "max" })}
                options={[
                  { value: "match", label: "Как у видео — быстрее" },
                  { value: "max", label: "Максимальный — лицо точнее, медленнее" },
                ]}
                defaultValue="match"
              />
              {draft.pipeline === "generate_pdmd" && <>
                <NumField label="Сила PDMD LoRA" value={draft.pdmd_strength ?? 1} onChange={(pdmd_strength) => update({ pdmd_strength })} step={0.05} />
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[13px]">Sparse attention в PDMD</span>
                  <Switch checked={draft.pdmd_sparse ?? false} onChange={(pdmd_sparse) => update({ pdmd_sparse })} label="Sparse attention в PDMD" />
                </div>
              </>}
              {draft.pipeline !== "generate_memory" && <>
                <NumField label="Sparse attention τ" value={draft.expert.sparse_tau} onChange={(sparse_tau) => updateExpert({ sparse_tau })} step={0.05} min={0} max={4} />
                <div className="grid grid-cols-2 gap-2">
                  <NumField label="Sparse от" value={draft.expert.sparse_start} onChange={(sparse_start) => updateExpert({ sparse_start })} step={0.05} min={0} max={1} />
                  <NumField label="Sparse до" value={draft.expert.sparse_end} onChange={(sparse_end) => updateExpert({ sparse_end })} step={0.05} min={0} max={1} />
                </div>
              </>}
              {draft.pipeline !== "generate_memory" && <>
                <NumField label="ChunkFeedForward: частей" value={draft.expert.chunk_ff_chunks} onChange={(chunk_ff_chunks) => updateExpert({ chunk_ff_chunks })} min={1} max={16} />
                <NumField label="ChunkFeedForward: порог токенов" value={draft.expert.chunk_ff_seq_threshold} onChange={(chunk_ff_seq_threshold) => updateExpert({ chunk_ff_seq_threshold })} min={0} />
                <NumField label="Экономия VRAM: групп голов" value={draft.expert.low_vram_heads} onChange={(low_vram_heads) => updateExpert({ low_vram_heads })} min={1} max={56} />
              </>}
              <SelectField
                label="Частота кадров видео-референса"
                value={String(draft.expert.video_force_rate)}
                onChange={(v) => updateExpert({ video_force_rate: Number(v) })}
                options={[
                  { value: "0", label: "Исходная" },
                  { value: "24", label: "24 fps — как ждёт модель" },
                  { value: "25", label: "25 fps" },
                  { value: "30", label: "30 fps" },
                ]}
                defaultValue="0"
              />
              <NumField label="CRF итогового mp4" value={draft.expert.crf} onChange={(crf) => updateExpert({ crf })} min={0} max={51} />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
