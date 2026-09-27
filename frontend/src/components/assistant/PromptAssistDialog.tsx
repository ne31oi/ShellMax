import { PencilLine, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import type { CameraPreset, LightPreset } from "../../api/types";
import { useForm } from "../../store/form";
import { useLibrary } from "../../store/library";
import { Button, Dialog, Select, Tip } from "../ui";

const FALLBACK_CAMERA: CameraPreset[] = [
  { id: "auto", label: "Авто", hint: "Камера по тексту или по смыслу" },
];
const FALLBACK_LIGHT: LightPreset[] = [
  { id: "auto", label: "Авто", hint: "Свет по тексту или по подаче" },
];

type Mode = "compose" | "edit";

/** Modal before assistant compose/edit: expert camera + light (+ instruction for edit). */
export function PromptAssistDialog({
  mode,
  open,
  onOpenChange,
  onCompose,
  onEdit,
}: {
  mode: Mode | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCompose: () => void;
  onEdit: (instruction: string) => void;
}) {
  const cameras = useLibrary((s) => s.meta?.camera ?? FALLBACK_CAMERA);
  const lights = useLibrary((s) => s.meta?.light ?? FALLBACK_LIGHT);
  const camera = useForm((s) => s.camera);
  const light = useForm((s) => s.light);
  const set = useForm((s) => s.set);
  const [instruction, setInstruction] = useState("");

  useEffect(() => {
    if (open) setInstruction("");
  }, [open, mode]);

  const cam = cameras.find((p) => p.id === camera) ?? cameras[0];
  const lit = lights.find((p) => p.id === light) ?? lights[0];
  const title = mode === "edit" ? "Поправить промпт" : "Составить промпт";
  const expertOnly = camera !== "auto" || light !== "auto";
  // Edit: text instruction and/or expert camera/light alone is enough to run.
  const canSubmit = mode === "compose" || !!instruction.trim() || expertOnly;

  const submit = () => {
    if (mode === "compose") {
      onOpenChange(false);
      onCompose();
      return;
    }
    let text = instruction.trim();
    if (!text && expertOnly) {
      const bits: string[] = [];
      if (camera !== "auto") bits.push("камеру в detailed_description");
      if (light !== "auto") bits.push("свет в visual_style");
      text = `Перепиши только ${bits.join(" и ")} строго по экспертному выбору; остальной текст, структуру полей и теги референсов не меняй.`;
    }
    if (!text) return;
    onOpenChange(false);
    onEdit(text);
  };

  return (
    <Dialog open={open && mode !== null} onOpenChange={onOpenChange} title={title}>
      <div className="space-y-4 p-5">
        {mode === "edit" && (
          <div>
            <label className="mb-1.5 block text-[13px] font-medium">Что изменить?</label>
            <textarea
              autoFocus
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={3}
              placeholder="Например: сделай ночь и дождь, она улыбается в конце"
              className="w-full resize-none rounded-lg border border-line bg-raised p-2.5 text-[13px] outline-none placeholder:text-faint focus:border-accent/60"
            />
            <p className="mt-1.5 text-[11px] text-faint">
              Можно только сменить камеру или свет ниже — без текста. Остальное и теги референсов останутся как есть.
            </p>
          </div>
        )}

        {mode === "compose" && (
          <p className="text-[13px] text-muted">
            Ассистент перепишет ваше описание в промпт по спецификации H3. Теги референсов сохранятся.
          </p>
        )}

        <div>
          <Select
            label="Камера (эксперт)"
            value={camera}
            defaultValue="auto"
            onChange={(v) => set({ camera: v })}
            options={cameras.map((p) => ({
              value: p.id,
              label: p.emotion ? `${p.label} — ${p.emotion}` : p.label,
            }))}
          />
          {cam?.hint && <p className="mt-1.5 text-[11px] text-muted">{cam.hint}</p>}
          <p className="mt-1 text-[11px] text-faint">
            Выбор сильнее текста в описании. «Авто» — сначала явный запрос в тексте, иначе вывод по смыслу.
          </p>
        </div>

        <div>
          <Select
            label="Свет (эксперт)"
            value={light}
            defaultValue="auto"
            onChange={(v) => set({ light: v })}
            options={lights.map((p) => ({ value: p.id, label: p.label }))}
          />
          {lit?.hint && <p className="mt-1.5 text-[11px] text-muted">{lit.hint}</p>}
          <p className="mt-1 text-[11px] text-faint">
            Геометрия ключа в visual_style. «Авто» — по тексту или по подаче (Кино / Клип).
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            disabled={!canSubmit}
          >
            {mode === "edit" ? (
              <>
                <PencilLine size={13} /> Поправить
              </>
            ) : (
              <>
                <Sparkles size={13} /> В промпт
              </>
            )}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function ComposeAssistButton({
  disabled,
  hint,
  onOpen,
}: {
  disabled?: boolean;
  hint?: string;
  onOpen: () => void;
}) {
  const trigger = (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled}
      onClick={onOpen}
      className="text-accent hover:text-accent-strong"
    >
      <Sparkles size={13} /> В промпт
    </Button>
  );
  if (disabled) {
    return (
      <Tip text={hint ?? "Ассистент занят"}>
        <span>{trigger}</span>
      </Tip>
    );
  }
  return trigger;
}

export function EditAssistButton({
  disabled,
  hint,
  onOpen,
}: {
  disabled?: boolean;
  hint?: string;
  onOpen: () => void;
}) {
  const trigger = (
    <Button variant="ghost" size="sm" disabled={disabled} onClick={onOpen} className="text-accent hover:text-accent-strong">
      <PencilLine size={13} /> Поправить
    </Button>
  );
  if (disabled) {
    return (
      <Tip text={hint ?? "Ассистент занят"}>
        <span>{trigger}</span>
      </Tip>
    );
  }
  return trigger;
}
