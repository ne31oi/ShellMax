import clsx from "clsx";
import { Volume2, VolumeX, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

export function TrackRow({
  label,
  name,
  children,
  over,
  muted,
  tall,
  onDragOver,
  onDragLeave,
  onDrop,
  onAddPlan,
  onAddAudio,
  onMute,
  onRemove,
}: {
  label: string;
  name: string;
  children: ReactNode;
  over?: boolean;
  muted?: boolean;
  tall?: boolean;
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave?: () => void;
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void;
  onAddPlan?: () => void;
  onAddAudio?: () => void;
  onMute?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div
      className={clsx(
        "flex border-b border-line/60",
        tall ? "h-16" : "h-12",
        over && "bg-accent/5",
        muted && "opacity-50",
      )}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        className={clsx(
          "sticky left-0 z-20 flex w-[72px] shrink-0 flex-col justify-center border-r border-line px-1.5",
          over ? "bg-accent/10" : "bg-panel",
        )}
      >
        <div className="flex items-center gap-0.5">
          <span className="text-[10px] font-semibold text-muted">{label}</span>
          {onMute && (
            <button type="button" className="text-faint hover:text-fg" title={muted ? "Включить дорожку" : "Выключить дорожку"} onClick={onMute}>
              {muted ? <VolumeX size={10} /> : <Volume2 size={10} />}
            </button>
          )}
          {onRemove && (
            <button type="button" className="text-faint hover:text-bad" title="Удалить дорожку" onClick={onRemove}>
              <Trash2 size={10} />
            </button>
          )}
        </div>
        <span className="truncate text-[9px] text-faint">{name}</span>
        {onAddPlan && (
          <button type="button" className="text-[9px] text-accent hover:underline" onClick={onAddPlan}>
            + план
          </button>
        )}
        {onAddAudio && (
          <button type="button" className="text-[9px] text-accent hover:underline" onClick={onAddAudio}>
            + аудио
          </button>
        )}
      </div>
      <div className="relative min-w-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

