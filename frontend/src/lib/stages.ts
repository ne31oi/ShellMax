import type { Generation, JobKind } from "../api/types";

export interface StageDef {
  id: string;
  label: string;
  short: string;
}

/** Shared stage list for generate and NVFP4 variants (same pipeline shape). */
export const GENERATE_STAGES: StageDef[] = [
  { id: "load", label: "Загрузка моделей", short: "Загрузка" },
  { id: "encode", label: "Разбор промпта и референсов", short: "Промпт" },
  { id: "pass1", label: "Проход 1 — черновое видео", short: "Проход 1" },
  { id: "draft", label: "Сборка черновика", short: "Черновик" },
  { id: "upscale", label: "Апскейл", short: "Апскейл" },
  { id: "pass2", label: "Проход 2", short: "Проход 2" },
  { id: "final", label: "Финальный проход — детали и звук", short: "Финал" },
  { id: "decode", label: "Сборка видео", short: "Сборка" },
];

const BODY_SWAP_STAGES: StageDef[] = [
    { id: "load", label: "Загрузка клипа и моделей", short: "Загрузка" },
    { id: "mask", label: "Выделение персонажа", short: "Маски" },
    { id: "pose", label: "Поза тела и рук", short: "Поза" },
    { id: "encode", label: "Кодирование исходника и фотографий", short: "Кодирование" },
    { id: "sample", label: "Замена персонажа по позе", short: "Замена" },
    { id: "decode", label: "Сборка кадров", short: "Декод" },
    { id: "stitch", label: "Восстановление фона и вклейка персонажа", short: "Фон и вклейка" },
    { id: "save", label: "Сохранение с исходным звуком", short: "Сохранение" },
];

/** Pipeline stages per job kind, in execution order (mirrors backend jobs/pipelines.py). */
export const STAGES_BY_KIND: Record<JobKind, StageDef[]> = {
  dlss5: [
    { id: "load", label: "Подготовка DLSS5", short: "Подготовка" },
    { id: "enhance", label: "DLSS5 — нейронная обработка видео", short: "DLSS5" },
    { id: "save", label: "Сохранение видео и метаданных", short: "Сохранение" },
  ],
  body_swap: BODY_SWAP_STAGES,
  body_swap_singularity: BODY_SWAP_STAGES,
  head_swap: [
    { id: "load", label: "Загрузка клипа и моделей", short: "Загрузка" },
    { id: "track", label: "Отслеживание выбранной головы", short: "Трекинг" },
    { id: "describe", label: "Описание головы по фотографии", short: "Фото" },
    { id: "encode", label: "Кодирование фото и исходного клипа", short: "Кодирование" },
    { id: "pass1", label: "Замена головы — первый проход", short: "Проход 1" },
    { id: "upscale", label: "Подготовка второго прохода", short: "Подготовка" },
    { id: "encode2", label: "Привязка второго прохода к исходнику", short: "Привязка" },
    { id: "pass2", label: "Замена головы — второй проход", short: "Проход 2" },
    { id: "decode", label: "Сборка кадров", short: "Декод" },
    { id: "mask", label: "Край волос, восстановление фона и защита рук", short: "Край и фон" },
    { id: "stitch", label: "Вклейка выбранной головы в исходник", short: "Вклейка" },
    { id: "save", label: "Сохранение видео с исходным звуком", short: "Сохранение" },
  ],
  fidelity_upscale: [{ id: "load", label: "Загрузка клипа и модели", short: "Загрузка" },
    { id: "upscale", label: "Бережное улучшение", short: "SwinIR" },
    { id: "save", label: "Сохранение", short: "Сохранение" }],
  generate: GENERATE_STAGES,
  generate_pdmd: GENERATE_STAGES,
  generate_pdmd_refmods: GENERATE_STAGES,
  generate_memory: GENERATE_STAGES,
  generate_memory_refmods: GENERATE_STAGES,
  generate_nvfp4: GENERATE_STAGES,
  generate_nvfp4_fast: GENERATE_STAGES,
  generate_refmods: GENERATE_STAGES,
  generate_nvfp4_refmods: GENERATE_STAGES,
  generate_nvfp4_fast_refmods: GENERATE_STAGES,
  refmod_create: [
    { id: "load", label: "Загрузка кодировщиков", short: "Загрузка" },
    { id: "encode", label: "Создание RefMod", short: "RefMod" },
  ],
  mask_edit: [
    { id: "load", label: "Загрузка моделей", short: "Загрузка" },
    { id: "encode", label: "Кодирование клипа и маски", short: "Маска" },
    { id: "sample", label: "Перерисовка выбранной области", short: "Правка" },
    { id: "decode", label: "Сборка кадров", short: "Декод" },
    { id: "stitch", label: "Вклейка в исходный клип", short: "Вклейка" },
    { id: "save", label: "Сохранение видео", short: "Сохранение" },
  ],
  mask_track: [
    { id: "load", label: "Загрузка SAM", short: "Загрузка" },
    { id: "track", label: "Выделение и трекинг объекта", short: "Трекинг" },
  ],
  face: [
    { id: "load", label: "Загрузка моделей", short: "Загрузка" },
    { id: "track", label: "Поиск и трекинг лица", short: "Трекинг" },
    { id: "encode", label: "Разбор промпта и референсов", short: "Промпт" },
    { id: "lipsync", label: "Привязка к звуку клипа", short: "Звук" },
    { id: "refine", label: "Перерисовка лица", short: "Лицо" },
    { id: "stitch", label: "Вклейка лица в кадр", short: "Вклейка" },
    { id: "save", label: "Сохранение видео", short: "Сохранение" },
  ],
  enhance: [
    { id: "load", label: "Загрузка моделей", short: "Загрузка" },
    { id: "resize", label: "Увеличение кадра", short: "Масштаб" },
    { id: "encode", label: "Кодирование", short: "Код" },
    { id: "sample", label: "SeedVR2 — детализация", short: "SeedVR2" },
    { id: "decode", label: "Сборка кадров", short: "Декод" },
    { id: "save", label: "Сохранение видео", short: "Сохранение" },
  ],
  interpolate: [
    { id: "load", label: "Загрузка модели", short: "Загрузка" },
    { id: "interpolate", label: "Интерполяция кадров", short: "Кадры" },
    { id: "save", label: "Сохранение видео", short: "Сохранение" },
  ],
};

