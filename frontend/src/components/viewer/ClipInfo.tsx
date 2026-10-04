import {
  Copy, Dices, Gauge, Pencil, ScanFace, Sparkles, SplitSquareHorizontal,
} from "lucide-react";
import { useState } from "react";
import type { FaceStrength, Generation } from "../../api/types";
import * as actions from "../../lib/actions";
import { isSupportedJobKind, timeBreakdown, trackSummary } from "../../lib/stages";
import { fmtDuration } from "../../lib/format";
import { useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { Button, Dialog, Kbd } from "../ui";

const EMPTY_FACE_STRENGTH: FaceStrength[] = [];

export function ClipInfo({
  gen,
  comparing,
  canToggleCompare,
  onToggleCompare,
}: {
  gen: Generation;
  comparing?: boolean;
  canToggleCompare?: boolean;
  onToggleCompare?: () => void;
}) {
  if (gen.kind === "face") {
    return (
      <FaceClipInfo
        gen={gen}
        comparing={comparing}
        canToggleCompare={canToggleCompare}
        onToggleCompare={onToggleCompare}
      />
    );
  }
  if (gen.kind === "enhance") {
    return (
      <EnhanceClipInfo
        gen={gen}
        comparing={comparing}
        canToggleCompare={canToggleCompare}
        onToggleCompare={onToggleCompare}
      />
    );
  }
  if (gen.kind === "interpolate") {
    return (
      <InterpolateClipInfo
        gen={gen}
        comparing={comparing}
        canToggleCompare={canToggleCompare}
        onToggleCompare={onToggleCompare}
      />
    );
  }
  return <GenerationClipInfo gen={gen} comparing={comparing} canToggleCompare={canToggleCompare} onToggleCompare={onToggleCompare} />;
}

export function CompareToggle({
  comparing,
  canToggle,
  onToggle,
}: {
  comparing?: boolean;
  canToggle?: boolean;
  onToggle?: () => void;
}) {
  if (!canToggle || !onToggle) return null;
  return (
    <Button
      size="sm"
      variant={comparing ? "subtle" : "ghost"}
      onClick={onToggle}
      title={comparing ? "Показать только результат" : "Сравнить с исходником"}
    >
      <SplitSquareHorizontal size={13} />
      {comparing ? "Только результат" : "Сравнить"}
    </Button>
  );
}

export function EnhanceClipInfo({
  gen,
  comparing,
  canToggleCompare,
  onToggleCompare,
}: {
  gen: Generation;
  comparing?: boolean;
  canToggleCompare?: boolean;
  onToggleCompare?: () => void;
}) {
  const source = useLibrary((s) => (gen.source_asset_id ? s.assets[gen.source_asset_id] : undefined));
  const scale = gen.ui_params.scale ?? 1;
  const strength = gen.ui_params.strength ?? 0.55;
  const color = gen.ui_params.color_correction ?? "lab";
  const strengthLabel =
    useLibrary((s) => s.meta?.enhance_strength?.find((p) => p.strength === strength)?.label)
    ?? `${Math.round(strength * 100)}%`;
  const colorLabel =
    useLibrary((s) => s.meta?.enhance_color?.find((c) => c.id === color)?.label) ?? color;
  return (
    <div className="border-t border-line bg-panel px-4 py-2.5">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1 text-xs leading-relaxed text-muted">
          <p className="text-fg">
            <Sparkles size={13} className="mr-1 inline text-accent" />
            Детализация SeedVR2{source ? ` · «${source.name}»` : ""}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <CompareToggle comparing={comparing} canToggle={canToggleCompare} onToggle={onToggleCompare} />
          {gen.status === "done" && source && (
            <Button size="sm" variant="ghost" onClick={() => useUI.getState().selectAsset(source.id)} title="Открыть исходный клип">
              Исходник
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => actions.retry(gen, false)} title="Ещё одна попытка с другим сидом">
            <Dices size={13} /> Ещё раз
          </Button>
          <Button size="sm" variant="ghost" onClick={() => actions.editAndRetry(gen)}>
            <Pencil size={13} /> Изменить
          </Button>
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-faint tabular-nums">
        <span>#{gen.id}</span>
        <span>×{scale}</span>
        <span>{strengthLabel}</span>
        <span>{colorLabel}</span>
        <span>сид {gen.seed}</span>
        {gen.elapsed_s && <span title={timeBreakdown(gen)}>готово за {fmtDuration(gen.elapsed_s)}</span>}
      </div>
    </div>
  );
}

export function InterpolateClipInfo({
  gen,
  comparing,
  canToggleCompare,
  onToggleCompare,
}: {
  gen: Generation;
  comparing?: boolean;
  canToggleCompare?: boolean;
  onToggleCompare?: () => void;
}) {
  const source = useLibrary((s) => (gen.source_asset_id ? s.assets[gen.source_asset_id] : undefined));
  const model = gen.ui_params.model === "film" ? "film" : "rife";
  const multiplier = gen.ui_params.multiplier ?? 2;
  const modelLabel =
    useLibrary((s) => s.meta?.interpolate_model?.find((c) => c.id === model)?.label) ??
    (model === "film" ? "FILM" : "RIFE");
  return (
    <div className="border-t border-line bg-panel px-4 py-2.5">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1 text-xs leading-relaxed text-muted">
          <p className="text-fg">
            <Gauge size={13} className="mr-1 inline text-accent" />
            Интерполяция{source ? ` · «${source.name}»` : ""}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <CompareToggle comparing={comparing} canToggle={canToggleCompare} onToggle={onToggleCompare} />
          {gen.status === "done" && source && (
            <Button size="sm" variant="ghost" onClick={() => useUI.getState().selectAsset(source.id)} title="Открыть исходный клип">
              Исходник
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => actions.retry(gen, false)} title="Повторить">
            <Dices size={13} /> Ещё раз
          </Button>
          <Button size="sm" variant="ghost" onClick={() => actions.editAndRetry(gen)}>
            <Pencil size={13} /> Изменить
          </Button>
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-faint tabular-nums">
        <span>#{gen.id}</span>
        <span>{modelLabel}</span>
        <span>×{multiplier}</span>
        {gen.elapsed_s && <span title={timeBreakdown(gen)}>готово за {fmtDuration(gen.elapsed_s)}</span>}
      </div>
    </div>
  );
}

export function FaceClipInfo({
  gen,
  comparing,
  canToggleCompare,
  onToggleCompare,
}: {
  gen: Generation;
  comparing?: boolean;
  canToggleCompare?: boolean;
  onToggleCompare?: () => void;
}) {
  const source = useLibrary((s) => (gen.source_asset_id ? s.assets[gen.source_asset_id] : undefined));
  const presets = useLibrary((s) => s.meta?.face_strength) ?? EMPTY_FACE_STRENGTH;
  const preset = presets.find((p) => Math.abs(p.denoise - (gen.ui_params.denoise ?? 0)) < 1e-6);
  const t = trackSummary(gen.info?.track_report);
  return (
    <div className="border-t border-line bg-panel px-4 py-2.5">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1 text-xs leading-relaxed text-muted">
          <p className="text-fg">
            <ScanFace size={13} className="mr-1 inline text-accent" />
            Улучшение лица{source ? ` · «${source.name}»` : ""}
          </p>
          {t && (
            <p className={t.warn ? "text-warn" : ""}>
              {t.found}
              {t.warn ? ` · ${t.warn}` : t.size ? ` · ${t.size}` : ""}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <CompareToggle comparing={comparing} canToggle={canToggleCompare} onToggle={onToggleCompare} />
          {gen.status === "done" && source && (
            <Button size="sm" variant="ghost" onClick={() => useUI.getState().selectAsset(source.id)} title="Открыть исходный клип">
              Исходник
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => actions.retry(gen, false)} title="Ещё одна попытка с другим сидом">
            <Dices size={13} /> Ещё раз
          </Button>
          <Button size="sm" variant="ghost" onClick={() => actions.editAndRetry(gen)}>
            <Pencil size={13} /> Изменить
          </Button>
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-faint tabular-nums">
        <span>#{gen.id}</span>
        <span>сила: {preset?.label ?? gen.ui_params.denoise}</span>
        <span>сид {gen.seed}</span>
        {gen.elapsed_s && <span title={timeBreakdown(gen)}>готово за {fmtDuration(gen.elapsed_s)}</span>}
      </div>
    </div>
  );
}

export function GenerationClipInfo({ gen, comparing, canToggleCompare, onToggleCompare }: {
  gen: Generation; comparing?: boolean; canToggleCompare?: boolean; onToggleCompare?: () => void;
}) {
  const styles = useLibrary((s) => s.styles);
  const quality = useLibrary((s) => s.meta?.quality.find((q) => q.id === gen.ui_params.quality));
  const p = gen.ui_params;
  const aspect = p.aspect;
  const res = aspect && quality?.resolutions?.[aspect]?.final;
  const styleNames = (p.styles ?? []).map((st) => styles.find((s) => s.id === st.style_id)?.name).filter(Boolean);
  const [promptOpen, setPromptOpen] = useState(false);
  // Exact prompt sent to ComfyUI (style triggers / look already applied)
  const prompt = (typeof gen.full_params?.prompt === "string" ? gen.full_params.prompt : p.prompt)?.trim() ?? "";

  return (
    <div className="border-t border-line bg-panel px-4 py-2.5">
      <div className="flex items-start gap-4">
        {prompt ? (
          <button
            type="button"
            onClick={() => setPromptOpen(true)}
            className="line-clamp-2 min-w-0 flex-1 text-left text-xs leading-relaxed text-muted hover:text-fg"
            title="Промпт, ушедший в генерацию"
          >
            {prompt}
          </button>
        ) : (
          <p className="min-w-0 flex-1 text-xs text-faint">Без промпта</p>
        )}
        <div className="flex shrink-0 gap-1">
          <CompareToggle comparing={comparing} canToggle={canToggleCompare} onToggle={onToggleCompare} />
          {prompt && (
            <Button size="sm" variant="ghost" onClick={() => setPromptOpen(true)} title="Промпт генерации">
              Промпт
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={!isSupportedJobKind(gen.kind)} onClick={() => actions.retry(gen, false)} title="Повторить с новым сидом">
            <Dices size={13} /> Ещё раз
          </Button>
          <Button size="sm" variant="ghost" disabled={!isSupportedJobKind(gen.kind)} onClick={() => actions.retry(gen, true)} title="Тот же сид — тот же результат">
            <Copy size={13} /> Точно
          </Button>
          <Button size="sm" variant="ghost" disabled={!isSupportedJobKind(gen.kind)} onClick={() => actions.editAndRetry(gen)}>
            <Pencil size={13} /> Изменить
          </Button>
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-faint tabular-nums">
        <span>#{gen.id}</span>
        {aspect && <span>{aspect.split(" ")[0]}</span>}
        {res && <span>{res[0]}×{res[1]}</span>}
        {quality?.label && <span>{quality.label}</span>}
        <span>сид {gen.seed}</span>
        {styleNames.length > 0 && <span>стиль: {styleNames.join(", ")}</span>}
        {(p.refs?.length ?? 0) > 0 && <span>референсов: {p.refs!.length}</span>}
        {gen.elapsed_s && <span title={timeBreakdown(gen)}>создано за {fmtDuration(gen.elapsed_s)}</span>}
        <span className="ml-auto hidden xl:inline">
          <Kbd>Пробел</Kbd> пуск · <Kbd>←</Kbd>
          <Kbd>→</Kbd> кадр · <Kbd>F</Kbd> экран
        </span>
      </div>
      <PromptDialog open={promptOpen} onOpenChange={setPromptOpen} prompt={prompt} genId={gen.id} />
    </div>
  );
}

export function PromptDialog({
  open,
  onOpenChange,
  prompt,
  genId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  prompt: string;
  genId: number;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      useUI.getState().toast("Не удалось скопировать", "bad");
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Промпт генерации · #${genId}`} wide>
      <div className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2">
          <p className="flex-1 text-[11px] text-muted">Точный текст, ушедший в граф (с триггерами стилей).</p>
          <Button size="sm" variant="outline" onClick={copy}>
            <Copy size={13} /> {copied ? "Скопировано" : "Копировать"}
          </Button>
        </div>
        <pre className="max-h-[min(70vh,32rem)] overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-raised p-3 font-mono text-[12px] leading-relaxed text-fg">
          {prompt}
        </pre>
      </div>
    </Dialog>
  );
}
