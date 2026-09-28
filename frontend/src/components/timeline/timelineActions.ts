import { api } from "../../api/client";
import type { MediaAsset } from "../../api/types";
import * as actions from "../../lib/actions";
import { addToTimeline } from "../../lib/actions";
import { fmtTimecode } from "../../lib/format";
import { snapToFrame } from "../../lib/planH3";
import { useLibrary } from "../../store/library";
import {
  audioTracks,
  clipAtTime,
  clipDuration,
  clonePlanFresh,
  commands,
  findClipTrack,
  openPlanInSidebar,
  peekPlanClipboard,
  planTracks,
  resolvePlanPlacement,
  snapTime,
  useTimeline,
  type Command,
  type Track,
} from "../../store/timeline";
import { useUI } from "../../store/ui";
import { ASSET_DRAG_TYPE } from "../generate/RefsZone";
import { MIN_CLIP, MIN_PLAN, LABEL_W } from "./timelineConstants";

export function dragTypes(dt: DataTransfer): string[] {
  return Array.from(dt.types as unknown as string[]);
}

export function isAssetDrag(dt: DataTransfer): boolean {
  return dragTypes(dt).includes(ASSET_DRAG_TYPE);
}

export function isFileDrag(dt: DataTransfer): boolean {
  return dragTypes(dt).includes("Files");
}

/** Drop a library asset onto a video or audio track at clientX. */
export function dropAssetOnTrack(
  asset: MediaAsset,
  track: Track,
  clientX: number,
  el: HTMLElement,
  scale: number,
): void {
  if (track.kind === "video") {
    addToTimeline(asset);
    return;
  }
  if (track.kind === "audio") {
    if (asset.kind !== "audio" && !asset.has_audio) {
      useUI.getState().toast("На A-трек — аудио или клип со звуком", "info");
      return;
    }
    const doc = useTimeline.getState().doc;
    const r = el.getBoundingClientRect();
    const x = clientX - r.left - LABEL_W;
    let start = Math.max(0, x / scale);
    if (doc.snapToBeats !== false) start = snapTime(doc, start, { force: true });
    actions.addToAudioTrack(asset, { trackId: track.id, start });
  }
}

/** Import audio/video files onto an audio track at the current playhead. */
export async function importAudioOntoTrack(trackId: string, files: FileList | File[]): Promise<void> {
  const list = [...files];
  if (!list.length) return;
  try {
    for (const f of list) {
      const asset = await api.importAsset(f);
      useLibrary.getState().upsertAsset(asset);
      if (asset.kind !== "audio" && !asset.has_audio) {
        useUI.getState().toast(`«${asset.name}» без звука — пропуск`, "info");
        continue;
      }
      actions.addToAudioTrack(asset, { trackId, start: useTimeline.getState().playhead });
    }
  } catch (e) {
    useUI.getState().toast(e instanceof Error ? e.message : "Не удалось импортировать", "bad");
  }
}

