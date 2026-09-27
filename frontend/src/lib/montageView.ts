/** Sticky montage view prefs (zoom / playhead) — per project, localStorage. */

export type MontageViewPrefs = {
  zoom: number;
  playhead: number;
};

const KEY = (projectId: number) => `sm.montage.${projectId}`;

function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.max(0.5, Math.min(4, Math.round(z * 100) / 100));
}

export function loadMontageView(projectId: number): MontageViewPrefs {
  try {
    const raw = localStorage.getItem(KEY(projectId));
    if (!raw) return { zoom: 1, playhead: 0 };
    const o = JSON.parse(raw) as Partial<MontageViewPrefs>;
    return {
      zoom: clampZoom(Number(o.zoom) || 1),
      playhead: Math.max(0, Number(o.playhead) || 0),
    };
  } catch {
    return { zoom: 1, playhead: 0 };
  }
}

export function saveMontageView(projectId: number, patch: Partial<MontageViewPrefs>) {
  const cur = loadMontageView(projectId);
  const next: MontageViewPrefs = {
    zoom: patch.zoom != null ? clampZoom(patch.zoom) : cur.zoom,
    playhead: patch.playhead != null ? Math.max(0, patch.playhead) : cur.playhead,
  };
  try {
    localStorage.setItem(KEY(projectId), JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
}
