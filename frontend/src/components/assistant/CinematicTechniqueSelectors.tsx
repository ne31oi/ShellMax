import type { CinematicTechniquePreset } from "../../api/types";
import { Button, Select } from "../ui";

const NO_TECHNIQUE = "__no_cinematic_technique__";

/** Keep every source category visible with one active technique per category. */
export function CinematicTechniqueSelectors({
  techniques,
  value,
  onChange,
}: {
  techniques: CinematicTechniquePreset[];
  value: Record<string, string>;
  onChange: (category: string, id: string | null) => void;
}) {
  const groups = new Map<string, CinematicTechniquePreset[]>();
  for (const technique of techniques) {
    if (technique.id === "auto") continue;
    const group = groups.get(technique.category) ?? [];
    group.push(technique);
    groups.set(technique.category, group);
  }

  const selected = techniques.filter((technique) => technique.id !== "auto" && value[technique.category] === technique.id);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[13px] font-semibold">Кинотехника</h3>
          <p className="mt-0.5 text-[11px] text-faint">
            Можно выбрать по одному приёму в нескольких категориях. Каждый селект управляет только своей категорией.
          </p>
        </div>
        <Button
          type="button"
          variant={selected.length === 0 ? "subtle" : "outline"}
          size="sm"
          aria-pressed={selected.length === 0}
          onClick={() => onChange("", null)}
        >
          Сбросить все к «Авто»
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {[...groups].map(([category, items]) => {
          const current = items.some((item) => item.id === value[category]) ? value[category] : NO_TECHNIQUE;
          return (
            <div key={category} className="rounded-xl border border-line bg-raised/40 p-3">
              <Select
                label={`${category} · ${items.length}`}
                value={current}
                onChange={(id) => onChange(category, id === NO_TECHNIQUE ? null : id)}
                options={[
                  { value: NO_TECHNIQUE, label: "Не выбрано" },
                  ...items.map((item) => ({
                    value: item.id,
                    label: `${item.source_id ? `${item.source_id} · ` : ""}${item.label}`,
                  })),
                ]}
              />
            </div>
          );
        })}
      </div>

      {selected.length > 0 && (
        <div className="rounded-lg bg-raised px-3 py-2 text-[11px] leading-relaxed text-muted">
          <p className="mb-1 font-medium text-fg">Выбрано: {selected.length}</p>
          {selected.map((technique) => (
            <p key={technique.id}>
              <span className="font-medium text-fg">{technique.source_id} · {technique.label}:</span> {technique.hint}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
