import { describe, expect, it } from "vitest";
import { resolveTimeline } from "@reelforge/core";
import { buildCutFilter, parseProbe, parseSilenceLog } from "../src";

describe("parseSilenceLog", () => {
  it("pairs starts and ends and closes a trailing silence", () => {
    const log = [
      "[silencedetect @ 0x1] silence_start: -0.002",
      "[silencedetect @ 0x1] silence_end: 0.6 | silence_duration: 0.6",
      "[silencedetect @ 0x1] silence_start: 2.0013",
      "[silencedetect @ 0x1] silence_end: 4.0021 | silence_duration: 2.0008",
      "[silencedetect @ 0x1] silence_start: 9.5",
    ].join("\r\n");
    expect(parseSilenceLog(log, 10)).toEqual([
      { start: 0, end: 0.6 },
      { start: 2.0013, end: 4.0021 },
      { start: 9.5, end: 10 },
    ]);
  });
});

describe("parseProbe", () => {
  it("applies rotation, detects VFR, and warns about missing audio", () => {
    const info = parseProbe("phone.mov", {
      format: { format_name: "mov,mp4", duration: "12.5", size: "1000" },
      streams: [
        {
          codec_type: "video",
          codec_name: "hevc",
          width: 1920,
          height: 1080,
          avg_frame_rate: "2850/100",
          r_frame_rate: "30/1",
          side_data_list: [{ rotation: -90 }],
        },
      ],
    });
    expect(info.video).toMatchObject({ rotation: 270, displayWidth: 1080, displayHeight: 1920, variableFrameRate: true });
    expect(info.orientation).toBe("portrait");
    expect(info.duration).toBe(12.5);
    expect(info.warnings.join("|")).toMatch(/variable frame rate.*rotation.*no audio/);
  });
});

describe("buildCutFilter", () => {
  it("resamples to output fps before trimming and concatenates every segment", () => {
    const tl = resolveTimeline([{ start: 0, end: 1 }, { start: 2, end: 3 }], 30);
    const f = buildCutFilter({ timeline: tl, width: 1080, height: 1920, hasAudio: true });
    expect(f.indexOf("fps=30")).toBeLessThan(f.indexOf("trim="));
    expect(f).toContain("split=2[vs0][vs1]");
    expect(f).toContain("trim=start=2.000000:end=3.000000");
    expect(f).toContain("[v0][a0][v1][a1]concat=n=2:v=1:a=1[vcat][aout]");
    expect(f.endsWith("[vcat]null[vout]")).toBe(true);
    const layered = buildCutFilter({ timeline: tl, width: 1080, height: 1920, hasAudio: true, overlay: true, captionsFile: "c.ass" });
    expect(layered).toContain("[vcat][1:v]overlay=0:0:format=auto:eof_action=pass[vov];[vov]ass=captions.ass[vsub];[vsub]null[vout]");
    expect(buildCutFilter({ timeline: tl, width: 1080, height: 1920, hasAudio: false })).not.toContain("[0:a]");
  });
});
