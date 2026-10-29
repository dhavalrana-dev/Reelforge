import { describe, expect, it } from "vitest";
import { captionPagesForTimeline, resolveTimeline } from "@reelforge/core";
import { CAPTION_STYLES, assColor, assTagColor, assTime, buildAssCaptions, escapeAss } from "../src";

describe("ASS helpers", () => {
  it("formats colors as &HAABBGGRR", () => {
    expect(assColor("#FFD84D")).toBe("&H004DD8FF");
    expect(assColor("#000000", 0x80)).toBe("&H80000000");
    expect(() => assColor("red")).toThrow();
  });

  it("formats override-tag colors as &HBBGGRR&", () => {
    expect(assTagColor("#FFD84D")).toBe("&H4DD8FF&");
  });

  it("formats times as H:MM:SS.cc", () => {
    expect(assTime(0)).toBe("0:00:00.00");
    expect(assTime(62.345)).toBe("0:01:02.35");
    expect(assTime(3725.5)).toBe("1:02:05.50");
  });

  it("neutralises override characters", () => {
    expect(escapeAss("a {\\b1} b")).toBe("a (/b1) b");
  });
});

describe("captions through cuts", () => {
  // Source: "hello world" at 0-1 s, pause until 4 s, "again friends" at 4-5 s.
  const words = [
    { text: "hello", start: 0.1, end: 0.5 },
    { text: "world", start: 0.5, end: 1.0 },
    { text: "again", start: 4.0, end: 4.4 },
    { text: "friends", start: 4.4, end: 5.0 },
  ];
  const tl = resolveTimeline([{ start: 0, end: 1.2 }, { start: 3.9, end: 5.2 }], 30);

  it("starts a new page at every cut even when the remaining gap is short", () => {
    const tight = resolveTimeline([{ start: 0, end: 1.0 }, { start: 4.0, end: 5.0 }], 30);
    expect(captionPagesForTimeline(words, tight, { maxWords: 10 }).map((p) => p.text)).toEqual(["hello world", "again friends"]);
  });

  it("shifts words after a cut earlier by the removed duration", () => {
    const pages = captionPagesForTimeline(words, tl);
    expect(pages.map((p) => p.text)).toEqual(["hello world", "again friends"]);
    expect(pages[1]!.start).toBeCloseTo(4.0 - 2.7, 5);
  });

  it("emits one back-to-back event per word with the active word highlighted", () => {
    const pages = captionPagesForTimeline(words, tl);
    const ass = buildAssCaptions(pages, { width: 1080, height: 1920, style: CAPTION_STYLES["bold-creator"] });
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(events).toHaveLength(4);

    const times = events.map((e) => e.split(",").slice(1, 3));
    expect(times[0]![1]).toBe(times[1]![0]); // no gap between words on a page
    expect(events[0]).toContain("\\fad(60,0)");
    expect(events[1]).not.toContain("\\fad");
    expect(events[1]).toMatch(/HELLO \{\\c&H7AF03C&\\fscx118\\fscy118\}WORLD\{/);
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("Style: Caption,Arial Black,86,");
  });
});
