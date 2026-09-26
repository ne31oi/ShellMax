import { PencilLine } from "lucide-react";
import { useState } from "react";
import { Button, Popover, Tip } from "../ui";

/** "Поправить": describe a change to a finished prompt in plain words; the assistant applies only that change. */
export function EditPromptButton({
  onSubmit,
  disabled,
  hint,
}: {
  onSubmit: (instruction: string) => void;
  disabled?: boolean;
  hint?: string; // why it is disabled
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");

  const submit = () => {
    const instruction = text.trim();
    if (!instruction) return;
    setOpen(false);
    setText("");
    onSubmit(instruction);
  };

  const trigger = (
    <Button variant="ghost" size="sm" disabled={disabled} className="text-accent hover:text-accent-strong">
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
  return (
    <Popover open={open} onOpenChange={setOpen} trigger={trigger} align="end" className="w-80">
      <label className="mb-1.5 block text-[13px] font-medium">Что изменить?</label>
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={3}
        placeholder="Например: сделай ночь и дождь, камера медленно наезжает, она улыбается в конце"
        className="w-full resize-none rounded-lg border border-line bg-raised p-2 text-[13px] outline-none placeholder:text-faint focus:border-accent/60"
      />
      <div className="mt-2 flex items-center gap-2">
        <span className="flex-1 text-[11px] text-faint">Остальное и теги референсов останутся как есть</span>
        <Button variant="primary" size="sm" onClick={submit} disabled={!text.trim()}>
          Поправить
        </Button>
      </div>
    </Popover>
  );
}
