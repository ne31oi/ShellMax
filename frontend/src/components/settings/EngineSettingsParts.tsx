import clsx from "clsx";
import { ChevronRight, Plus, X } from "lucide-react";
import { useState } from "react";
import type { FaceRecipe, LoraSpec } from "../../api/types";
import { Button, Select as SelectField, SectionTitle, Slider, Switch, Tip } from "../ui";
import { PathField } from "./PathField";

/** MiniMax_H3_FaceRefine_Best recipe: model + 8-step LoRA; internals folded away. */
export function FaceRecipeSection({ face, onChange, options, onOpenExpert }: {
  face: FaceRecipe; onChange: (p: Partial<FaceRecipe>) => void; options: { sampler: string[]; scheduler: string[] }; onOpenExpert: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <SectionTitle>Улучшение лица</SectionTitle>
      <p className="-mt-1 mb-3 text-xs text-muted">
        Модель и LoRA для «Улучшить лицо». По воркфлоу: та же Singularity и turbo-LoRA на 8 шагов — модель не перегружается между генерацией и улучшением.
      </p>
      <div className="space-y-3">
        <div className="grid grid-cols-[150px_1fr] items-center gap-3">
          <p className="text-[13px]">Модель</p>
          <PathField value={face.unet} onChange={(unet) => onChange({ unet })} category="unet" />
        </div>
        <div className="grid grid-cols-[150px_1fr_150px] items-center gap-3">
          <p className="text-[13px]">LoRA 8 шагов</p>
          <PathField value={face.lora} onChange={(lora) => onChange({ lora })} category="lora" />
          <div className="flex items-center gap-2">
            <Slider value={face.lora_strength} min={0} max={2} step={0.05} onChange={(lora_strength) => onChange({ lora_strength })} />
            <span className="w-8 text-right text-xs tabular-nums text-muted">{face.lora_strength.toFixed(2)}</span>
          </div>
        </div>
      </div>
      <button
        onClick={() => {
          setOpen(!open);
          onOpenExpert();
        }}
        className="mt-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint hover:text-muted"
      >
        <ChevronRight size={13} className={clsx("transition-transform", open && "rotate-90")} /> Эксперт улучшения лица
      </button>
      {open && (
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl border border-warn/30 bg-warn/5 p-4">
          <NumField label="Шаги (должны совпадать с LoRA)" value={face.steps} onChange={(steps) => onChange({ steps })} min={1} max={40} />
          <SelectField label="Сэмплер" value={face.sampler} onChange={(sampler) => onChange({ sampler })}
            options={(options.sampler.length ? options.sampler : [face.sampler]).map((v) => ({ value: v, label: v }))} defaultValue="euler" />
          <SelectField label="Холст перерисовки" value={String(face.canvas)} onChange={(v) => onChange({ canvas: Number(v) })}
            options={[512, 640, 768, 1024].map((v) => ({ value: String(v), label: `${v}×${v}` }))} defaultValue="768" />
          <NumField label="Запас вокруг лица (crop factor)" value={face.crop_factor} onChange={(crop_factor) => onChange({ crop_factor })} min={1.2} max={8} step={0.1} />
          <NumField label="Сглаживание центра, кадров" value={face.smooth_window} onChange={(smooth_window) => onChange({ smooth_window })} min={1} max={201} step={2} />
          <NumField label="Сглаживание размера, кадров" value={face.size_smooth_window} onChange={(size_smooth_window) => onChange({ size_smooth_window })} min={1} max={201} step={2} />
          <NumField label="Мелкое лицо до, px (полная сила)" value={face.face_px_small} onChange={(face_px_small) => onChange({ face_px_small })} min={8} max={1000} />
          <NumField label="Крупное лицо от, px (0.35× силы)" value={face.face_px_large} onChange={(face_px_large) => onChange({ face_px_large })} min={8} max={2000} />
          <NumField label="Расширение маски вклейки, px" value={face.mask_dilation} onChange={(mask_dilation) => onChange({ mask_dilation })} min={0} max={200} />
          <NumField label="Размытие края вклейки, px" value={face.feather} onChange={(feather) => onChange({ feather })} min={0} max={200} />
          <NumField label="Подгонка цвета (0–1)" value={face.colour_match} onChange={(colour_match) => onChange({ colour_match })} min={0} max={1} step={0.05} />
          <NumField label="Сила вклейки (0–1)" value={face.blend} onChange={(blend) => onChange({ blend })} min={0} max={1} step={0.05} />
          <SelectField label="Размер референсов" value={face.ref_image_size} onChange={(v) => onChange({ ref_image_size: v as "match" | "max" })}
            options={[{ value: "max", label: "Максимальный — лицо точнее" }, { value: "match", label: "Как у холста — быстрее" }]} defaultValue="max" />
          <NumField label="CRF итогового mp4" value={face.crf} onChange={(crf) => onChange({ crf })} min={0} max={51} />
        </div>
      )}
    </section>
  );
}

export function LoraGroup({ title, hint, items, onChange, badPrefix, bad }: {
  title: string; hint: string; items: LoraSpec[]; onChange: (v: LoraSpec[]) => void; badPrefix: string; bad: Set<string>;
}) {
  const set = (i: number, patch: Partial<LoraSpec>) => onChange(items.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="mb-4 rounded-xl border border-line p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-[13px]">{title}</p>
        <p className="text-[11px] text-faint">{hint}</p>
      </div>
      <div className="space-y-2">
        {items.map((l, i) => (
          <div key={i} className={clsx("grid grid-cols-[auto_1fr_150px_auto] items-center gap-2.5", !l.enabled && "opacity-50")}>
            <Switch checked={l.enabled} onChange={(enabled) => set(i, { enabled })} label="Включить" />
            <div className={clsx(bad.has(`${badPrefix}.${i}`) && "rounded-lg ring-1 ring-bad/50")}>
              <PathField compact value={l.path} onChange={(path) => set(i, { path })} category="lora" />
            </div>
            <div className="flex items-center gap-2">
              <Slider value={l.strength} min={0} max={2} step={0.05} onChange={(strength) => set(i, { strength })} />
              <span className="w-8 text-right text-xs tabular-nums text-muted">{l.strength.toFixed(2)}</span>
            </div>
            <Tip text="Убрать">
              <button onClick={() => onChange(items.filter((_, j) => j !== i))} className="rounded p-1 text-faint hover:text-bad">
                <X size={13} />
              </button>
            </Tip>
          </div>
        ))}
      </div>
      <Button size="sm" variant="ghost" className="mt-2" onClick={() => onChange([...items, { path: "", strength: 1, enabled: true }])}>
        <Plus size={13} /> Добавить LoRA
      </Button>
    </div>
  );
}

export function NumField({ label, value, onChange, min, max, step = 1 }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => e.target.value !== "" && onChange(Number(e.target.value))}
        className="h-8 w-full rounded-lg border border-line bg-raised px-2.5 text-[13px] tabular-nums outline-none focus:border-accent/60"
      />
    </label>
  );
}
