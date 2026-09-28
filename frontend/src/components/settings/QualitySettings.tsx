import { RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { QualityPresetValues, QualitySettings } from "../../api/types";
import { useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { Button, ErrorMessage, SectionTitle } from "../ui";

const IDS = ["draft", "standard", "high"] as const;
const ASPECT = "16:9 (Widescreen)";

export function QualitySettingsPanel() {
  const [data, setData] = useState<QualitySettings | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");
  const toast = useUI((s) => s.toast);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<Record<string, QualityPresetValues> | null>(null);
  const dataRef = useRef<QualitySettings | null>(null);
  dataRef.current = data;

  const reload = () =>
    api
      .quality()
      .then((d) => {
        setData(d);
        pending.current = null;
        setError("");
      })
      .catch((e) => {
        setData(null);
        setError(
          e instanceof Error && /<!doctype|Unexpected token/i.test(e.message)
            ? "Бэкенд без API качества. Перезапустите ShellMax (кнопка питания в шапке)."
            : e instanceof Error
              ? e.message
              : "Не удалось загрузить пресеты",
        );
      });

  const flush = async () => {
    const presets = pending.current;
    if (!presets) return;
    pending.current = null;
    try {
      const next = await api.saveQuality(presets);
      // Ignore stale response if the user edited again while we were saving.
      if (pending.current) return;
      setData(next);
      setSaved("saved");
      const meta = await api.meta();
      useLibrary.setState({ meta });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не удалось сохранить", "bad");
      setSaved("idle");
      reload();
    }
  };

  useEffect(() => {
    reload();
    const onHide = () => {
      if (pending.current) void flush();
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      clearTimeout(timer.current);
      if (pending.current) void flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error && !data) {
    return (
      <div className="space-y-3 p-5">
        <ErrorMessage text={error} />
        <Button size="sm" onClick={reload}>
          Повторить
        </Button>
      </div>
    );
  }

  if (!data) {
    return <p className="p-5 text-xs text-muted">Загружаю пресеты…</p>;
  }

  const persist = (presets: QualitySettings["presets"]) => {
    const cur = dataRef.current;
    if (!cur) return;
    const next = { ...cur, presets };
    dataRef.current = next;
    pending.current = presets;
    setData(next);
    setSaved("saving");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 500);
  };

  const update = (id: string, patch: Partial<QualitySettings["presets"][string]>) => {
    const cur = dataRef.current;
    if (!cur) return;
    persist({ ...cur.presets, [id]: { ...cur.presets[id], ...patch } });
  };

  const reset = async () => {
    clearTimeout(timer.current);
    pending.current = null;
    try {
      const next = await api.resetQuality();
      setData(next);
      dataRef.current = next;
      setSaved("saved");
      const meta = await api.meta();
      useLibrary.setState({ meta });
      toast("Пресеты качества сброшены к воркфлоу", "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не удалось сбросить", "bad");
    }
  };

  const dirty = IDS.some((id) => {
    const a = data.presets[id];
    const b = data.workflow[id];
    return a.megapixels !== b.megapixels || a.scale !== b.scale || a.label !== b.label;
  });

  return (
    <div className="space-y-6 p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs leading-relaxed text-muted">
          Пресеты чипа «Качество» на панели генерации. Каждый задаёт базовое разрешение (мегапиксели) и множитель
          латентного апскейла. «Стандарт» в воркфлоу — 0.5 МП × 1.5 → 1440×832 при 16:9.
        </p>
        <span className="shrink-0 text-[11px] text-faint tabular-nums">
          {saved === "saving" ? "сохраняю…" : saved === "saved" ? "сохранено" : ""}
        </span>
      </div>

      <div className="space-y-4">
        {IDS.map((id) => {
          const p = data.presets[id];
          const wf = data.workflow[id];
          const res = data.resolutions[id]?.[ASPECT];
          const [bw, bh] = res?.base ?? [0, 0];
          const [fw, fh] = res?.final ?? [0, 0];
          const match = p.megapixels === wf.megapixels && p.scale === wf.scale;
          return (
            <section key={id} className="rounded-xl border border-line p-3.5">
              <div className="mb-3 flex items-center gap-2">
                <input
                  value={p.label}
                  onChange={(e) => update(id, { label: e.target.value.slice(0, 40) })}
                  className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1.5 py-0.5 text-[13px] font-medium outline-none hover:border-line focus:border-accent/60 focus:bg-raised"
                />
                {match ? (
                  <span className="text-[11px] text-faint">как в воркфлоу</span>
                ) : (
                  <span className="text-[11px] text-warn">изменено</span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <NumField
                  label="Мегапиксели"
                  value={p.megapixels}
                  min={0.1}
                  max={2}
                  step={0.05}
                  onChange={(v) => update(id, { megapixels: v })}
                />
                <NumField
                  label="Апскейл ×"
                  value={p.scale}
                  min={1}
                  max={2.5}
                  step={0.1}
                  onChange={(v) => update(id, { scale: v })}
                />
              </div>
              <p className="mt-2.5 text-[11px] text-muted tabular-nums">
                16:9 → база {bw}×{bh}, финал {fw}×{fh}
                {!match && (
                  <span className="text-faint">
                    {" "}
                    · воркфлоу {wf.megapixels} МП × {wf.scale}
                  </span>
                )}
              </p>
            </section>
          );
        })}
      </div>

      <section>
        <SectionTitle>Сброс</SectionTitle>
        <Button size="sm" disabled={!dirty} onClick={reset}>
          <RotateCcw size={13} /> Сбросить к воркфлоу
        </Button>
      </section>
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
}) {
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
