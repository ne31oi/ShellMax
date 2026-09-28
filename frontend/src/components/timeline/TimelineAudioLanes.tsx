import { Music2 } from "lucide-react";
import type { RefObject } from "react";
import type { MediaAsset } from "../../api/types";
import * as actions from "../../lib/actions";
import {
  audioTracks,
  commands,
  snapEnabled,
  useTimeline,
} from "../../store/timeline";
import { useUI } from "../../store/ui";
import { ASSET_DRAG_TYPE } from "../generate/RefsZone";
import { AudioClipBlock } from "./AudioClipBlock";
import { TrackRow } from "./TrackRow";
import {
  dropAssetOnTrack,
  importAudioOntoTrack,
  isAssetDrag,
  isFileDrag,
} from "./timelineActions";
import type { AudioDragState } from "./timelineDrag";

type Props = {
  contentW: number;
  scale: number;
  playhead: number;
  beats: number[];
  downsList: number[];
  selected: string | null;
  setSelected: (id: string | null) => void;
  audioDrag: AudioDragState | null;
  setAudioDrag: (d: AudioDragState | null) => void;
  overTrack: string | null;
  setOverTrack: (id: string | null) => void;
  assets: Record<number, MediaAsset>;
  audioFileInput: RefObject<HTMLInputElement | null>;
  audioAddTrackId: RefObject<string | null>;
};

