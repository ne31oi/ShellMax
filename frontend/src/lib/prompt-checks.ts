import type { RefItem } from "../api/types";
import { REF_TOKEN, referenceTargets, tagOf, toModelPrompt } from "./refs";

export interface PromptIssue {
  code: string;
  level: "error" | "warning";
  message: string;
  section?: string;
}

const REQUIRED = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"];
const HEADERS = /^(subject_definitions|summary|retention_analysis|detailed_description|visual_style|overall_soundscape|non_diegetic_music)\s*:\s*/gim;
const MEDIA_TAG = /<(Picture|Video|Audio)\s+(\d+)\s*>/gi;
const SUBJECT = /<Subject\s+(\d+)\s*>/gi;

export function promptSections(text: string): Map<string, string> {
  const matches = [...text.matchAll(HEADERS)];
  return new Map(matches.map((m, i) => [m[1].toLowerCase(), text.slice(m.index! + m[0].length, matches[i + 1]?.index ?? text.length).trim()]));
}

/** Checks syntax and cross-links, never rewrites creative decisions. */
export function checkPrompt(prompt: string, refs: RefItem[], duration: number): PromptIssue[] {
  if (!prompt.trim()) return [];
  const issues: PromptIssue[] = [];
  const add = (code: string, level: PromptIssue["level"], message: string, section?: string) => {
    if (!issues.some((i) => i.code === code && i.message === message)) issues.push({ code, level, message, section });
  };
  for (const m of prompt.matchAll(REF_TOKEN)) {
    if (!tagOf(refs, m[1], m[2] ? "audio" : undefined))
      add("missing-reference", "error", m[2] ? "Звуковая дорожка референса отключена или удалена. Включите звук на карточке либо уберите ссылку." : "Референс удалён. Добавьте его заново либо уберите ссылку.");
  }
  const text = toModelPrompt(prompt, refs);
  const targets = referenceTargets(refs);
  const cited = new Set([...text.matchAll(MEDIA_TAG)].map((m) => `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${Number(m[2])}`));
  for (const tag of cited) {
    if (!targets.some((t) => t.tag === tag)) add("unknown-reference", "error", `Нет референса для <${tag}>. Добавьте файл либо замените метку.`);
  }
  const structured = [...text.matchAll(HEADERS)].length > 0;
  if (!structured) return issues;
  for (const t of targets) {
    if (!cited.has(t.tag)) add("unused-reference", "warning", `<${t.tag}> подключён, но не упомянут. Укажите его роль в промпте либо уберите референс.`, "subject_definitions");
  }
  const sections = promptSections(text);
  const headers = [...text.matchAll(HEADERS)].map((m) => m[1].toLowerCase());
  for (const name of REQUIRED) {
    if (!sections.has(name)) add("missing-section", "error", `Добавьте раздел ${name}.`, name);
    else if (!sections.get(name)?.trim()) add("empty-section", "warning", `Раздел ${name} пуст. Опишите его либо укажите N/A, если он неприменим.`, name);
  }
  for (const name of new Set(headers)) {
    if (headers.filter((h) => h === name).length > 1) add("duplicate-section", "error", `Раздел ${name} повторяется. Объедините его содержимое.`, name);
  }
  const order = [...REQUIRED.slice(0, 4), "visual_style", ...REQUIRED.slice(4)];
  if (headers.some((h, i) => i > 0 && order.indexOf(h) < order.indexOf(headers[i - 1])))
    add("section-order", "error", "Восстановите порядок разделов: субъекты → краткое описание → сохранение → действие → стиль → звук → музыка.");

  const detail = sections.get("detailed_description") ?? "";
  const shots = [...detail.matchAll(/\[Shot\s+(\d+)\]\s*(?:at\s+(\d+):(\d{2})\.(\d{3}))?/gi)];
  if (!shots.length) add("missing-shot", "warning", "Начните действие с [Shot 1].", "detailed_description");
  let previousTime = 0;
  shots.forEach((m, i) => {
    const number = Number(m[1]);
    if (number !== i + 1) add("shot-order", "warning", `Ожидался [Shot ${i + 1}], найден [Shot ${number}]. Проверьте нумерацию.`, "detailed_description");
    if (number === 1 && m[2]) add("first-shot-time", "warning", "У [Shot 1] не должно быть времени склейки — он начинается с начала видео.", "detailed_description");
    if (number > 1) {
      if (!m[2]) add("missing-cut", "warning", `У [Shot ${number}] нет времени склейки. Формат: At 00:02.000.`, "detailed_description");
      else {
        const seconds = Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
        if (Number(m[3]) >= 60) add("invalid-cut", "error", `У [Shot ${number}] неверное число секунд. Используйте MM:SS.mmm.`, "detailed_description");
        if (seconds <= previousTime) add("cut-order", "error", `Время [Shot ${number}] должно быть позже предыдущей склейки.`, "detailed_description");
        if (Number.isFinite(duration) && seconds >= duration) add("cut-duration", "error", `[Shot ${number}] начинается после конца видео (${duration.toFixed(2)} с). Измените тайминг или длительность.`, "detailed_description");
        else if (Number.isFinite(duration) && duration - seconds < 2) add("short-ending", "warning", `После [Shot ${number}] остаётся меньше 2 секунд. Проверьте, успеет ли завершиться действие.`, "detailed_description");
        previousTime = seconds;
      }
    }
  });

  const definitions = sections.get("subject_definitions") ?? "";
  const declared = new Set([...definitions.matchAll(/^\s*<Subject\s+(\d+)\s*>/gim)].map((m) => Number(m[1])));
  const used = new Set([...text.matchAll(SUBJECT)].map((m) => Number(m[1])));
  for (const n of used) {
    if (!declared.has(n)) add("undefined-subject", "warning", `Определите <Subject ${n}> в subject_definitions.`, "subject_definitions");
  }
  const retention = sections.get("retention_analysis") ?? "";
  const retained = new Set([...retention.matchAll(SUBJECT)].map((m) => Number(m[1])));
  for (const n of declared) {
    if (!retained.has(n)) add("missing-retention", "warning", `Для <Subject ${n}> не указано, что сохранять в retention_analysis.`, "retention_analysis");
  }
  let depth = 0;
  for (const m of text.matchAll(/<\/?d>/gi)) {
    if (m[0].toLowerCase() === "<d>") {
      if (depth) add("dialogue-nested", "error", "Реплики <d> не должны вкладываться друг в друга.", "overall_soundscape");
      depth++;
    } else if (!depth) add("dialogue-order", "error", "Есть </d> без начала реплики <d>.", "overall_soundscape");
    else depth--;
  }
  if (depth) add("dialogue-unclosed", "error", "Закройте реплику тегом </d>.", "overall_soundscape");
  for (const m of text.matchAll(/<d>([\s\S]*?)<\/d>/gi)) {
    if (!/^\s*\[[A-Za-z][A-Za-z -]*\]/.test(m[1])) add("dialogue-language", "warning", "Укажите язык в начале реплики: <d>[Russian] Текст</d>.", "overall_soundscape");
  }
  return issues.sort((a, b) => Number(b.level === "error") - Number(a.level === "error"));
}
