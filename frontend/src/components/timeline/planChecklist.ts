import { isH3Aligned, nearestH3Duration } from "../../lib/planH3";
import { audioTracks, planTracks, type Plan, type TimelineDoc } from "../../store/timeline";

export function previousPlanByTime(doc: TimelineDoc, plan: Plan): Plan | null {
  const all = planTracks(doc)
    .flatMap((t) => t.plans)
    .filter((p) => p.id !== plan.id && p.start + p.duration <= plan.start + 0.01)
    .sort((a, b) => b.start + b.duration - (a.start + a.duration));
  return all.find((p) => p.outputAssetId || p.draftAssetId) ?? null;
}

export function buildChecklist(doc: TimelineDoc, plan: Plan): string[] {
  const out: string[] = [];
  if (!plan.prompt.trim()) out.push("Пустой бриф");
  const enabledAudio = audioTracks(doc).filter((t) => plan.audio[t.id] !== false && !t.muted);
  let audioHits = 0;
  for (const t of enabledAudio) {
    for (const c of t.clips) {
      const a0 = c.start ?? 0;
      const a1 = a0 + Math.max(0, c.out - c.in);
      if (Math.min(plan.start + plan.duration, a1) - Math.max(plan.start, a0) >= 0.2) audioHits++;
    }
  }
  if (audioHits > 3) out.push(`Аудио пересечений: ${audioHits} (лимит 3)`);
  if (plan.lipsync && audioHits === 0) out.push("Липсинг включён, но нет пересечения с A-треком");
  if (audioHits > 0 && !/<Audio\s+\d+>/i.test(plan.prompt)) {
    out.push("A-трек пересекается — в промпт добавятся метки <Audio N> при постановке в очередь");
  }
  if (!isH3Aligned(plan.duration)) out.push(`Длительность вне сетки H3 (→ ${nearestH3Duration(plan.duration).toFixed(2)} с)`);
  return out;
}
