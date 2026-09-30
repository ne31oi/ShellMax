import { useState } from "react";
import { urls } from "../../api/client";
import type { Generation } from "../../api/types";
import { useUI } from "../../store/ui";
import { Button, Select } from "../ui";
import { CompareView } from "../viewer/CompareView";

const ready = (g: Generation) => ["done", "draft_only"].includes(g.status) && (g.output_asset_id != null || g.draft_asset_id != null);
const assetId = (g: Generation) => g.output_asset_id ?? g.draft_asset_id!;
const takeLabel = (g: Generation) => `#${g.id} · ${g.status === "draft_only" ? "черновик" : "финал"}`;

function TakeFacts({ take }: { take: Generation }) {
  const p = take.ui_params;
  return <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] text-muted">
    <dt>Seed</dt><dd className="text-fg">{take.seed}</dd>
    <dt>Профиль</dt><dd className="text-fg">{take.profile_name}</dd>
    <dt>Качество</dt><dd className="text-fg">{p.quality}</dd>
    <dt>Длительность</dt><dd className="text-fg">{p.duration} с</dd>
    <dt>Формат</dt><dd className="text-fg">{p.aspect}</dd>
    <dt>Подача</dt><dd className="text-fg">{p.look || "—"}</dd>
  </dl>;
}

export function ShotTakes({ selected, current, alternatives, blocked, onSelect, onGenerate }: {
  selected?: Generation; current: Generation[]; alternatives: Generation[]; blocked: boolean;
  onSelect: (id: number) => void; onGenerate: () => void;
}) {
  const [compareId, setCompareId] = useState<number | null>(null);
  const other = alternatives.find((g) => g.id === compareId && ready(g) && g.id !== selected?.id);
  const peers = selected ? alternatives.filter((g) => g.id !== selected.id && ready(g)) : [];
  return <div className="space-y-2">
    {current.length > 0 && <Select label="Дубль для блока" value={String(selected?.id ?? "")}
      options={[{ value: "", label: "Нет готового дубля" }, ...current.filter(ready).map((g) => ({ value: String(g.id), label: takeLabel(g) }))]}
      onChange={(v) => { if (v) { onSelect(Number(v)); setCompareId(null); } }} />}
    {current.filter((g) => !ready(g)).map((g) => <p key={g.id} className="text-[11px] text-muted">Дубль #{g.id}: {g.status === "error" ? g.error : g.status === "cancelled" ? "остановлен" : "в обработке"}</p>)}
    {selected && <>
      {peers.length > 0 && <Select label="Сравнить с дублем" value={String(other?.id ?? "")}
        options={[{ value: "", label: "Только выбранный" }, ...peers.map((g) => ({ value: String(g.id), label: takeLabel(g) }))]}
        onChange={(v) => setCompareId(v ? Number(v) : null)} />}
      {other ? <>
        <div className="h-80 overflow-hidden rounded-lg border border-line"><CompareView a={{ id: assetId(selected) }} b={{ id: assetId(other) }} labelA={takeLabel(selected)} labelB={takeLabel(other)} onClose={() => setCompareId(null)} closeLabel="Закрыть A/B" /></div>
        <div className="grid grid-cols-2 gap-3 rounded-lg bg-raised p-3"><div><p className="mb-2 text-xs font-medium">{takeLabel(selected)} · выбран</p><TakeFacts take={selected} /></div><div><p className="mb-2 text-xs font-medium">{takeLabel(other)}</p><TakeFacts take={other} /></div></div>
        {current.some((g) => g.id === other.id) && <Button size="sm" variant="outline" disabled={blocked} onClick={() => { onSelect(other.id); setCompareId(selected.id); }}>Выбрать дубль #{other.id} для блока</Button>}
      </> : <video controls muted className="max-h-72 w-full rounded-lg" src={urls.assetFile(assetId(selected))} />}
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" disabled={blocked} onClick={() => useUI.getState().openFaceDialog({ assetId: assetId(selected) })}>Улучшить лицо</Button>
        <Button size="sm" variant="ghost" disabled={blocked} onClick={() => useUI.getState().openEnhanceDialog({ assetId: assetId(selected) })}>Детализация SeedVR2</Button>
      </div>
    </>}
    <Button size="sm" variant="ghost" disabled={blocked} onClick={onGenerate}>Новый дубль этого кадра</Button>
  </div>;
}
