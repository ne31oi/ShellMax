import type { Generation } from "../api/types";

/** Pipeline stages in execution order (mirrors backend jobs/queue.py STAGES). */
export const STAGES: { id: string; label: string; short: string }[] = [
  { id: "load", label: "Загрузка моделей", short: "Загрузка" },
  { id: "encode", label: "Разбор промпта и референсов", short: "Промпт" },
  { id: "pass1", label: "Проход 1 — черновое видео", short: "Проход 1" },
  { id: "draft", label: "Сборка черновика", short: "Черновик" },
  { id: "upscale", label: "Апскейл", short: "Апскейл" },
  { id: "pass2", label: "Проход 2", short: "Проход 2" },
  { id: "final", label: "Финальный проход — детали и звук", short: "Финал" },
  { id: "decode", label: "Сборка видео", short: "Сборка" },
];

export const stageInfo = (id: string | null) => STAGES.find((s) => s.id === id) ?? STAGES[0];
export const stageIndex = (id: string | null) => Math.max(0, STAGES.findIndex((s) => s.id === id));

/** Progress of the current stage, when its node reports steps (samplers, decoders). */
export function stepProgress(g: Generation): { value: number; max: number; pct: number } | null {
  const s = g.step;
  if (!s || !s.max) return null;
  return { ...s, pct: Math.round((s.value / s.max) * 100) };
}
