import * as ContextMenu from "@radix-ui/react-context-menu";
import clsx from "clsx";
import {
  AlertCircle, AudioLines, Copy, Dices, Film, FolderOpen, Gauge, ImagePlus, Pencil, ScanFace, Shuffle,
  Sparkles, SplitSquareHorizontal, Square, Trash2, Volume2,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { api, urls } from "../../api/client";
import type { Generation, MediaAsset, Upload } from "../../api/types";
import * as actions from "../../lib/actions";
import { fmtDuration, fmtEstimate } from "../../lib/format";
import { KIND_LABEL, promptTitle } from "../../lib/refs";
import { isSupportedJobKind, stageInfo, stepProgress, timeBreakdown } from "../../lib/stages";
import { useElapsed } from "../../lib/useElapsed";
import { recentFamilyInUse, useForm } from "../../store/form";
import { generationOwningAsset, useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { ASSET_DRAG_TYPE } from "../generate/RefsZone";

function useHoverScrub() {
  const video = useRef<HTMLVideoElement>(null);
  const [hover, setHover] = useState(false);
  return {
    video,
    hover,
    bind: {
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      onMouseMove: (e: React.MouseEvent) => {
        const v = video.current;
        if (!v || !v.duration) return;
        const r = e.currentTarget.getBoundingClientRect();
        v.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * v.duration;
      },
    },
  };
}

function Thumb({ asset, preview, children }: { asset?: MediaAsset; preview?: string; children?: ReactNode }) {
  const { video, hover, bind } = useHoverScrub();
  return (
    <div className="relative aspect-video overflow-hidden rounded-lg bg-raised" {...bind}>
      {asset?.thumb ? (
        <img src={urls.assetThumb(asset.id)} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : preview ? (
        <img src={preview} alt="" className="h-full w-full object-cover blur-[0.5px]" draggable={false} />
      ) : (
        <div className="shimmer h-full w-full" />
      )}
      {hover && asset && asset.kind === "video" && (
        <video ref={video} src={urls.assetFile(asset.id)} muted preload="auto" className="absolute inset-0 h-full w-full object-cover" />
      )}
      {children}
    </div>
  );
}

function ProgressRing({ value }: { value: number }) {
  const r = 14;
  const c = 2 * Math.PI * r;
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" className="-rotate-90">
      <circle cx="18" cy="18" r={r} fill="none" stroke="rgba(255,255,255,.15)" strokeWidth="3" />
      <circle cx="18" cy="18" r={r} fill="none" stroke="var(--color-accent)" strokeWidth="3" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - value)} style={{ transition: "stroke-dashoffset .4s" }} />
    </svg>
  );
}

