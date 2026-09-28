import * as ContextMenu from "@radix-ui/react-context-menu";
import clsx from "clsx";
import { Scissors, Trash2, Volume2 } from "lucide-react";
import { useMemo } from "react";
import { fmtTimecode } from "../../lib/format";
import { snapToFrame } from "../../lib/planH3";
import { commands, snapTime, timelineBeats, useTimeline, type Clip } from "../../store/timeline";
import { useUI } from "../../store/ui";
import { AudioClipWave } from "./AudioClipWave";
import { TlCtxItem } from "./TlCtxItem";
import { MIN_CLIP } from "./timelineConstants";
import type { AudioDragState } from "./timelineDrag";

export function AudioClipBlock({
  clip,
  displayStart,
  displayIn,
  displayOut,
  assetName,
  assetDuration,
  scale,
  selected,
  dragging,
  trackId,
  trackMuted,
  playhead,
  beats,
  downbeats,
  masterVolume,
  masterMute,
  snapBeats,
  ghost,
  onSelect,
  onPreview,
  onCommit,
  onRemove,
  onToggleMute,
}: {
  clip: Clip;
  displayStart: number;
  displayIn: number;
  displayOut: number;
  assetName?: string;
  assetDuration?: number | null;
  scale: number;
  selected: boolean;
  dragging: boolean;
  trackId: string;
  trackMuted: boolean;
  playhead: number;
  beats: number[];
  downbeats: number[];
  masterVolume: number;
  masterMute: boolean;
  snapBeats: boolean;
  ghost?: boolean;
  onSelect: () => void;
  onPreview: (d: AudioDragState | null) => void;
  onCommit: (d: AudioDragState | null) => void;
  onRemove: () => void;
  onToggleMute: () => void;
}) {
  const maxSrc = assetDuration && assetDuration > 0 ? assetDuration : Math.max(displayOut, clip.out, 60);
  const dur = Math.max(MIN_CLIP, displayOut - displayIn);
  const widthPx = Math.max(32, dur * scale);
  const clipEnd = displayStart + dur;
  const progress =
    playhead <= displayStart ? 0 : playhead >= clipEnd ? 1 : (playhead - displayStart) / dur;
  const silent = !!clip.muted || trackMuted || masterMute;
  const gain = silent ? 0 : Math.max(0, Math.min(1, masterVolume));
  const downSet = useMemo(() => new Set(downbeats), [downbeats]);
  const localBeats = useMemo(
    () => beats.filter((b) => b > displayStart + 0.01 && b < clipEnd - 0.01),
    [beats, displayStart, clipEnd],
  );

  const drag = (e: React.PointerEvent, mode: "move" | "in" | "out") => {
    if (ghost) return;
    e.preventDefault();
    e.stopPropagation();
    const originX = e.clientX;
    const s0 = clip.start ?? 0;
    const in0 = clip.in;
    const out0 = clip.out;
    let last: AudioDragState = {
      clipId: clip.id,
      fromTrackId: trackId,
      toTrackId: trackId,
      start: s0,
      in: in0,
      out: out0,
    };
    onPreview(last);
    onSelect();

    const move = (ev: PointerEvent) => {
      let toTrackId = trackId;
      if (mode === "move") {
        const trackEls = document.querySelectorAll<HTMLElement>("[data-audio-track]");
        for (const el of trackEls) {
          const r = el.getBoundingClientRect();
          if (ev.clientY >= r.top && ev.clientY <= r.bottom) {
            toTrackId = el.dataset.audioTrack || trackId;
            break;
          }
        }
      }
      const dx = (ev.clientX - originX) / scale;
      let nextStart = s0;
      let nextIn = in0;
      let nextOut = out0;
      if (mode === "move") {
        nextStart = Math.max(0, s0 + dx);
        if (snapBeats) {
          const doc = useTimeline.getState().doc;
          if (timelineBeats(doc).beats.length) {
            nextStart = snapTime(doc, nextStart, { force: true });
          }
        }
        nextStart = snapToFrame(nextStart);
      } else if (mode === "in") {
        // Trim left: slide in + start together, keep right edge fixed on timeline
        let nextStartRaw = Math.max(0, s0 + dx);
        if (snapBeats) {
          const doc = useTimeline.getState().doc;
          if (timelineBeats(doc).beats.length) {
            nextStartRaw = snapTime(doc, nextStartRaw, { force: true });
          }
        }
        nextStart = snapToFrame(nextStartRaw);
        const delta = nextStart - s0;
        nextIn = Math.max(0, Math.min(out0 - MIN_CLIP, in0 + delta));
        nextOut = out0;
      } else {
        let nextOutTimeline = s0 + (out0 - in0) + dx; // right edge on master clock
        if (snapBeats) {
          const doc = useTimeline.getState().doc;
          if (timelineBeats(doc).beats.length) {
            nextOutTimeline = snapTime(doc, nextOutTimeline, { force: true });
          }
        }
        nextOutTimeline = snapToFrame(nextOutTimeline);
        nextOut = Math.max(in0 + MIN_CLIP, Math.min(maxSrc, in0 + (nextOutTimeline - s0)));
        nextOut = snapToFrame(nextOut);
        nextStart = s0;
        nextIn = in0;
      }
      last = { clipId: clip.id, fromTrackId: trackId, toTrackId, start: nextStart, in: nextIn, out: nextOut };
      onPreview(last);
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const changed =
        last.start !== s0 || last.in !== in0 || last.out !== out0 || last.toTrackId !== trackId;
      onCommit(changed ? last : null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const block = (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onPointerDown={(e) => {
        if (ghost) return;
        if ((e.target as HTMLElement).dataset.edge) return;
        if (e.button !== 0) return;
        drag(e, "move");
      }}
      style={{ left: displayStart * scale, width: widthPx }}
      className={clsx(
        "absolute top-1 bottom-1 cursor-grab overflow-hidden rounded-md ring-1 active:cursor-grabbing",
        selected ? "ring-accent bg-audio/25" : "ring-audio/40 bg-audio/12",
        silent && "opacity-70",
        dragging && "z-30 opacity-90 shadow-lg",
        ghost && "pointer-events-none opacity-70",
      )}
      title={`${assetName ?? "аудио"} · ${fmtTimecode(displayStart)}${silent ? " · без звука" : ""}`}
    >
      <AudioClipWave
        assetId={clip.assetId}
        fileDuration={assetDuration}
        inn={displayIn}
        out={displayOut}
        widthPx={widthPx}
        gain={gain}
        muted={silent}
        progress={progress}
      />
      {/* Beat ticks on the waveform */}
      {localBeats.map((b) => (
        <div
          key={`ab-${b}`}
          className={clsx(
            "pointer-events-none absolute top-0 bottom-0 z-[1] w-px",
            downSet.has(b) ? "bg-accent/70" : "bg-accent/35",
          )}
          style={{ left: (b - displayStart) * scale }}
        />
      ))}
      <span className="pointer-events-none absolute bottom-0.5 left-1 right-1 z-[2] truncate text-[9px] font-medium text-fg/85 drop-shadow-[0_1px_1px_rgba(0,0,0,.85)]">
        {assetName ?? "аудио"}
        {silent ? " · mute" : ""}
      </span>
      {!ghost && (
        <>
          <div
            data-edge="in"
            onPointerDown={(e) => {
              e.stopPropagation();
              drag(e, "in");
            }}
            className="absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize hover:bg-accent/40"
          />
          <div
            data-edge="out"
            onPointerDown={(e) => {
              e.stopPropagation();
              drag(e, "out");
            }}
            className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize hover:bg-accent/40"
          />
        </>
      )}
    </div>
  );

  if (ghost) return block;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{block}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-40 min-w-44 rounded-xl border border-line bg-panel p-1 shadow-2xl">
          <TlCtxItem icon={Volume2} onSelect={onToggleMute}>
            {clip.muted ? "Включить звук" : "Выключить звук"}
          </TlCtxItem>
          <TlCtxItem
            icon={Scissors}
            onSelect={() => {
              const ph = useTimeline.getState().playhead;
              const cmd = commands.splitAudioClip(useTimeline.getState().doc, clip.id, trackId, ph);
              if (!cmd) useUI.getState().toast("Поставьте курсор внутрь клипа", "info");
              else {
                useTimeline.getState().run(cmd);
                useUI.getState().toast("Аудио разрезано", "ok");
              }
            }}
          >
            Разрезать по курсору (S)
          </TlCtxItem>
          <TlCtxItem icon={Trash2} danger onSelect={onRemove}>
            Убрать с дорожки
          </TlCtxItem>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

