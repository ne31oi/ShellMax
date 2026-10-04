import * as ContextMenu from "@radix-ui/react-context-menu";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import clsx from "clsx";
import { Film, Gauge, Pencil, ScanFace, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { urls } from "../../api/client";
import type { MediaAsset } from "../../api/types";
import * as actions from "../../lib/actions";
import { fmtDuration } from "../../lib/format";
import { isGenerationKind } from "../../lib/stages";
import { useLibrary } from "../../store/library";
import { type Clip } from "../../store/timeline";
import { useUI } from "../../store/ui";
import { TlCtxItem } from "./TlCtxItem";
import { MIN_CLIP } from "./timelineConstants";

export function armTimelineReplace(clipId: string, assetId: number) {
  useUI.getState().setTimelineReplace({ clipId, expectSourceAssetId: assetId });
  useUI.getState().toast("После готовности клип на таймлайне обновится сам", "info");
}

export function ClipBlock({
  clip,
  asset,
  selected,
  onSelect,
  tall,
  scale,
  onTrim,
  onRemove,
  absolute,
}: {
  clip: Clip;
  asset?: MediaAsset;
  selected: boolean;
  onSelect: () => void;
  tall: boolean;
  scale: number;
  onTrim: (inn: number, out: number) => void;
  onRemove: () => void;
  absolute?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: clip.id });
  const [draft, setDraft] = useState<{ in: number; out: number } | null>(null);
  const shown = draft ?? { in: clip.in, out: clip.out };
  const width = absolute ? "100%" : Math.max(56, (shown.out - shown.in) * scale);
  const srcDur = Math.max(clip.out, asset?.duration ?? clip.out);
  const generations = useLibrary((s) => s.generations);
  const gen = asset?.generation_id != null ? generations[asset.generation_id] : undefined;
  void tall;

  const dragEdge = (e: React.PointerEvent, which: "in" | "out") => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const in0 = clip.in;
    const out0 = clip.out;
    let lastIn = in0;
    let lastOut = out0;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / scale;
      if (which === "in") {
        lastIn = Math.max(0, Math.min(out0 - MIN_CLIP, in0 + dx));
        lastOut = out0;
      } else {
        lastIn = in0;
        lastOut = Math.min(srcDur, Math.max(in0 + MIN_CLIP, out0 + dx));
      }
      setDraft({ in: lastIn, out: lastOut });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDraft(null);
      if (lastIn !== in0 || lastOut !== out0) onTrim(lastIn, lastOut);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const block = (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, width, height: "100%" }}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      className={clsx(
        "relative overflow-hidden rounded-md bg-raised ring-1",
        absolute ? "h-full w-full" : "shrink-0",
        selected ? "ring-2 ring-accent" : "ring-line hover:ring-line-strong",
      )}
    >
      {asset?.thumb && (
        <div
          className="pointer-events-none absolute inset-0 opacity-80"
          style={{
            backgroundImage: `url(${urls.assetThumb(asset.id)})`,
            backgroundSize: "auto 100%",
            backgroundRepeat: "repeat-x",
          }}
        />
      )}
      <span className="pointer-events-none absolute bottom-0.5 left-1 max-w-[90%] truncate rounded bg-black/70 px-1 text-[10px] text-white">
        {asset?.name ?? "клип"} · {fmtDuration(shown.out - shown.in)}
      </span>
      <div
        className="absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize bg-accent/0 hover:bg-accent/80"
        onPointerDown={(e) => {
          e.stopPropagation();
          dragEdge(e, "in");
        }}
        onClick={(e) => e.stopPropagation()}
      />
      <div
        className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize bg-accent/0 hover:bg-accent/80"
        onPointerDown={(e) => {
          e.stopPropagation();
          dragEdge(e, "out");
        }}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );

  if (!asset) return block;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{block}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-40 min-w-56 rounded-xl border border-line bg-panel p-1 shadow-2xl">
          <TlCtxItem
            icon={ScanFace}
            onSelect={() => {
              armTimelineReplace(clip.id, asset.id);
              useUI.getState().openFaceDialog({ assetId: asset.id });
            }}
          >
            Улучшить лицо…
          </TlCtxItem>
          <TlCtxItem
            icon={Sparkles}
            onSelect={() => {
              armTimelineReplace(clip.id, asset.id);
              useUI.getState().openEnhanceDialog({ assetId: asset.id });
            }}
          >
            Детализация (SeedVR2)…
          </TlCtxItem>
          <TlCtxItem
            icon={Gauge}
            onSelect={() => {
              armTimelineReplace(clip.id, asset.id);
              useUI.getState().openInterpolateDialog({ assetId: asset.id });
            }}
          >
            Интерполяция (RIFE)…
          </TlCtxItem>
          <ContextMenu.Separator className="my-1 h-px bg-line" />
          <TlCtxItem
            icon={Pencil}
            disabled={!gen}
            onSelect={() => {
              if (!gen) {
                useUI.getState().toast("Нет связанной генерации — только для клипов из студии", "info");
                return;
              }
              void actions.editAndRetry(gen);
            }}
          >
            Изменить и повторить
          </TlCtxItem>
          <TlCtxItem
            icon={Film}
            disabled={!gen || !isGenerationKind(gen.kind)}
            onSelect={() => {
              if (gen) void actions.retry(gen, false);
            }}
          >
            Повторить с новым сидом
          </TlCtxItem>
          <ContextMenu.Separator className="my-1 h-px bg-line" />
          <TlCtxItem icon={Trash2} danger onSelect={onRemove}>
            Убрать с таймлайна
          </TlCtxItem>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

