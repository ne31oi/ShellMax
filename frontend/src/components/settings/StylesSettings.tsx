import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { ScannedModel, Style } from "../../api/types";
import { fileName, fmtSize } from "../../lib/format";
import { defaultProfile, useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { Button, IconButton, SectionTitle, Slider } from "../ui";
import { PathField } from "./PathField";

const niceName = (path: string) =>
  fileName(path)
    .replace(/\.(safetensors|sft|ckpt|pt|pth|bin)$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();

export function StylesSettings() {
  const styles = useLibrary((s) => s.styles);
  const reload = useLibrary((s) => s.reloadStyles);
  const profiles = useLibrary((s) => s.profiles);
  const toast = useUI((s) => s.toast);
  const [path, setPath] = useState("");
  const [found, setFound] = useState<ScannedModel[]>([]);

  useEffect(() => {
    api.scanModels().then((s) => setFound(s.lora ?? []));
  }, []);

  const add = async (p: string, name?: string) => {
    try {
      await api.createStyle({ name: name ?? niceName(p), path: p, default_strength: 1, triggers: [] });
      await reload();
      setPath("");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не удалось добавить", "bad");
    }
  };

  // technical LoRAs of the engine profile and already added styles are not offered again
  const prof = defaultProfile(profiles)?.data;
  const taken = new Set([
    ...styles.map((s) => s.path.toLowerCase()),
    ...(prof ? [...prof.loras_main, ...prof.loras_final].map((l) => l.path.toLowerCase()) : []),
  ]);
  const suggestions = found.filter((f) => !taken.has(f.path.toLowerCase()));

  return (
    <div className="space-y-6 p-5">
      <p className="text-xs text-muted">
        Стиль — творческая LoRA (в т.ч. Realism people / r34l1sm). Добавьте один раз, дальше включайте чипом «Стиль» и регулируйте силу.
        Слова-триггеры сами допишутся в промпт.
      </p>

      <section>
        <SectionTitle>Добавить по пути</SectionTitle>
        <div className="flex gap-2">
          <div className="flex-1">
            <PathField value={path} onChange={setPath} category="lora" placeholder="Путь к .safetensors" />
          </div>
          <Button variant="primary" disabled={!path} onClick={() => add(path)}>
            <Plus size={14} /> Добавить
          </Button>
        </div>
      </section>

      {styles.length > 0 && (
        <section>
          <SectionTitle>Мои стили</SectionTitle>
          <div className="space-y-2">
            {styles.map((s) => (
              <StyleRow key={s.id} style={s} onChanged={reload} />
            ))}
          </div>
        </section>
      )}

      {suggestions.length > 0 && (
        <section>
          <SectionTitle>Найдено в папке моделей</SectionTitle>
          <div className="grid grid-cols-2 gap-1.5">
            {suggestions.map((f) => (
              <button
                key={f.path}
                onClick={() => add(f.path)}
                className="group flex items-center gap-2 rounded-lg border border-line px-2.5 py-2 text-left hover:border-accent/50 hover:bg-hover"
              >
                <Plus size={13} className="shrink-0 text-faint group-hover:text-accent" />
                <span className="min-w-0 flex-1 truncate text-xs">{niceName(f.path)}</span>
                <span className="text-[10px] text-faint">{fmtSize(f.size)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function StyleRow({ style, onChanged }: { style: Style; onChanged: () => void }) {
  const [s, setS] = useState(style);
  const [timer, setTimer] = useState<ReturnType<typeof setTimeout>>();
  const save = (next: Style) => {
    setS(next);
    clearTimeout(timer);
    setTimer(
      setTimeout(async () => {
        await api.updateStyle(next.id, { name: next.name, path: next.path, default_strength: next.default_strength, triggers: next.triggers });
        onChanged();
      }, 600),
    );
  };
  return (
    <div className="grid grid-cols-[1fr_160px_auto] items-start gap-3 rounded-xl border border-line p-3">
      <div className="min-w-0 space-y-1.5">
        <input
          value={s.name}
          onChange={(e) => save({ ...s, name: e.target.value })}
          className="w-full bg-transparent text-[13px] font-medium outline-none"
        />
        <p className="truncate font-mono text-[10px] text-faint" title={s.path}>{s.path}</p>
        <input
          value={s.triggers.join(", ")}
          onChange={(e) => save({ ...s, triggers: e.target.value.split(",").map((t) => t.trim()) })}
          placeholder="Слова-триггеры через запятую (необязательно)"
          className="h-7 w-full rounded-md border border-line bg-raised px-2 text-xs outline-none placeholder:text-faint focus:border-accent/60"
        />
      </div>
      <div>
        <p className="mb-1 text-[11px] text-muted">Сила по умолчанию: {s.default_strength.toFixed(2)}</p>
        <Slider value={s.default_strength} min={0} max={1.5} step={0.05} onChange={(v) => save({ ...s, default_strength: v })} />
      </div>
      <IconButton
        label="Удалить стиль"
        size="sm"
        onClick={async () => {
          await api.deleteStyle(s.id);
          onChanged();
        }}
      >
        <Trash2 size={13} />
      </IconButton>
    </div>
  );
}
