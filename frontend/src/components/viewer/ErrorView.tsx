import { AlertCircle } from "lucide-react";
import type { Generation } from "../../api/types";
import * as actions from "../../lib/actions";
import { useUI } from "../../store/ui";
import { Button, ErrorMessage } from "../ui";

export function ErrorView({ gen }: { gen: Generation }) {
  const openSettings = useUI((s) => s.openSettings);
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md rounded-2xl border border-bad/30 bg-bad/5 p-5">
        <div className="mb-2 flex items-center gap-2 text-bad">
          <AlertCircle size={18} />
          <span className="font-semibold">Не получилось</span>
        </div>
        {gen.error && <ErrorMessage text={gen.error} />}
        <div className="mt-4 flex flex-wrap gap-2">
          {gen.error_kind === "oom" && (gen.kind === "generate" || gen.kind === "generate_nvfp4" || gen.kind === "generate_nvfp4_fast") && (
            <>
              <Button size="sm" variant="primary" onClick={() => actions.fixes.lowerQuality(gen)}>Снизить качество</Button>
              <Button size="sm" onClick={() => actions.fixes.enableLowVram().then(() => actions.retry(gen, true))}>Включить экономию VRAM и повторить</Button>
            </>
          )}
          {gen.error_kind === "oom" && gen.kind === "enhance" && gen.source_asset_id && (
            <>
              <Button size="sm" variant="primary" onClick={() => useUI.getState().openEnhanceDialog({ assetId: gen.source_asset_id! })}>
                Уменьшить масштаб и повторить
              </Button>
              <Button size="sm" onClick={() => actions.fixes.enableLowVram().then(() => actions.retry(gen, true))}>
                Включить экономию VRAM и повторить
              </Button>
            </>
          )}
          {gen.error_kind === "oom" && gen.kind === "face" && (
            <Button size="sm" onClick={() => actions.fixes.enableLowVram().then(() => actions.retry(gen, true))}>
              Включить экономию VRAM и повторить
            </Button>
          )}
          {gen.error_kind === "missing_file" && (
            <Button size="sm" variant="primary" onClick={() => openSettings("engine")}>Открыть настройки движка</Button>
          )}
          {gen.error_kind === "engine_down" && (
            <Button size="sm" variant="primary" onClick={() => openSettings("system")}>Состояние движка</Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => actions.retry(gen, true)}>Повторить</Button>
        </div>
      </div>
    </div>
  );
}
