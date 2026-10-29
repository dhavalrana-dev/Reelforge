import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keepRangesFromSilences, resolveTimeline } from "@reelforge/core";
import { defaultTools, detectSilences, probe, renderCuts, run, runOrThrow, validateOutput } from "../src";

const ffmpegAvailable = await run(defaultTools.ffmpeg, ["-version"]).then((r) => r.code === 0, () => false);

/**
 * Fixture: 6 s landscape test pattern. Audio is a tone for 0-2 s and 4-6 s
 * with digital silence in between, standing in for a pause in speech.
 */
describe.skipIf(!ffmpegAvailable)("recorded-video pipeline (ffmpeg)", () => {
  let dir: string;
  let source: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "reelforge-e2e-"));
    source = join(dir, "talking-head.mp4");
    await runOrThrow(defaultTools.ffmpeg, [
      "-hide_banner", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=6",
      "-f", "lavfi", "-i", "aevalsrc='if(lt(t,2)+gte(t,4),0.4*sin(2*PI*440*t),0)':s=48000:d=6",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
      source,
    ]);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("ingests, cuts the silence, reframes to 9:16 and validates the export", async () => {
    const info = await probe(source);
    expect(info.orientation).toBe("landscape");
    expect(info.video?.fps).toBe(30);

    const silences = await detectSilences(source, info.duration);
    expect(silences).toHaveLength(1);
    expect(silences[0]!.start).toBeCloseTo(2, 1);
    expect(silences[0]!.end).toBeCloseTo(4, 1);

    const keep = keepRangesFromSilences(silences, info.duration, { padding: 0.1 });
    const timeline = resolveTimeline(keep, 30);
    const expectedSeconds = timeline.durationFrames / 30;
    expect(expectedSeconds).toBeGreaterThan(4.1);
    expect(expectedSeconds).toBeLessThan(4.4);

    const output = join(dir, "reel.mp4");
    await renderCuts({ input: source, output, timeline, width: 1080, height: 1920, hasAudio: true });

    const report = await validateOutput(output, { width: 1080, height: 1920, fps: 30, duration: expectedSeconds });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.info.orientation).toBe("portrait");
  });

  it("refuses to overwrite the source recording", async () => {
    const timeline = resolveTimeline([{ start: 0, end: 1 }], 30);
    await expect(renderCuts({ input: source, output: source, timeline, width: 1080, height: 1920, hasAudio: true })).rejects.toThrow(/differ/);
  });
});
