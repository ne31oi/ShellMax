import { describe, expect, it } from "vitest";
import { comparisonTimes, comparisonWindow } from "./comparison-window";

describe("comparison fragment", () => {
  it("aligns the beginning and middle of an edited fragment with its source", () => {
    const window = comparisonWindow(12, 2, 4.25);
    expect(window.duration).toBe(2);
    expect(comparisonTimes(0, window)).toEqual({ relative: 0, a: 4.25, b: 0 });
    expect(comparisonTimes(1, window)).toEqual({ relative: 1, a: 5.25, b: 1 });
  });
  it("limits playback to the processed frames even if the audio extends the container", () => {
    const window = comparisonWindow(12, 2.2, 4, 0, 22 / 24);
    expect(window.duration).toBe(22 / 24);
    const times = comparisonTimes(10, window);
    expect(times.a).toBeLessThan(4 + 22 / 24);
    expect(times.b).toBeLessThan(22 / 24);
  });
  it("preserves ordinary comparison and confines both sides to available media", () => {
    expect(comparisonWindow(3, 2)).toEqual({ startA: 0, startB: 0, duration: 2 });
    expect(comparisonWindow(3, 2, 2.5).duration).toBe(0.5);
    expect(comparisonWindow(3, 2, 4).duration).toBe(0);
    expect(comparisonWindow(NaN, 2).duration).toBe(0);
  });
});
