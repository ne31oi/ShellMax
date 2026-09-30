import type { MaskKey, MaskLayer, ShapeMaskLayer } from "../api/types";

/** Matches Fantastic's linear keyframe interpolation, in source-clip seconds. */
export function maskAt(layer: MaskLayer, t: number): MaskKey | null {
  if (layer.kind === "auto") return null;
  const keys = layer.keys;
  if (!keys.length || !layer.visible) return null;
  if (t <= keys[0].t) return { ...keys[0], t };
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1], b = keys[i], u = (t - a.t) / (b.t - a.t);
      return { t, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u,
        w: a.w + (b.w - a.w) * u, h: a.h + (b.h - a.h) * u, rot: a.rot + (b.rot - a.rot) * u };
    }
  }
  return { ...keys[keys.length - 1], t };
}

export function putMaskKey(layer: ShapeMaskLayer, key: MaskKey, origin = 0): ShapeMaskLayer {
  const t = origin + Math.round((key.t - origin) * 24) / 24;
  return { ...layer, keys: [...layer.keys.filter((k) => Math.abs(k.t - t) > 0.001), { ...key, t }].sort((a, b) => a.t - b.t) };
}
