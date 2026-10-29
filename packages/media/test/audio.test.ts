import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveTimeline } from "@reelforge/core";
import {
  audioCleanupFilter,
  buildCutFilter,
  cleanupChain,
  defaultTools,
  detectSilences,
  expanderThreshold,
  parseEbur128Summary,
  parseNoiseProfile,
  renderCuts,
  run,
  runOrThrow,
  validateOutput,
} from "../src";

describe("audio chain", () => {
  it("builds clean-up stages from options", () => {
    expect(cleanupChain()).toEqual(["highpass=f=80", "afftdn=nr=10:nf=-50:tn=1", expect.stringMatching(/^acompressor=/)]);
    expect(cleanupChain({ denoise: "off", highpass: 0, compress: false })).toEqual([]);
    expect(cleanupChain({ denoise: "strong" })[1]).toBe("afftdn=nr=20:nf=-40:tn=1");
  });

  it("places the expander 10 dB above the noise floor, and only when it can't touch speech", () => {
    expect(expanderThreshold({ noiseFloor: -50, speechLevel: -17 })).toBe(-40);
    expect(expanderThreshold({ noiseFloor: -30, speechLevel: -12 })).toBe(-30); // capped
    expect(expanderThreshold({ noiseFloor: -32, speechLevel: -26 })).toBeNull(); // noise too close to speech
    expect(expanderThreshold({ noiseFloor: -90, speechLevel: -20 })).toBeNull(); // already clean
    const chain = cleanupChain({}, { noiseFloor: -50, speechLevel: -17 });
    expect(chain[2]).toBe("agate=threshold=0.01:ratio=4:range=0.125:attack=5:release=200:knee=2.828");
    expect(cleanupChain({ expand: false }, { noiseFloor: -50, speechLevel: -17 }).some((s) => s.startsWith("agate"))).toBe(false);
  });

  it("summarises per-window levels into a noise profile", () => {
    const log = [-60, -50, -48, -20, -18, -17, -16, -15, "-inf", -19]
      .map((v) => `[Parsed_ametadata_3 @ 0x1] lavfi.astats.Overall.RMS_level=${v}`)
      .join("\n");
    // Sorted: -inf(-120), -60, -50, -48, -20, -19, ... → 10th percentile index 1, median index 5.
    expect(parseNoiseProfile(log)).toEqual({ noiseFloor: -60, speechLevel: -19 });
  });

  it("applies make-up gain, then limits peaks 1 dB under the true-peak ceiling, at 48 kHz", () => {
    const f = audioCleanupFilter({ truePeak: -1 }, 10.237);
    expect(f.endsWith("volume=10.24dB,alimiter=limit=0.794328:attack=5:release=50:level=0,aresample=48000")).toBe(true);
  });

  it("routes joined audio through the chain", () => {
    const tl = resolveTimeline([{ start: 0, end: 1 }, { start: 2, end: 3 }], 30);
    const f = buildCutFilter({ timeline: tl, width: 1080, height: 1920, hasAudio: true, audioFilter: "volume=2" });
    expect(f).toContain("concat=n=2:v=1:a=1[vcat][acat];[acat]volume=2[aout]");
  });

  it("parses the ebur128 summary, including silence", () => {
    expect(parseEbur128Summary("Summary:\n    I:         -inf LUFS\n    Peak:      -inf dBFS\n")).toEqual({ integrated: -Infinity, truePeak: -Infinity });
    const ebu = "Summary:\n\n  Integrated loudness:\n    I:         -14.2 LUFS\n    Threshold: -24.6 LUFS\n\n  True peak:\n    Peak:       -1.3 dBFS\n";
    expect(parseEbur128Summary(ebu)).toEqual({ integrated: -14.2, truePeak: -1.3 });
  });
});

const ffmpegAvailable = await run(defaultTools.ffmpeg, ["-version"]).then((r) => r.code === 0, () => false);

/** RMS level (dBFS) of [start, start + duration) of a file's audio. */
async function rmsDb(file: string, start: number, duration: number): Promise<number> {
  const { stderr } = await runOrThrow(defaultTools.ffmpeg, [
    "-hide_banner", "-nostats", "-ss", String(start), "-t", String(duration), "-i", file, "-vn", "-af", "astats=metadata=0", "-f", "null", "-",
  ]);
  const all = [...stderr.matchAll(/RMS level dB:\s*(-?[\d.]+|-inf)/g)];
  const last = all[all.length - 1]?.[1];
  if (!last) throw new Error("astats printed no RMS level");
  return last === "-inf" ? -120 : Number(last);
}

/**
 * Fixture: a 330 Hz tone (standing in for speech) at 0-2 s and 4-6 s, with
 * pink noise at roughly -32 dBFS throughout: loud enough to hide the pause
 * from plain silence detection.
 */
describe.skipIf(!ffmpegAvailable)("audio clean-up (ffmpeg)", () => {
  let dir: string;
  let source: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "reelforge-audio-"));
    source = join(dir, "noisy.mp4");
    await runOrThrow(defaultTools.ffmpeg, [
      "-hide_banner", "-y",
      "-f", "lavfi", "-i", "color=c=0x202020:size=640x360:rate=30:duration=6",
      "-f", "lavfi", "-i", "aevalsrc='0.2*sin(2*PI*330*t)*(lt(t,2)+gte(t,4))':s=48000:d=6",
      "-f", "lavfi", "-i", "anoisesrc=a=0.03:c=pink:d=6:r=48000:seed=7",
      "-filter_complex", "[1][2]amix=inputs=2:normalize=0[a]",
      "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest",
      source,
    ]);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds pauses in noisy audio only after denoising", async () => {
    expect(await detectSilences(source, 6)).toEqual([]);
    const silences = await detectSilences(source, 6, { preFilter: cleanupChain({ denoise: "strong", compress: false }) });
    expect(silences).toHaveLength(1);
    expect(silences[0]!.start).toBeCloseTo(2, 0);
    expect(silences[0]!.end).toBeCloseTo(4, 0);
  });

  it("hits the loudness target, stays under the true-peak ceiling and lowers the noise floor", async () => {
    const timeline = resolveTimeline([{ start: 0, end: 6 }], 30);
    const output = join(dir, "clean.mp4");
    await renderCuts({ input: source, output, timeline, width: 540, height: 960, hasAudio: true, audioCleanup: { loudness: -16, denoise: "strong" } });

    const report = await validateOutput(output, { width: 540, height: 960, fps: 30, duration: 6, loudness: -16, truePeak: -1 });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);

    // Signal-to-noise: tone section vs. pause section, before and after.
    const snrBefore = (await rmsDb(source, 0.5, 1)) - (await rmsDb(source, 2.5, 1));
    const snrAfter = (await rmsDb(output, 0.5, 1)) - (await rmsDb(output, 2.5, 1));
    expect(snrAfter - snrBefore).toBeGreaterThan(12);
  });

  it("flags clipping in an unprocessed hot recording", async () => {
    const hot = join(dir, "hot.mp4");
    await runOrThrow(defaultTools.ffmpeg, [
      "-hide_banner", "-y",
      "-f", "lavfi", "-i", "color=c=black:size=320x240:rate=30:duration=1",
      "-f", "lavfi", "-i", "aevalsrc='1.4*sin(2*PI*1000*t)':s=48000:d=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-shortest", hot.replace(".mp4", ".mov"),
    ]);
    const report = await validateOutput(hot.replace(".mp4", ".mov"));
    expect(report.checks.find((c) => c.name === "audio peak")?.ok).toBe(false);
  });
});
