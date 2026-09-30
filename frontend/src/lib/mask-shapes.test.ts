import { describe, expect, it } from "vitest";
import type { MaskLayer } from "../api/types";
import { maskAt, putMaskKey } from "./mask-shapes";

const layer: MaskLayer = { kind: "rect", motion: "linear", mode: "add", visible: true,
  keys: [{ t: 0, x: 0.2, y: 0.4, w: 0.2, h: 0.4, rot: 0 }, { t: 2, x: 0.8, y: 0.6, w: 0.4, h: 0.2, rot: 0 }] };
describe("mask keyframes", () => {
  it("matches the model's linear interpolation", () => {
    const shape = maskAt(layer, 1)!;
    expect(shape.x).toBeCloseTo(0.5);
    expect(shape.y).toBeCloseTo(0.5);
    expect(shape.w).toBeCloseTo(0.3);
    expect(shape.h).toBeCloseTo(0.3);
  });
  it("replaces a key on the same source frame and holds outside the keyed span", () => {
    const updated = putMaskKey(layer, { ...layer.keys[0], t: 0.01, x: 0.3 });
    expect(updated.keys).toHaveLength(2);
    expect(maskAt(updated, 3)?.x).toBe(0.8);
    expect(maskAt({ ...layer, visible: false }, 1)).toBeNull();
  });
  it("keeps keys inside a fragment starting between source frames", () => {
    const origin = 0.1;
    const updated = putMaskKey({ ...layer, keys: [] }, { ...layer.keys[0], t: origin }, origin);
    expect(updated.keys[0].t).toBe(origin);
    const next = putMaskKey(updated, { ...updated.keys[0], t: origin + 1 / 24 }, origin);
    expect(next.keys).toHaveLength(2);
    expect(next.keys[1].t).toBeCloseTo(origin + 1 / 24);
  });
});
