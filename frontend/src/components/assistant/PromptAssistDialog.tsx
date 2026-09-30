import { PencilLine, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import type { CinematicTechniquePreset } from "../../api/types";
import { selectedCinematicTechniqueIds, useForm } from "../../store/form";
import { useLibrary } from "../../store/library";
import { Button, Dialog, Tip } from "../ui";
import { CinemaPreview } from "./cinema-preview/CinemaPreview";
import { CinematicTechniqueSelectors } from "./CinematicTechniqueSelectors";

const FALLBACK_TECHNIQUES: CinematicTechniquePreset[] = [
  { id: "auto", label: "Авто", category: "Авто", hint: "Ассистент выберет приём по смыслу сцены" },
];

type Mode = "compose" | "edit";

/** Modal before assistant compose/edit: independent cinematography categories (+ instruction for edit). */
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
  const techniques = useLibrary((s) => s.meta?.cinematic_technique ?? FALLBACK_TECHNIQUES);
  const cinematicTechniques = useForm((s) => s.cinematicTechniques);
  const cinematicTechnique = useForm((s) => s.cinematicTechnique);
  const aspect = useForm((s) => s.aspect);
  const set = useForm((s) => s.set);
  const [instruction, setInstruction] = useState("");

  useEffect(() => {
    if (open) setInstruction("");
  }, [open, mode]);

  useEffect(() => {
    if (!open) return;
    const state = useForm.getState();
    const legacy = techniques.find((item) => item.id === state.cinematicTechnique);
    const migrated = legacy && legacy.id !== "auto" && Object.keys(state.cinematicTechniques).length === 0;
    set({
      camera: "auto",
      light: "auto",
      ...(legacy ? { cinematicTechnique: "auto" } : {}),
      ...(migrated
        ? { cinematicTechniques: { [legacy.category]: legacy.id } } : {}),
    });
  }, [open, techniques, set]);

  const title = mode === "edit" ? "Поправить промпт" : "Составить промпт";
  const expertOnly = selectedCinematicTechniqueIds({ cinematicTechniques, cinematicTechnique }).length > 0;
  // Edit: text instruction and/or a selected technique is enough to run.
  const canSubmit = mode === "compose" || !!instruction.trim() || expertOnly;

  const submit = () => {
    if (mode === "compose") {
      onOpenChange(false);
      onCompose();
      return;
    }
    let text = instruction.trim();
    if (!text && expertOnly) {
      text = "Примени выбранные кинотехники в соответствующих разделах промпта; остальной текст, структуру полей и теги референсов не меняй.";
    }
    if (!text) return;
    onOpenChange(false);
    onEdit(text);
  };

  return (
    <Dialog open={open && mode !== null} onOpenChange={onOpenChange} title={title} extraWide>
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
              Можно выбрать приёмы ниже без текста. Остальное и теги референсов останутся как есть.
            </p>
          </div>
        )}

        {mode === "compose" && (
          <p className="text-[13px] text-muted">
            Ассистент перепишет ваше описание в промпт по спецификации H3. Теги референсов сохранятся.
          </p>
        )}

        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <div className="lg:sticky lg:top-0 lg:w-[min(44%,30rem)] lg:shrink-0">
            <CinemaPreview
              techniques={techniques}
              selectedByCategory={cinematicTechniques}
              aspect={aspect}
            />
          </div>
          <div className="min-w-0 flex-1">
            <CinematicTechniqueSelectors
              techniques={techniques}
              value={cinematicTechniques}
              onChange={(category, id) => {
                const next = category ? { ...cinematicTechniques } : {};
                if (category && id) next[category] = id;
                else if (category) delete next[category];
                set({ cinematicTechniques: next, cinematicTechnique: "auto", camera: "auto", light: "auto" });
              }}
            />
          </div>
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
