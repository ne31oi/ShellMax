import type { Generation } from "../../api/types";
import { useUI } from "../../store/ui";
import { Button } from "../ui";

/** Artifact jobs finish without a playable MediaAsset. */
export function JobResultEmpty({ gen }: { gen: Generation }) {
  if (gen.kind === "mask_track" && gen.status === "done") return <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
    <h2 className="text-lg">Маска SAM готова</h2>
    <p className="text-sm text-muted">Объект найден на {gen.info?.mask?.hit ?? 0} из {gen.info?.mask?.frames ?? 0} кадров. Проверьте маску перед перерисовкой.</p>
    <Button onClick={() => gen.source_asset_id && useUI.getState().openMaskEditDialog({ assetId: gen.source_asset_id, fromGenerationId: gen.id })}>Посмотреть маску</Button>
  </div>;
  if (gen.kind === "refmod_create" && gen.status === "done") return <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
    <h2 className="text-lg">RefMod создан</h2>
    <p className="text-sm text-muted">{String(gen.full_params?.label ?? "Готовый референс")}</p>
    <Button onClick={() => useUI.getState().openRefmods(true)}>Выбрать в библиотеке RefMods</Button>
  </div>;
  return <div className="flex h-full items-center justify-center text-muted">Генерация отменена</div>;
}
