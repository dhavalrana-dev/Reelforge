import { describe, expect, it } from "vitest";
import {
  groupWords,
  invertRanges,
  keepRangesFromSilences,
  normalizeRanges,
  outputFrameToSourceTime,
  remapTimedItems,
  resolveTimeline,
  sourceToOutputFrame,
  sourceToOutputTime,
} from "../src";

describe("ranges", () => {
  it("merges, sorts and clamps", () => {
    expect(normalizeRanges([{ start: 5, end: 8 }, { start: -1, end: 2 }, { start: 1, end: 3 }, { start: 7, end: 12 }], 10)).toEqual([
      { start: 0, end: 3 },
      { start: 5, end: 10 },
    ]);
  });

  it("inverts", () => {
    expect(invertRanges([{ start: 2, end: 4 }], 6)).toEqual([{ start: 0, end: 2 }, { start: 4, end: 6 }]);
    expect(invertRanges([], 6)).toEqual([{ start: 0, end: 6 }]);
  });

  it("turns silences into padded keep ranges, ignoring short pauses", () => {
    const keep = keepRangesFromSilences(
      [{ start: 0, end: 0.5 }, { start: 2, end: 4 }, { start: 5, end: 5.2 }, { start: 9, end: 10 }],
      10,
      { padding: 0.1, minSilence: 0.4 },
    );
    // Padding is kept on the speech side of leading/trailing silences too.
    expect(keep).toEqual([{ start: 0.4, end: 2.1 }, { start: 3.9, end: 9.1 }]);
  });
});

describe("resolveTimeline", () => {
  const tl = resolveTimeline([{ start: 0, end: 2.1 }, { start: 3.9, end: 6 }], 30);

  it("snaps to the frame grid and lays segments end to end", () => {
    expect(tl.segments).toEqual([
      { sourceStart: 0, sourceEnd: 63 / 30, outputStartFrame: 0, outputEndFrame: 63 },
      { sourceStart: 117 / 30, sourceEnd: 6, outputStartFrame: 63, outputEndFrame: 126 },
    ]);
    expect(tl.durationFrames).toBe(126);
  });

  it("maps source times across a cut", () => {
    expect(sourceToOutputFrame(tl, 1)).toBe(30);
    expect(sourceToOutputTime(tl, 3)).toBeNull();
    expect(sourceToOutputFrame(tl, 5)).toBe(63 + 33);
  });

  it("round-trips output frames to source time", () => {
    for (const frame of [0, 62, 63, 100, 125]) {
      const src = outputFrameToSourceTime(tl, frame)!;
      expect(sourceToOutputFrame(tl, src)).toBe(frame);
    }
    expect(outputFrameToSourceTime(tl, 126)).toBeNull();
  });

  it("frame 150 at 30 fps is exactly 5 seconds when nothing is cut", () => {
    const full = resolveTimeline([{ start: 0, end: 10 }], 30);
    expect(outputFrameToSourceTime(full, 150)).toBe(5);
  });
});

describe("remapTimedItems", () => {
  const tl = resolveTimeline([{ start: 0, end: 2 }, { start: 4, end: 6 }], 30);
  const words = [
    { text: "hello", start: 0.5, end: 0.9 },
    { text: "gone", start: 2.5, end: 3 },
    { text: "across", start: 1.8, end: 4.3 },
    { text: "world", start: 4.5, end: 5 },
  ];

  it("keeps captions in sync after cuts", () => {
    const out = remapTimedItems(words, tl);
    expect(out.map((w) => w.text)).toEqual(["hello", "across", "world"]);
    const across = out[1]!;
    expect(across.outputStart).toBeCloseTo(1.8);
    expect(across.outputEnd).toBeCloseTo(2.3);
    expect(out[2]!.outputStart).toBeCloseTo(2.5);
  });
});

describe("groupWords", () => {
  it("splits on word count and long pauses", () => {
    const w = (text: string, start: number) => ({ text, start, end: start + 0.2 });
    const pages = groupWords([w("a", 0), w("b", 0.3), w("c", 0.6), w("d", 0.9), w("e", 1.2), w("f", 3)], { maxWords: 4 });
    expect(pages.map((p) => p.text)).toEqual(["a b c d", "e", "f"]);
  });
});
