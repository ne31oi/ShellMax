/** Undoable timeline commands. */
import { snapToFrame } from "../../lib/planH3";
import type { Clip, Command, Plan, TimelineDoc, TimelineMarkers, Track } from "../../types/timeline";
import {
  MIN_CLIP,
  MIN_PLAN,
  audioTracks,
  clipDuration,
  emptyPlan,
  findClip,
  planTracks,
  resolvePlanPlacement,
  uid,
  videoTrack,
} from "./queries";

const mapTrack = (doc: TimelineDoc, trackId: string, fn: (t: Track) => Track): TimelineDoc => ({
  ...doc,
  tracks: doc.tracks.map((t) => (t.id === trackId ? fn(t) : t)),
});

const mapClips = (doc: TimelineDoc, trackId: string, fn: (clips: Clip[]) => Clip[]): TimelineDoc =>
  mapTrack(doc, trackId, (t) => ({ ...t, clips: fn(t.clips) }));

const mapPlans = (doc: TimelineDoc, trackId: string, fn: (plans: Plan[]) => Plan[]): TimelineDoc =>
  mapTrack(doc, trackId, (t) => ({ ...t, plans: fn(t.plans) }));

export const commands = {
  addClip(clip: Clip, trackId = "v1", index?: number): Command {
    return {
      label: "Добавить клип",
      apply: (d) =>
        mapClips(d, trackId, (c) => {
          const next = [...c];
          next.splice(index ?? next.length, 0, clip);
          return next;
        }),
      revert: (d) => mapClips(d, trackId, (c) => c.filter((x) => x.id !== clip.id)),
    };
  },
  removeClip(doc: TimelineDoc, clipId: string, trackId = "v1"): Command {
    const track = doc.tracks.find((t) => t.id === trackId)!;
    const index = track.clips.findIndex((c) => c.id === clipId);
    const clip = track.clips[index];
    return {
      label: "Удалить клип",
      apply: (d) => mapClips(d, trackId, (c) => c.filter((x) => x.id !== clipId)),
      revert: (d) =>
        mapClips(d, trackId, (c) => {
          const next = [...c];
          next.splice(index, 0, clip);
          return next;
        }),
    };
  },
  moveClip(from: number, to: number, trackId = "v1"): Command {
    const move = (c: Clip[], a: number, b: number) => {
      const next = [...c];
      const [x] = next.splice(a, 1);
      next.splice(b, 0, x);
      return next;
    };
    return {
      label: "Переместить клип",
      apply: (d) => mapClips(d, trackId, (c) => move(c, from, to)),
      revert: (d) => mapClips(d, trackId, (c) => move(c, to, from)),
    };
  },
  trimClip(doc: TimelineDoc, clipId: string, nextIn: number, nextOut: number, trackId = "v1"): Command {
    const track = doc.tracks.find((t) => t.id === trackId)!;
    const prev = track.clips.find((c) => c.id === clipId)!;
    const inn = Math.max(0, Math.min(nextIn, nextOut - MIN_CLIP));
    const out = Math.max(inn + MIN_CLIP, nextOut);
    const next: Clip = { ...prev, in: inn, out };
    return {
      label: "Обрезать клип",
      apply: (d) => mapClips(d, trackId, (clips) => clips.map((c) => (c.id === clipId ? next : c))),
      revert: (d) => mapClips(d, trackId, (clips) => clips.map((c) => (c.id === clipId ? prev : c))),
    };
  },
  splitClip(doc: TimelineDoc, clipId: string, atSequenceTime: number, trackId = "v1"): Command | null {
    const hit = findClip(doc, clipId);
    if (!hit) return null;
    const local = atSequenceTime - hit.trackStart;
    if (local < MIN_CLIP || local > clipDuration(hit.clip) - MIN_CLIP) return null;
    const cutSource = hit.clip.in + local;
    const left: Clip = { ...hit.clip, out: cutSource };
    const right: Clip = {
      id: uid(),
      assetId: hit.clip.assetId,
      in: cutSource,
      out: hit.clip.out,
      muted: hit.clip.muted,
    };
    return {
      label: "Разрезать клип",
      apply: (d) =>
        mapClips(d, trackId, (clips) => {
          const next = [...clips];
          const i = next.findIndex((c) => c.id === clipId);
          if (i < 0) return clips;
          next.splice(i, 1, left, right);
          return next;
        }),
      revert: (d) =>
        mapClips(d, trackId, (clips) => {
          const i = clips.findIndex((c) => c.id === left.id);
          if (i < 0) return clips;
          const next = [...clips];
          next.splice(i, 2, hit.clip);
          return next;
        }),
    };
  },
  setClipMuted(doc: TimelineDoc, clipId: string, muted: boolean, trackId = "v1"): Command {
    const prev = doc.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId);
    const was = !!prev?.muted;
    return {
      label: muted ? "Выключить звук клипа" : "Включить звук клипа",
      apply: (d) => mapClips(d, trackId, (clips) => clips.map((c) => (c.id === clipId ? { ...c, muted } : c))),
      revert: (d) => mapClips(d, trackId, (clips) => clips.map((c) => (c.id === clipId ? { ...c, muted: was } : c))),
    };
  },
  setMasterMute(doc: TimelineDoc, muted: boolean): Command {
    const was = !!doc.masterMute;
    return {
      label: muted ? "Выключить звук последовательности" : "Включить звук последовательности",
      apply: (d) => ({ ...d, masterMute: muted }),
      revert: (d) => ({ ...d, masterMute: was }),
    };
  },
  setMasterVolume(doc: TimelineDoc, volume: number): Command {
    const was = doc.masterVolume ?? 1;
    const next = Math.max(0, Math.min(1, volume));
    return {
      label: "Громкость последовательности",
      apply: (d) => ({ ...d, masterVolume: next }),
      revert: (d) => ({ ...d, masterVolume: was }),
    };
  },
  replaceClipAsset(doc: TimelineDoc, clipId: string, assetId: number, trackId = "v1"): Command {
    const prev = doc.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId);
    const was = prev?.assetId ?? assetId;
    return {
      label: "Заменить клип на таймлайне",
      apply: (d) => mapClips(d, trackId, (clips) => clips.map((c) => (c.id === clipId ? { ...c, assetId } : c))),
      revert: (d) => mapClips(d, trackId, (clips) => clips.map((c) => (c.id === clipId ? { ...c, assetId: was } : c))),
    };
  },

  // ---- plans
  addPlan(plan: Plan, trackId: string): Command {
    return {
      label: "Добавить план",
      apply: (d) =>
        mapPlans(d, trackId, (ps) => (ps.some((p) => p.id === plan.id) ? ps : [...ps, plan])),
      revert: (d) => mapPlans(d, trackId, (ps) => ps.filter((p) => p.id !== plan.id)),
    };
  },
  removePlan(doc: TimelineDoc, planId: string, trackId: string): Command {
    const prev = doc.tracks.find((t) => t.id === trackId)?.plans.find((p) => p.id === planId);
    return {
      label: "Удалить план",
      apply: (d) => mapPlans(d, trackId, (ps) => ps.filter((p) => p.id !== planId)),
      revert: (d) =>
        mapPlans(d, trackId, (ps) => (prev ? [...ps, prev] : ps)),
    };
  },
  updatePlan(doc: TimelineDoc, planId: string, trackId: string, patch: Partial<Plan>): Command {
    const prev = doc.tracks.find((t) => t.id === trackId)?.plans.find((p) => p.id === planId);
    return {
      label: "Изменить план",
      apply: (d) =>
        mapPlans(d, trackId, (ps) => ps.map((p) => (p.id === planId ? { ...p, ...patch } : p))),
      revert: (d) =>
        mapPlans(d, trackId, (ps) => ps.map((p) => (p.id === planId && prev ? prev : p))),
    };
  },
  movePlan(doc: TimelineDoc, planId: string, trackId: string, start: number, duration?: number): Command {
    const prev = doc.tracks.find((t) => t.id === trackId)?.plans.find((p) => p.id === planId);
    const nextStart = Math.max(0, start);
    const nextDur = Math.max(MIN_PLAN, duration ?? prev?.duration ?? 2);
    return {
      label: "Сдвинуть план",
      apply: (d) =>
        mapPlans(d, trackId, (ps) =>
          ps.map((p) => (p.id === planId ? { ...p, start: nextStart, duration: nextDur } : p)),
        ),
      revert: (d) =>
        mapPlans(d, trackId, (ps) => ps.map((p) => (p.id === planId && prev ? prev : p))),
    };
  },
  /** Move a plan in time and/or to another plan track (no overlap on the destination). */
  relocatePlan(
    doc: TimelineDoc,
    planId: string,
    fromTrackId: string,
    toTrackId: string,
    start: number,
    duration?: number,
  ): Command | null {
    const from = doc.tracks.find((t) => t.id === fromTrackId);
    const to = doc.tracks.find((t) => t.id === toTrackId);
    if (!from || !to || from.kind !== "plan" || to.kind !== "plan") return null;
    const prev = from.plans.find((p) => p.id === planId);
    if (!prev) return null;
    const dur = Math.max(MIN_PLAN, snapToFrame(duration ?? prev.duration));
    const peers = toTrackId === fromTrackId ? from.plans : to.plans;
    const placed = resolvePlanPlacement(peers, start, dur, planId);
    if (placed == null) return null;
    const next: Plan = { ...prev, start: placed, duration: dur };
    if (toTrackId === fromTrackId) {
      return {
        label: "Сдвинуть план",
        apply: (d) => mapPlans(d, fromTrackId, (ps) => ps.map((p) => (p.id === planId ? next : p))),
        revert: (d) => mapPlans(d, fromTrackId, (ps) => ps.map((p) => (p.id === planId ? prev : p))),
      };
    }
    return {
      label: "Перенести план на дорожку",
      apply: (d) => {
        let out = mapPlans(d, fromTrackId, (ps) => ps.filter((p) => p.id !== planId));
        out = mapPlans(out, toTrackId, (ps) => [...ps, next]);
        return out;
      },
      revert: (d) => {
        let out = mapPlans(d, toTrackId, (ps) => ps.filter((p) => p.id !== planId));
        out = mapPlans(out, fromTrackId, (ps) => [...ps, prev]);
        return out;
      },
    };
  },
  addPlanTrack(doc: TimelineDoc): Command {
    const n = planTracks(doc).length + 1;
    const track: Track = {
      id: `p${n}_${uid()}`,
      kind: "plan",
      name: `Планы ${n}`,
      clips: [],
      plans: [],
      muted: false,
      solo: false,
    };
    return {
      label: "Добавить дорожку планов",
      apply: (d) => ({ ...d, tracks: [...d.tracks, track] }),
      revert: (d) => ({ ...d, tracks: d.tracks.filter((t) => t.id !== track.id) }),
    };
  },
  addAudioTrack(doc: TimelineDoc): Command {
    const n = audioTracks(doc).length + 1;
    const track: Track = {
      id: `a${n}_${uid()}`,
      kind: "audio",
      name: `Аудио ${n}`,
      clips: [],
      plans: [],
      muted: false,
      solo: false,
    };
    return {
      label: "Добавить аудиодорожку",
      apply: (d) => ({ ...d, tracks: [...d.tracks, track] }),
      revert: (d) => ({ ...d, tracks: d.tracks.filter((t) => t.id !== track.id) }),
    };
  },
  removeTrack(doc: TimelineDoc, trackId: string): Command | null {
    const track = doc.tracks.find((t) => t.id === trackId);
    if (!track || track.kind === "video") return null;
    const same = doc.tracks.filter((t) => t.kind === track.kind);
    if (same.length <= 1) return null; // keep at least one plan / audio lane
    const index = doc.tracks.findIndex((t) => t.id === trackId);
    return {
      label: "Удалить дорожку",
      apply: (d) => ({ ...d, tracks: d.tracks.filter((t) => t.id !== trackId) }),
      revert: (d) => {
        const next = [...d.tracks];
        next.splice(Math.min(index, next.length), 0, track);
        return { ...d, tracks: next };
      },
    };
  },
  addAudioClip(clip: Clip, trackId: string): Command {
    return {
      label: "Добавить аудио",
      apply: (d) => mapClips(d, trackId, (c) => [...c, clip]),
      revert: (d) => mapClips(d, trackId, (c) => c.filter((x) => x.id !== clip.id)),
    };
  },
  /** Move / trim an absolute audio clip (optionally to another A-track). */
  relocateAudioClip(
    doc: TimelineDoc,
    clipId: string,
    fromTrackId: string,
    toTrackId: string,
    patch: { start: number; in: number; out: number },
  ): Command | null {
    const from = doc.tracks.find((t) => t.id === fromTrackId);
    const prev = from?.clips.find((c) => c.id === clipId);
    if (!prev || from?.kind !== "audio") return null;
    const to = doc.tracks.find((t) => t.id === toTrackId);
    if (!to || to.kind !== "audio") return null;
    const inn = Math.max(0, Math.min(patch.in, patch.out - MIN_CLIP));
    const out = Math.max(inn + MIN_CLIP, patch.out);
    const start = snapToFrame(Math.max(0, patch.start));
    const next: Clip = { ...prev, start, in: inn, out };
    const same = fromTrackId === toTrackId;
    return {
      label: same ? "Сдвинуть аудио" : "Перенести аудио",
      apply: (d) => {
        if (same) {
          return mapClips(d, fromTrackId, (clips) => clips.map((c) => (c.id === clipId ? next : c)));
        }
        let d2 = mapClips(d, fromTrackId, (clips) => clips.filter((c) => c.id !== clipId));
        d2 = mapClips(d2, toTrackId, (clips) => [...clips, next]);
        return d2;
      },
      revert: (d) => {
        if (same) {
          return mapClips(d, fromTrackId, (clips) => clips.map((c) => (c.id === clipId ? prev : c)));
        }
        let d2 = mapClips(d, toTrackId, (clips) => clips.filter((c) => c.id !== clipId));
        d2 = mapClips(d2, fromTrackId, (clips) => [...clips, prev]);
        return d2;
      },
    };
  },
  splitAudioClip(doc: TimelineDoc, clipId: string, trackId: string, atMasterTime: number): Command | null {
    const track = doc.tracks.find((t) => t.id === trackId);
    const clip = track?.clips.find((c) => c.id === clipId);
    if (!clip || track?.kind !== "audio") return null;
    const start = clip.start ?? 0;
    const local = atMasterTime - start;
    if (local < MIN_CLIP || local > clipDuration(clip) - MIN_CLIP) return null;
    const cutSource = clip.in + local;
    const left: Clip = { ...clip, out: cutSource };
    const right: Clip = {
      id: uid(),
      assetId: clip.assetId,
      in: cutSource,
      out: clip.out,
      start: snapToFrame(atMasterTime),
      muted: clip.muted,
    };
    return {
      label: "Разрезать аудио",
      apply: (d) =>
        mapClips(d, trackId, (clips) => {
          const next = [...clips];
          const i = next.findIndex((c) => c.id === clipId);
          if (i < 0) return clips;
          next.splice(i, 1, left, right);
          return next;
        }),
      revert: (d) =>
        mapClips(d, trackId, (clips) => {
          const i = clips.findIndex((c) => c.id === left.id);
          if (i < 0) return clips;
          const next = [...clips];
          next.splice(i, 2, clip);
          return next;
        }),
    };
  },
  setMarkers(doc: TimelineDoc, markers: TimelineMarkers): Command {
    const was = doc.markers;
    return {
      label: "Маркеры битов",
      apply: (d) => ({ ...d, markers }),
      revert: (d) => ({ ...d, markers: was }),
    };
  },
  setSnapToBeats(doc: TimelineDoc, on: boolean): Command {
    const was = doc.snapToBeats !== false;
    return {
      label: on ? "Привязка к битам" : "Свободное время",
      apply: (d) => ({ ...d, snapToBeats: on }),
      revert: (d) => ({ ...d, snapToBeats: was }),
    };
  },
  duplicatePlanToTrack(doc: TimelineDoc, planId: string, fromTrackId: string, toTrackId: string): Command {
    const prev = doc.tracks.find((t) => t.id === fromTrackId)?.plans.find((p) => p.id === planId);
    const copy: Plan = { ...emptyPlan(), ...prev, id: uid(), status: "empty", generationId: null, draftAssetId: null, outputAssetId: null, error: null };
    return {
      label: "Дублировать план на дорожку",
      apply: (d) => mapPlans(d, toTrackId, (ps) => [...ps, copy]),
      revert: (d) => mapPlans(d, toTrackId, (ps) => ps.filter((p) => p.id !== copy.id)),
    };
  },
  setTrackMuted(doc: TimelineDoc, trackId: string, muted: boolean): Command {
    const was = !!doc.tracks.find((t) => t.id === trackId)?.muted;
    return {
      label: muted ? "Выключить дорожку" : "Включить дорожку",
      apply: (d) => mapTrack(d, trackId, (t) => ({ ...t, muted })),
      revert: (d) => mapTrack(d, trackId, (t) => ({ ...t, muted: was })),
    };
  },
  /** Flatten visible plan results onto the video track (top plan-track wins overlaps). */
  compilePlansToVideo(doc: TimelineDoc): Command {
    const vId = videoTrack(doc).id;
    const prevClips = [...videoTrack(doc).clips];
    const pts = planTracks(doc).filter((t) => !t.muted);
    const solos = pts.filter((t) => t.solo);
    const visible = solos.length ? solos : pts;
    // Gather intervals; higher track (earlier in list) wins
    type Seg = { start: number; end: number; assetId: number; sourceIn: number };
    const segs: Seg[] = [];
    for (const t of visible) {
      for (const p of [...t.plans].sort((a, b) => a.start - b.start)) {
        const assetId = p.outputAssetId ?? p.draftAssetId;
        if (!assetId) continue;
        const start = p.start;
        const end = p.start + p.duration;
        // Subtract overlaps already claimed by higher tracks
        let pieces: [number, number][] = [[start, end]];
        for (const s of segs) {
          const next: [number, number][] = [];
          for (const [a, b] of pieces) {
            if (b <= s.start || a >= s.end) {
              next.push([a, b]);
              continue;
            }
            if (a < s.start) next.push([a, s.start]);
            if (b > s.end) next.push([s.end, b]);
          }
          pieces = next;
        }
        for (const [a, b] of pieces) {
          if (b - a >= MIN_CLIP) segs.push({ start: a, end: b, assetId, sourceIn: (p.sourceIn ?? 0) + a - p.start });
        }
      }
    }
    segs.sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const segment of segs) {
      if (Math.round(segment.start * 24) !== Math.round(cursor * 24)) {
        throw new Error(`Нет готового кадра около ${cursor.toFixed(2)} с — заполните пропуск перед сборкой`);
      }
      cursor = segment.end;
    }
    const expectedEnd = Math.max(0, ...visible.flatMap((t) => t.plans.map((p) => p.start + p.duration)));
    if (Math.round(cursor * 24) !== Math.round(expectedEnd * 24)) throw new Error("В конце остались неготовые планы");
    const clips: Clip[] = segs.map((s) => ({
      id: uid(),
      assetId: s.assetId,
      in: s.sourceIn,
      out: s.sourceIn + s.end - s.start,
      muted: doc.tracks.some((t) => t.kind === "audio" && !t.muted && t.clips.length > 0),
    }));
    return {
      label: "Собрать планы на видео",
      apply: (d) => mapClips(d, vId, () => clips),
      revert: (d) => mapClips(d, vId, () => prevClips),
    };
  },
};