export function GenerationCard({ gen }: { gen: Generation }) {
  const assets = useLibrary((s) => s.assets);
  const generations = useLibrary((s) => s.generations);
  const preview = useLibrary((s) => s.previews[gen.id]);
  const selected = useUI((s) => s.selectedGen === gen.id);
  const elapsed = useElapsed(gen.status === "running" ? gen.started : null);
  const asset = actions.outputAsset(gen, assets);
  const parent = generationOwningAsset(generations, gen.source_asset_id);
  const title =
    asset?.name ?? (gen.kind === "mask_track" ? "Маска SAM" : gen.kind === "refmod_create" ? `RefMod: ${String(gen.full_params?.label ?? gen.id)}` : null) ??
    (gen.kind === "body_swap" || gen.kind === "body_swap_singularity"
      ? "Замена персонажа"
      : gen.kind === "head_swap"
      ? "Замена головы"
      : gen.kind === "face"
      ? "Улучшение лица"
      : gen.kind === "fidelity_upscale"
        ? "Бережное улучшение"
      : gen.kind === "dlss5"
        ? "Улучшение DLSS5"
      : gen.kind === "enhance"
        ? "Детализация"
        : gen.kind === "interpolate"
          ? "Интерполяция"
          : promptTitle(gen.ui_params.prompt) || `Генерация ${gen.id}`);
  const active = gen.status === "running" || gen.status === "queued";
  const canRetry = isSupportedJobKind(gen.kind);

  const card = (
    <div
      role="button"
      tabIndex={0}
      draggable={!!asset}
      onDragStart={(e) => asset && e.dataTransfer.setData(ASSET_DRAG_TYPE, JSON.stringify(asset))}
      onClick={() => useUI.getState().selectGen(gen.id)}
      onDoubleClick={() => asset && gen.status === "done" && actions.addToTimeline(asset)}
      className={clsx("group cursor-pointer rounded-xl p-1 outline-none transition-colors", selected ? "bg-accent/15 ring-1 ring-accent/60" : "hover:bg-hover")}
    >
      <Thumb asset={asset} preview={preview}>
        {gen.kind === "refmod_create" && gen.status === "done" && <div className="absolute inset-0 flex items-center justify-center bg-raised text-sm text-accent">RefMod создан</div>}
        {gen.kind === "mask_track" && gen.status === "done" && <div className="absolute inset-0 flex items-center justify-center bg-raised text-sm text-accent">Маска SAM готова</div>}
        {gen.status === "running" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/45">
            <ProgressRing value={gen.progress} />
            <span className="text-[10px] font-medium text-white/90 tabular-nums">
              {stageInfo(gen.stage, gen).short}
              {stepProgress(gen) ? ` · ${stepProgress(gen)!.pct}%` : "…"}
            </span>
            {elapsed != null && (
              <span className="text-[10px] text-white/70 tabular-nums">{fmtDuration(elapsed)}</span>
            )}
          </div>
        )}
        {gen.status === "queued" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-[11px] text-white/80">В очереди</div>
        )}
        {gen.status === "error" && (
          <div className="absolute inset-0 flex items-center justify-center bg-bad/20 text-bad">
            <AlertCircle size={20} />
          </div>
        )}
        {gen.kind === "face" && gen.status !== "running" && (
          <span className="absolute left-1 top-1 flex items-center gap-0.5 rounded bg-accent px-1 text-[10px] font-semibold text-accent-fg">
            <ScanFace size={10} /> лицо
          </span>
        )}
        {(gen.kind === "enhance" || gen.kind === "fidelity_upscale" || gen.kind === "dlss5") && gen.status !== "running" && (
          <span className="absolute left-1 top-1 flex items-center gap-0.5 rounded bg-accent px-1 text-[10px] font-semibold text-accent-fg">
            <Sparkles size={10} /> {gen.kind === "dlss5" ? "DLSS5" : gen.kind === "fidelity_upscale" ? `×${gen.ui_params.scale ?? 2}` : "деталь"}
          </span>
        )}
        {gen.kind === "interpolate" && gen.status !== "running" && (
          <span className="absolute left-1 top-1 flex items-center gap-0.5 rounded bg-accent px-1 text-[10px] font-semibold text-accent-fg">
            <Gauge size={10} /> FPS
          </span>
        )}
        {gen.status === "draft_only" && (
          <span className="absolute left-1 top-1 rounded bg-warn px-1 text-[10px] font-semibold text-black">черновик</span>
        )}
        {gen.status === "running" && gen.draft_asset_id && (
          <span className="absolute left-1 top-1 rounded bg-warn px-1 text-[10px] font-semibold text-black">
            {gen.kind === "face" ? "трекинг готов" : "черновик готов"}
          </span>
        )}
        {asset?.duration != null && !active && (
          <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] text-white tabular-nums">{fmtDuration(asset.duration)}</span>
        )}
      </Thumb>
      <div className="px-1 pb-0.5 pt-1">
        <p className="truncate text-xs text-fg">{title}</p>
        <p
          className="text-[10px] text-faint tabular-nums"
          title={gen.elapsed_s != null ? timeBreakdown(gen) || `затрачено ${fmtDuration(gen.elapsed_s)}` : undefined}
        >
          #{gen.id}
          {parent ? (
            <>
              {" · "}
              <button
                type="button"
                className="text-accent hover:underline"
                title="Открыть исходный клип"
                onClick={(e) => {
                  e.stopPropagation();
                  useUI.getState().selectGen(parent.id);
                }}
              >
                из #{parent.id}
              </button>
            </>
          ) : null}
          {gen.status === "running" && gen.estimate_s ? ` · ${fmtEstimate(gen.estimate_s)}` : ""}
          {gen.elapsed_s != null && (gen.status === "done" || gen.status === "draft_only" || gen.status === "error")
            ? ` · ${fmtDuration(gen.elapsed_s)}`
            : ""}
          {gen.status === "cancelled" ? " · отменено" : ""}
        </p>
      </div>
    </div>
  );

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{card}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-40 min-w-56 rounded-xl border border-line bg-panel p-1 shadow-2xl">
          {active && <CtxItem icon={<Square size={13} />} onSelect={() => actions.cancel(gen)}>{gen.draft_asset_id ? "Остановить, оставить черновик" : "Отменить"}</CtxItem>}
          <CtxItem icon={<Dices size={13} />} disabled={!canRetry} onSelect={() => actions.retry(gen, false)}>Повторить с новым сидом</CtxItem>
          {canRetry && gen.kind !== "dlss5" && gen.kind !== "body_swap" && gen.kind !== "body_swap_singularity" && gen.kind !== "head_swap" && gen.kind !== "face" && gen.kind !== "enhance" && gen.kind !== "fidelity_upscale" && gen.kind !== "interpolate" && gen.kind !== "refmod_create" && gen.kind !== "mask_track" && (
            <>
              <CtxItem icon={<Copy size={13} />} onSelect={() => actions.retry(gen, true)}>Повторить точно (тот же сид)</CtxItem>
              <CtxItem icon={<Shuffle size={13} />} onSelect={() => actions.retry(gen, false, 4)}>Вариации ×4</CtxItem>
            </>
          )}
          <CtxItem icon={<Pencil size={13} />} disabled={!canRetry} onSelect={() => actions.editAndRetry(gen)}>Изменить и повторить</CtxItem>
          {parent && (
            <CtxItem icon={<Film size={13} />} onSelect={() => useUI.getState().selectGen(parent.id)}>
              Открыть исходный #{parent.id}
            </CtxItem>
          )}
          {asset && (
            <>
              <ContextMenu.Separator className="my-1 h-px bg-line" />
              <CtxItem icon={<ScanFace size={13} />} onSelect={() => useUI.getState().openFaceDialog({ assetId: asset.id })} disabled={gen.status !== "done"}>Улучшить лицо…</CtxItem>
              <CtxItem icon={<Sparkles size={13} />} onSelect={() => useUI.getState().openEnhanceDialog({ assetId: asset.id })} disabled={gen.status !== "done"}>Детализация (SeedVR2)…</CtxItem>
              <CtxItem icon={<ScanFace size={13} />} onSelect={() => actions.replaceHead(asset)} disabled={gen.status !== "done"}>Заменить голову (Head Swap)…</CtxItem>
              <CtxItem icon={<ScanFace size={13} />} onSelect={() => actions.replaceBody(asset)} disabled={gen.status !== "done" || asset.kind !== "video"}>Заменить персонажа (Body Swap)…</CtxItem>
              <CtxItem icon={<Sparkles size={13} />} onSelect={() => actions.upscaleFaithfully(asset)} disabled={gen.status !== "done"}>Бережное улучшение…</CtxItem>
              <CtxItem icon={<Sparkles size={13} />} onSelect={() => actions.enhanceDLSS5(asset)} disabled={gen.status !== "done" || asset.kind !== "video"}>Улучшить (DLSS5)…</CtxItem>
              <CtxItem icon={<Sparkles size={13} />} onSelect={() => useUI.getState().openMaskEditDialog({ assetId: asset.id })} disabled={gen.status !== "done"}>Изменить по маске…</CtxItem>
              <CtxItem icon={<Gauge size={13} />} onSelect={() => useUI.getState().openInterpolateDialog({ assetId: asset.id })} disabled={gen.status !== "done"}>Интерполяция (RIFE)…</CtxItem>
              <CtxItem icon={<Film size={13} />} onSelect={() => actions.addToTimeline(asset)} disabled={gen.status !== "done"}>В таймлайн (V)</CtxItem>
              <CtxItem
                icon={<Volume2 size={13} />}
                onSelect={() => actions.addToAudioTrack(asset)}
                disabled={gen.status !== "done" || (!asset.has_audio && asset.kind !== "audio")}
              >
                На аудиодорожку (A)
              </CtxItem>
              <CtxItem icon={<ImagePlus size={13} />} onSelect={() => actions.assetAsRef(asset)}>Использовать как видео-референс</CtxItem>
              <CtxItem icon={<SplitSquareHorizontal size={13} />} onSelect={() => {
                const ui = useUI.getState();
                if (ui.selectedGen && ui.selectedGen !== gen.id) ui.compare(gen.id);
                else ui.toast("Сначала выберите другой клип, затем «Сравнить» на этом", "info");
              }}>Сравнить с выбранным</CtxItem>
              <CtxItem icon={<FolderOpen size={13} />} onSelect={() => actions.reveal(asset)}>Показать в папке</CtxItem>
            </>
          )}
          <ContextMenu.Separator className="my-1 h-px bg-line" />
          <CtxItem icon={<Trash2 size={13} />} danger disabled={gen.status === "running"} onSelect={() => actions.remove(gen)}>Удалить</CtxItem>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function AssetCard({ asset }: { asset: MediaAsset }) {
  const selected = useUI((s) => s.selectedAsset === asset.id);
  const canVideo = asset.kind === "video";
  const canAudio = asset.kind === "audio" || asset.has_audio;
  const card = (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => e.dataTransfer.setData(ASSET_DRAG_TYPE, JSON.stringify(asset))}
      onClick={() => useUI.getState().selectAsset(asset.id)}
      onDoubleClick={() => {
        if (canVideo) actions.addToTimeline(asset);
        else if (canAudio) actions.addToAudioTrack(asset);
      }}
      className={clsx("cursor-pointer rounded-xl p-1 transition-colors", selected ? "bg-accent/15 ring-1 ring-accent/60" : "hover:bg-hover")}
    >
      <Thumb asset={asset}>
        <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] text-white/80">
          {asset.kind === "audio" ? "аудио" : asset.source === "exported" ? "монтаж" : "импорт"}
        </span>
      </Thumb>
      <p className="truncate px-1 pt-1 text-xs">{asset.name}</p>
    </div>
  );
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{card}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-40 min-w-56 rounded-xl border border-line bg-panel p-1 shadow-2xl">
          <CtxItem icon={<Film size={13} />} onSelect={() => actions.addToTimeline(asset)} disabled={!canVideo}>
            В таймлайн (V)
          </CtxItem>
          <CtxItem icon={<Volume2 size={13} />} onSelect={() => actions.addToAudioTrack(asset)} disabled={!canAudio}>
            На аудиодорожку (A)
          </CtxItem>
          <CtxItem icon={<ImagePlus size={13} />} onSelect={() => actions.assetAsRef(asset)}>Использовать как референс</CtxItem>
          <CtxItem icon={<ScanFace size={13} />} onSelect={() => useUI.getState().openFaceDialog({ assetId: asset.id })} disabled={!canVideo}>Улучшить лицо…</CtxItem>
          <CtxItem icon={<Sparkles size={13} />} onSelect={() => useUI.getState().openEnhanceDialog({ assetId: asset.id })} disabled={!canVideo}>Детализация (SeedVR2)…</CtxItem>
          <CtxItem icon={<ScanFace size={13} />} onSelect={() => actions.replaceHead(asset)} disabled={!canVideo}>Заменить голову (Head Swap)…</CtxItem>
          <CtxItem icon={<ScanFace size={13} />} onSelect={() => actions.replaceBody(asset)} disabled={!canVideo}>Заменить персонажа (Body Swap)…</CtxItem>
          <CtxItem icon={<Sparkles size={13} />} onSelect={() => actions.upscaleFaithfully(asset)} disabled={!canVideo}>Бережное улучшение…</CtxItem>
          <CtxItem icon={<Sparkles size={13} />} onSelect={() => actions.enhanceDLSS5(asset)} disabled={!canVideo}>Улучшить (DLSS5)…</CtxItem>
          <CtxItem icon={<Sparkles size={13} />} onSelect={() => useUI.getState().openMaskEditDialog({ assetId: asset.id })} disabled={!canVideo}>Изменить по маске…</CtxItem>
          <CtxItem icon={<Gauge size={13} />} onSelect={() => useUI.getState().openInterpolateDialog({ assetId: asset.id })} disabled={!canVideo}>Интерполяция (RIFE)…</CtxItem>
          <CtxItem icon={<FolderOpen size={13} />} onSelect={() => actions.reveal(asset)}>Показать в папке</CtxItem>
          <ContextMenu.Separator className="my-1 h-px bg-line" />
          <CtxItem icon={<Trash2 size={13} />} danger onSelect={() => actions.removeAsset(asset)}>Удалить</CtxItem>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function RefCard({ upload, onGone }: { upload: Upload; onGone: () => void }) {
  const panelRefs = useForm((s) => s.refs);
  const inPanel = recentFamilyInUse(panelRefs, upload);
  const kindLabel = KIND_LABEL[upload.kind];

  const add = async () => {
    if (inPanel) {
      useUI.getState().toast("Уже в референсах", "info");
      return;
    }
    try {
      const fresh = await api.uploadInfo(upload.id);
      actions.addUploadsAsRefs([fresh]);
    } catch {
      useUI.getState().toast("Файл больше недоступен", "bad");
      onGone();
    }
  };

  const card = (
    <div
      role="button"
      tabIndex={0}
      onClick={() => void add()}
      onDoubleClick={() => void add()}
      className={clsx(
        "cursor-pointer rounded-xl p-1 transition-colors hover:bg-hover",
        inPanel && "opacity-50",
      )}
      title={inPanel ? "Уже в референсах" : `Добавить в референсы: ${upload.orig_name}`}
    >
      <div className="relative aspect-video overflow-hidden rounded-lg bg-raised">
        {upload.kind === "audio" ? (
          <div className="flex h-full items-center justify-center text-audio">
            <AudioLines size={28} />
          </div>
        ) : (
          <img src={urls.uploadThumb(upload.id)} alt="" className="h-full w-full object-cover" draggable={false} />
        )}
        <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] text-white/80">{kindLabel}</span>
        {upload.duration != null && upload.duration > 0 && (
          <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] text-white tabular-nums">
            {fmtDuration(upload.duration)}
          </span>
        )}
      </div>
      <p className="truncate px-1 pt-1 text-xs">{upload.orig_name}</p>
    </div>
  );

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{card}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-40 min-w-56 rounded-xl border border-line bg-panel p-1 shadow-2xl">
          <CtxItem icon={<ImagePlus size={13} />} onSelect={() => void add()} disabled={inPanel}>
            В референсы
          </CtxItem>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function CtxItem({ icon, children, onSelect, danger, disabled }: { icon: ReactNode; children: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <ContextMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={clsx(
        "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] outline-none data-[highlighted]:bg-hover data-[disabled]:opacity-40",
        danger ? "text-bad" : "text-fg",
      )}
    >
      {icon}
      {children}
    </ContextMenu.Item>
  );
}
