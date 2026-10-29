import { describe, expect, it } from "vitest";
import { cubicBezier, easing, keyframes, mapRange, spring } from "../src";

describe("mapRange", () => {
  it("interpolates and clamps by default", () => {
    expect(mapRange(15, [0, 30], [0, 1])).toBe(0.5);
    expect(mapRange(-5, [0, 30], [0, 1])).toBe(0);
    expect(mapRange(45, [0, 30], [0, 1])).toBe(1);
  });

  it("extends when asked", () => {
    expect(mapRange(45, [0, 30], [0, 1], { extrapolateRight: "extend" })).toBe(1.5);
  });

  it("handles multi-point ranges", () => {
    expect(mapRange(45, [0, 30, 60], [0, 1, 0])).toBe(0.5);
  });

  it("rejects bad ranges", () => {
    expect(() => mapRange(0, [0, 0], [0, 1])).toThrow();
    expect(() => mapRange(0, [0, 1], [0])).toThrow();
  });
});

describe("easing", () => {
  it("all easings hit their endpoints", () => {
    for (const [name, fn] of Object.entries(easing)) {
      expect(fn(0), name).toBeCloseTo(0, 6);
      expect(fn(1), name).toBeCloseTo(1, 6);
    }
  });

  it("cubicBezier(0,0,1,1) is linear and ease curves are monotonic", () => {
    const lin = cubicBezier(0, 0, 1, 1);
    const std = cubicBezier(0.4, 0, 0.2, 1);
    let prev = 0;
    for (let t = 0; t <= 1; t += 0.05) {
      expect(lin(t)).toBeCloseTo(t, 5);
      expect(std(t)).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = std(t);
    }
  });
});

describe("spring", () => {
  it("starts at 0, settles at 1, and is deterministic per frame", () => {
    expect(spring(0, 30)).toBe(0);
    expect(spring(300, 30)).toBeCloseTo(1, 4);
    expect(spring(17, 30)).toBe(spring(17, 30));
  });

  it("underdamped springs overshoot; critically/over-damped ones don't", () => {
    const frames = Array.from({ length: 120 }, (_, f) => f);
    expect(Math.max(...frames.map((f) => spring(f, 30, { damping: 5 })))).toBeGreaterThan(1);
    expect(Math.max(...frames.map((f) => spring(f, 30, { damping: 20 })))).toBeLessThanOrEqual(1);
    expect(Math.max(...frames.map((f) => spring(f, 30, { damping: 40 })))).toBeLessThanOrEqual(1);
  });
});

describe("keyframes", () => {
  it("holds outside the track and eases between keys", () => {
    const track = [
      { frame: 10, value: 0 },
      { frame: 20, value: 100, easing: easing.inQuad },
    ];
    expect(keyframes(0, track)).toBe(0);
    expect(keyframes(15, track)).toBe(25);
    expect(keyframes(99, track)).toBe(100);
  });
});