/** Ctrl+V: paste plan clipboard under pointer (time + nearest plan track). */
export function pastePlanAtPointer(opts: {
  pointer: { x: number; y: number };
  railEl: HTMLElement | null;
  timeAtClientX: (clientX: number) => number;
  run: (cmd: Command) => void;
}): void {
  const { pointer: ptr, railEl, timeAtClientX, run } = opts;
  const clip = peekPlanClipboard();
  if (!clip) return;
  const d = useTimeline.getState().doc;
  const tracks = planTracks(d);
  if (!tracks.length) {
    useUI.getState().toast("Нет дорожки планов", "info");
    return;
  }
  const railBox = railEl?.getBoundingClientRect();
  const overRail =
    !!railBox &&
    ptr.x >= railBox.left &&
    ptr.x <= railBox.right &&
    ptr.y >= railBox.top &&
    ptr.y <= railBox.bottom;

  const startWant = overRail
    ? timeAtClientX(ptr.x)
    : snapToFrame(snapTime(d, useTimeline.getState().playhead, { force: true }));
  const duration = Math.max(MIN_PLAN, snapToFrame(clip.plan.duration));

  // Plan tracks ranked by vertical distance to cursor
  const ranked = (() => {
    const els = [...document.querySelectorAll<HTMLElement>("[data-plan-track]")];
    const scored = els
      .map((el) => {
        const id = el.dataset.planTrack;
        if (!id || !tracks.some((t) => t.id === id)) return null;
        const r = el.getBoundingClientRect();
        const mid = (r.top + r.bottom) / 2;
        const dist =
          ptr.y >= r.top && ptr.y <= r.bottom
            ? 0
            : Math.min(Math.abs(ptr.y - r.top), Math.abs(ptr.y - r.bottom), Math.abs(ptr.y - mid));
        return { id, dist };
      })
      .filter((x): x is { id: string; dist: number } => !!x)
      .sort((a, b) => a.dist - b.dist);
    const ids = scored.map((s) => s.id);
    for (const t of tracks) {
      if (!ids.includes(t.id)) ids.push(t.id);
    }
    return ids;
  })();

  let placed: number | null = null;
  let trackId: string | null = null;
  for (const id of ranked) {
    const track = tracks.find((t) => t.id === id);
    if (!track) continue;
    const at = resolvePlanPlacement(track.plans, startWant, duration);
    if (at != null) {
      placed = at;
      trackId = id;
      break;
    }
  }
  if (placed == null || !trackId) {
    useUI.getState().toast("Нет места без перекрытия на ближайших дорожках", "info");
    return;
  }
  const plan = clonePlanFresh(clip.plan, { start: placed, duration });
  run(commands.addPlan(plan, trackId));
  openPlanInSidebar(plan.id);
  const trackIdx = tracks.findIndex((t) => t.id === trackId);
  const trackLabel = trackIdx >= 0 ? `P${trackIdx + 1}` : trackId;
  useUI.getState().toast(`План → ${trackLabel} · ${fmtTimecode(placed)}`, "ok");
}

/** Split audio under selection/playhead, else video clip at playhead. Shared by toolbar + hotkeys. */
export function splitAtPlayhead(opts: {
  selectedId: string | null;
  run: (cmd: Command) => void;
  onSelectClip: (id: string | null) => void;
}): void {
  const { selectedId, run, onSelectClip } = opts;
  const d = useTimeline.getState().doc;
  const ph = useTimeline.getState().playhead;

  const tryAudio = (clipId: string, trackId: string): boolean => {
    const cmd = commands.splitAudioClip(d, clipId, trackId, ph);
    if (!cmd) {
      useUI.getState().toast("Слишком близко к краю клипа", "info");
      return true;
    }
    run(cmd);
    onSelectClip(clipId);
    useUI.getState().toast("Аудио разрезано", "ok");
    return true;
  };

  if (selectedId) {
    const hit = findClipTrack(d, selectedId);
    if (hit?.track.kind === "audio") {
      tryAudio(selectedId, hit.track.id);
      return;
    }
  }
  for (const t of audioTracks(d)) {
    for (const c of t.clips) {
      const s = c.start ?? 0;
      const dur = clipDuration(c);
      if (ph > s + MIN_CLIP && ph < s + dur - MIN_CLIP) {
        tryAudio(c.id, t.id);
        return;
      }
    }
  }

  const hit = clipAtTime(d, ph);
  if (!hit) {
    useUI.getState().toast("Нет клипа под курсором", "info");
    return;
  }
  const cmd = commands.splitClip(d, hit.clip.id, ph);
  if (!cmd) {
    useUI.getState().toast("Слишком близко к краю клипа", "info");
    return;
  }
  run(cmd);
  onSelectClip(hit.clip.id);
  useUI.getState().toast("Клип разрезан", "ok");
}
