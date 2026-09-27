import * as ContextMenu from "@radix-ui/react-context-menu";
import clsx from "clsx";
import {
  AlertCircle, Clapperboard, Copy, Dices, Film, FolderOpen, ImagePlus, Pencil, ScanFace, Shuffle,
  Sparkles, SplitSquareHorizontal, Square, Trash2, Upload as UploadIcon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { api, urls } from "../../api/client";
import type { Generation, MediaAsset } from "../../api/types";
import * as actions from "../../lib/actions";
import { fmtDuration, fmtEstimate } from "../../lib/format";
import { promptTitle } from "../../lib/refs";
import { stageInfo, stepProgress, timeBreakdown } from "../../lib/stages";
import { useElapsed } from "../../lib/useElapsed";
import { sortedGenerations, useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { ASSET_DRAG_TYPE } from "../generate/RefsZone";
import { IconButton } from "../ui";

export function MediaBin() {
  const generations = useLibrary((s) => s.generations);
  const assets = useLibrary((s) => s.assets);
  const filter = useUI((s) => s.binFilter);
  const setFilter = useUI((s) => s.setBinFilter);
  const importInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const gens = sortedGenerations(generations).filter((g) =>
    filter === "all" ? true : filter === "video" ? g.status === "done" : filter === "draft" ? g.status === "draft_only" : false,
  );
  const imported = Object.values(assets)
    .filter((a) => a.source === "imported" && (filter === "all" || filter === "imported"))
    .sort((a, b) => b.id - a.id);

  const doImport = async (files: File[]) => {
    setImporting(true);
    try {
      for (const f of files) useLibrary.getState().upsertAsset(await api.importAsset(f));
    } catch (e) {
      useUI.getState().toast(e instanceof Error ? e.message : "Не удалось импортировать", "bad");
    } finally {
      setImporting(false);
    }
  };

  const empty = gens.length === 0 && imported.length === 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-3 pb-2 pt-3">
        <h2 className="mr-auto text-[11px] font-semibold uppercase tracking-wider text-faint">Медиатека</h2>
        <input ref={importInput} type="file" hidden multiple accept="video/*,image/*,audio/*" onChange={(e) => {
          doImport([...(e.target.files ?? [])]);
          e.target.value = "";
        }} />
        <IconButton label="Импортировать файлы" size="sm" onClick={() => importInput.current?.click()} disabled={importing}>
          <UploadIcon size={14} />
        </IconButton>
      </div>
      <div className="flex gap-1 px-3 pb-2">
        {([["all", "Все"], ["video", "Готовые"], ["draft", "Черновики"], ["imported", "Импорт"]] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setFilter(id)}
            className={clsx("rounded-md px-2 py-0.5 text-xs", filter === id ? "bg-hover text-fg" : "text-muted hover:text-fg")}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-3"
        onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
        onDrop={(e) => {
          if (e.dataTransfer.files.length) {
            e.preventDefault();
            doImport([...e.dataTransfer.files]);
          }
        }}
      >
        {empty ? (
          <div className="mt-10 px-4 text-center text-xs leading-relaxed text-faint">
            <Clapperboard size={28} className="mx-auto mb-2 opacity-50" />
            Здесь появятся ваши видео.
            <br />
            Опишите сцену справа и нажмите «Создать».
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {gens.map((g) => (
              <GenerationCard key={g.id} gen={g} />
            ))}
            {imported.map((a) => (
              <AssetCard key={a.id} asset={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- cards
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

function GenerationCard({ gen }: { gen: Generation }) {
  const assets = useLibrary((s) => s.assets);
  const preview = useLibrary((s) => s.previews[gen.id]);
  const selected = useUI((s) => s.selectedGen === gen.id);
  const elapsed = useElapsed(gen.status === "running" ? gen.started : null);
  const asset = actions.outputAsset(gen, assets);
  const title =
    asset?.name ??
    (gen.kind === "face"
      ? "Улучшение лица"
      : gen.kind === "enhance"
        ? "Детализация"
        : promptTitle(gen.ui_params.prompt) || `Генерация ${gen.id}`);
  const active = gen.status === "running" || gen.status === "queued";

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
        {gen.kind === "enhance" && gen.status !== "running" && (
          <span className="absolute left-1 top-1 flex items-center gap-0.5 rounded bg-accent px-1 text-[10px] font-semibold text-accent-fg">
            <Sparkles size={10} /> деталь
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
          <CtxItem icon={<Dices size={13} />} onSelect={() => actions.retry(gen, false)}>Повторить с новым сидом</CtxItem>
          {gen.kind !== "face" && gen.kind !== "enhance" && (
            <>
              <CtxItem icon={<Copy size={13} />} onSelect={() => actions.retry(gen, true)}>Повторить точно (тот же сид)</CtxItem>
              <CtxItem icon={<Shuffle size={13} />} onSelect={() => actions.retry(gen, false, 4)}>Вариации ×4</CtxItem>
            </>
          )}
          <CtxItem icon={<Pencil size={13} />} onSelect={() => actions.editAndRetry(gen)}>Изменить и повторить</CtxItem>
          {asset && (
            <>
              <ContextMenu.Separator className="my-1 h-px bg-line" />
              <CtxItem icon={<ScanFace size={13} />} onSelect={() => useUI.getState().openFaceDialog({ assetId: asset.id })} disabled={gen.status !== "done"}>Улучшить лицо…</CtxItem>
              <CtxItem icon={<Sparkles size={13} />} onSelect={() => useUI.getState().openEnhanceDialog({ assetId: asset.id })} disabled={gen.status !== "done"}>Детализация (SeedVR2)…</CtxItem>
              <CtxItem icon={<Film size={13} />} onSelect={() => actions.addToTimeline(asset)} disabled={gen.status !== "done"}>В таймлайн</CtxItem>
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

function AssetCard({ asset }: { asset: MediaAsset }) {
  const selected = useUI((s) => s.selectedAsset === asset.id);
  const card = (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => e.dataTransfer.setData(ASSET_DRAG_TYPE, JSON.stringify(asset))}
      onClick={() => useUI.getState().selectAsset(asset.id)}
      onDoubleClick={() => actions.addToTimeline(asset)}
      className={clsx("cursor-pointer rounded-xl p-1 transition-colors", selected ? "bg-accent/15 ring-1 ring-accent/60" : "hover:bg-hover")}
    >
      <Thumb asset={asset}>
        <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] text-white/80">импорт</span>
      </Thumb>
      <p className="truncate px-1 pt-1 text-xs">{asset.name}</p>
    </div>
  );
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{card}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-40 min-w-56 rounded-xl border border-line bg-panel p-1 shadow-2xl">
          <CtxItem icon={<Film size={13} />} onSelect={() => actions.addToTimeline(asset)} disabled={asset.kind !== "video"}>В таймлайн</CtxItem>
          <CtxItem icon={<ImagePlus size={13} />} onSelect={() => actions.assetAsRef(asset)}>Использовать как референс</CtxItem>
          <CtxItem icon={<ScanFace size={13} />} onSelect={() => useUI.getState().openFaceDialog({ assetId: asset.id })} disabled={asset.kind !== "video"}>Улучшить лицо…</CtxItem>
          <CtxItem icon={<Sparkles size={13} />} onSelect={() => useUI.getState().openEnhanceDialog({ assetId: asset.id })} disabled={asset.kind !== "video"}>Детализация (SeedVR2)…</CtxItem>
          <CtxItem icon={<FolderOpen size={13} />} onSelect={() => actions.reveal(asset)}>Показать в папке</CtxItem>
          <ContextMenu.Separator className="my-1 h-px bg-line" />
          <CtxItem icon={<Trash2 size={13} />} danger onSelect={() => actions.removeAsset(asset)}>Удалить</CtxItem>
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
