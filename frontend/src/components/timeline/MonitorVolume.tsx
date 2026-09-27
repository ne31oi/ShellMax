import { Volume1, Volume2, VolumeX } from "lucide-react";
import { useRef } from "react";
import { commands, useTimeline } from "../../store/timeline";
import { Popover, Slider } from "../ui";

/** Monitor / output volume for montage playback only (not generation). */
export function MonitorVolume({ size = "sm" }: { size?: "sm" | "md" }) {
  const mute = useTimeline((s) => !!s.doc.masterMute);
  const vol = useTimeline((s) => s.doc.masterVolume ?? 1);
  const lastVol = useRef(vol > 0.001 ? vol : 0.8);
  if (!mute && vol > 0.001) lastVol.current = vol;

  const level = mute ? 0 : vol;
  const pct = Math.round(level * 100);
  const Icon = level <= 0.001 ? VolumeX : level < 0.45 ? Volume1 : Volume2;
  const iconPx = size === "md" ? 14 : 13;
  const muted = mute || level <= 0.001;

  const setVol = (v: number) => {
    useTimeline.getState().patchDoc({ masterVolume: v, masterMute: false });
  };

  const toggleMute = () => {
    const tl = useTimeline.getState();
    if (tl.doc.masterMute || (tl.doc.masterVolume ?? 1) <= 0.001) {
      tl.patchDoc({ masterMute: false, masterVolume: lastVol.current || 0.8 });
    } else {
      lastVol.current = tl.doc.masterVolume ?? 1;
      tl.run(commands.setMasterMute(tl.doc, true));
    }
  };

  return (
    <Popover
      side="top"
      align="center"
      className="w-[3.25rem] px-1.5 py-2"
      trigger={
        <button
          type="button"
          title={`Громкость выхода · ${pct}% (ПКМ — mute)`}
          aria-label={`Громкость выхода ${pct}%`}
          onContextMenu={(e) => {
            e.preventDefault();
            toggleMute();
          }}
          className={
            size === "md"
              ? "inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg"
              : "inline-flex h-6 w-6 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg"
          }
        >
          <Icon size={iconPx} className={muted ? "text-faint" : undefined} />
        </button>
      }
    >
      <div className="flex flex-col items-center gap-1.5">
        <span className="text-[10px] font-semibold tabular-nums text-fg">{pct}</span>
        <Slider
          orientation="vertical"
          size="lg"
          className="h-28"
          value={level}
          min={0}
          max={1}
          step={0.01}
          onChange={setVol}
        />
        <button
          type="button"
          className="rounded-md p-1 text-muted hover:bg-hover hover:text-fg"
          title={muted ? "Включить" : "Выключить"}
          onClick={toggleMute}
        >
          {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </button>
      </div>
    </Popover>
  );
}