export function TimelineAudioLanes({
  contentW,
  scale,
  playhead,
  beats,
  downsList,
  selected,
  setSelected,
  audioDrag,
  setAudioDrag,
  overTrack,
  setOverTrack,
  assets,
  audioFileInput,
  audioAddTrackId,
}: Props) {
  const doc = useTimeline((s) => s.doc);
  const run = useTimeline((s) => s.run);
  const setPlayhead = useTimeline((s) => s.setPlayhead);
  const aTracks = audioTracks(doc);

  return (
    <>
      {aTracks.map((at, idx) => (
        <TrackRow
          key={at.id}
          label={`A${idx + 1}`}
          name={at.name || `Аудио ${idx + 1}`}
          tall
          over={overTrack === at.id}
          muted={at.muted}
          onMute={() => run(commands.setTrackMuted(useTimeline.getState().doc, at.id, !at.muted))}
          onAddAudio={() => {
            const selectedAssetId = useUI.getState().selectedAsset;
            const sel = selectedAssetId != null ? assets[selectedAssetId] : undefined;
            if (sel && (sel.kind === "audio" || sel.has_audio)) {
              actions.addToAudioTrack(sel, { trackId: at.id, start: playhead });
              return;
            }
            audioAddTrackId.current = at.id;
            audioFileInput.current?.click();
          }}
          onRemove={
            aTracks.length > 1
              ? () => {
                  const cmd = commands.removeTrack(useTimeline.getState().doc, at.id);
                  if (!cmd) {
                    useUI.getState().toast("Нужна хотя бы одна аудиодорожка", "info");
                    return;
                  }
                  run(cmd);
                }
              : undefined
          }
          onDragOver={(e) => {
            if (isAssetDrag(e.dataTransfer) || isFileDrag(e.dataTransfer)) {
              e.preventDefault();
              setOverTrack(at.id);
            }
          }}
          onDragLeave={() => setOverTrack(null)}
          onDrop={(e) => {
            e.preventDefault();
            setOverTrack(null);
            if (e.dataTransfer.files?.length) {
              void importAudioOntoTrack(at.id, e.dataTransfer.files);
              return;
            }
            const json = e.dataTransfer.getData(ASSET_DRAG_TYPE);
            if (json) dropAssetOnTrack(JSON.parse(json) as MediaAsset, at, e.clientX, e.currentTarget, scale);
          }}
        >
          <div className="relative h-full" style={{ width: contentW }} data-rail="1" data-audio-track={at.id}>
            {at.clips.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center gap-2 px-2 text-[11px] text-faint">
                <Music2 size={12} /> Перетащите аудио или нажмите «+ аудио»
              </div>
            )}
            {at.clips.map((c) => {
              const dragging = audioDrag?.clipId === c.id;
              const onThisTrack = !dragging || audioDrag.toTrackId === at.id;
              if (dragging && audioDrag.fromTrackId === at.id && audioDrag.toTrackId !== at.id) {
                return null; // ghost moves to target track
              }
              const start = dragging && onThisTrack ? audioDrag.start : (c.start ?? 0);
              const inn = dragging && onThisTrack ? audioDrag.in : c.in;
              const out = dragging && onThisTrack ? audioDrag.out : c.out;
              const asset = assets[c.assetId];
              return (
                <AudioClipBlock
                  key={c.id}
                  clip={c}
                  displayStart={start}
                  displayIn={inn}
                  displayOut={out}
                  assetName={asset?.name}
                  assetDuration={asset?.duration}
                  scale={scale}
                  selected={selected === c.id}
                  dragging={!!dragging}
                  trackId={at.id}
                  trackMuted={!!at.muted}
                  playhead={playhead}
                  beats={beats}
                  downbeats={downsList}
                  masterVolume={doc.masterVolume ?? 1}
                  masterMute={!!doc.masterMute}
                  snapBeats={snapEnabled(doc)}
                  onSelect={() => {
                    setSelected(c.id);
                    setPlayhead(c.start ?? 0);
                  }}
                  onPreview={setAudioDrag}
                  onCommit={(d) => {
                    setAudioDrag(null);
                    if (!d) return;
                    const cmd = commands.relocateAudioClip(
                      useTimeline.getState().doc,
                      d.clipId,
                      d.fromTrackId,
                      d.toTrackId,
                      { start: d.start, in: d.in, out: d.out },
                    );
                    if (cmd) run(cmd);
                  }}
                  onRemove={() => {
                    run(commands.removeClip(useTimeline.getState().doc, c.id, at.id));
                    setSelected(null);
                  }}
                  onToggleMute={() =>
                    run(commands.setClipMuted(useTimeline.getState().doc, c.id, !c.muted, at.id))
                  }
                />
              );
            })}
            {/* Ghost on target track while dragging from another */}
            {audioDrag &&
              audioDrag.toTrackId === at.id &&
              audioDrag.fromTrackId !== at.id &&
              (() => {
                const src = aTracks.flatMap((t) => t.clips.map((c) => ({ t, c }))).find((x) => x.c.id === audioDrag.clipId);
                if (!src) return null;
                const asset = assets[src.c.assetId];
                return (
                  <AudioClipBlock
                    key={`ghost-${audioDrag.clipId}`}
                    clip={src.c}
                    displayStart={audioDrag.start}
                    displayIn={audioDrag.in}
                    displayOut={audioDrag.out}
                    assetName={asset?.name}
                    assetDuration={asset?.duration}
                    scale={scale}
                    selected
                    dragging
                    trackId={at.id}
                    trackMuted={!!at.muted}
                    playhead={playhead}
                    beats={beats}
                    downbeats={downsList}
                    masterVolume={doc.masterVolume ?? 1}
                    masterMute={!!doc.masterMute}
                    snapBeats={snapEnabled(doc)}
                    ghost
                    onSelect={() => undefined}
                    onPreview={() => undefined}
                    onCommit={() => undefined}
                    onRemove={() => undefined}
                    onToggleMute={() => undefined}
                  />
                );
              })()}
          </div>
        </TrackRow>
      ))}

      <input
        ref={audioFileInput}
        type="file"
        hidden
        accept="audio/*,video/*"
        multiple
        onChange={(e) => {
          const trackId = audioAddTrackId.current ?? aTracks[0]?.id;
          const files = e.target.files;
          e.target.value = "";
          audioAddTrackId.current = null;
          if (trackId && files?.length) void importAudioOntoTrack(trackId, files);
        }}
      />
    </>
  );
}