/** Backwards-compatible default list (generation). */
export const STAGES = STAGES_BY_KIND.generate;

/** History can contain jobs whose workflow has since been removed. */
export const isSupportedJobKind = (kind: string): kind is JobKind => Object.hasOwn(STAGES_BY_KIND, kind);
export const isGenerationKind = (kind: string) => isSupportedJobKind(kind) && kind.startsWith("generate");

export const stagesOf = (g: Pick<Generation, "kind">) => isSupportedJobKind(g.kind) ? STAGES_BY_KIND[g.kind] : STAGES;
export const stageInfo = (id: string | null, g?: Pick<Generation, "kind">) => {
  const list = g ? stagesOf(g) : STAGES;
  return list.find((s) => s.id === id) ?? list[0];
};
export const stageIndex = (id: string | null, g?: Pick<Generation, "kind">) =>
  Math.max(0, (g ? stagesOf(g) : STAGES).findIndex((s) => s.id === id));

/** Progress of the current stage, when its node reports steps (samplers, decoders). */
/** "Загрузка 40 с · Проход 1 2 мин · …" — where the time of a finished job went. */
export function timeBreakdown(g: Generation): string {
  const secs = g.info?.stage_seconds;
  if (!secs) return "";
  const fmt = (s: number) => (s < 60 ? `${Math.round(s)} с` : `${Math.floor(s / 60)} мин ${Math.round(s % 60)} с`);
  const parts = Object.entries(secs)
    .filter(([, s]) => s >= 1)
    .map(([id, s]) => `${id === "prepare" ? "Подготовка" : stageInfo(id, g).short} ${fmt(s)}`);
  if (g.info?.cold) parts.push("модели грузились с диска — в среднее время не идёт");
  return parts.join(" · ");
}

export function stepProgress(g: Generation): { value: number; max: number; pct: number } | null {
  const s = g.step;
  if (!s || !s.max) return null;
  return { ...s, pct: Math.round((s.value / s.max) * 100) };
}

/** Human summary of H3FaceTrackCrop's report. */
export function trackSummary(report: string | undefined): { found: string; size?: string; warn?: string } | null {
  if (!report) return null;
  const frames = report.match(/frames=(\d+)\s+face=(\d+)/);
  const height = report.match(/face height\s+min=(\d+)px\s+mean=(\d+)px/);
  const mag = report.match(/magnification[^:]*:\s*min=([\d.]+)x\s+mean=([\d.]+)x/);
  const lost = report.match(/lost:\s*(\d+)/);
  if (!frames) return null;
  const [total, face] = [Number(frames[1]), Number(frames[2])];
  return {
    found: `Лицо найдено на ${face} из ${total} кадров`,
    size: height ? `размер лица ~${height[2]} px${mag ? ` · увеличение ×${Number(mag[2]).toFixed(1)}` : ""}` : undefined,
    warn:
      lost && Number(lost[1]) > 0
        ? `Лицо потеряно на ${lost[1]} кадрах — там останется оригинал`
        : face < total
          ? `На ${total - face} кадрах лицо не найдено — там останется оригинал`
          : mag && Number(mag[1]) < 1
            ? "Лицо в кадре и так крупное — заметного улучшения может не быть"
            : undefined,
  };
}
