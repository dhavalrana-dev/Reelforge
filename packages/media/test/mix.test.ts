import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildMixGraph,
  defaultTools,
  detectBlack,
  findWorkerPython,
  measureOutputLoudness,
  probe,
  renderMix,
  run,
  runOrThrow,
  synthMusic,
  synthSfx,
} from "../src";

describe("buildMixGraph", () => {
  it("delays each track, groups by role and ducks music under voice", () => {
    const g = buildMixGraph(
      [
        { role: "music", start: 0, gainDb: -12 },
        { role: "voice", start: 1.25, gainDb: 0 },
        { role: "voice", start: 4, gainDb: 0 },
        { role: "sfx", start: 2, gainDb: -6 },
      ],
      10,
    );
    expect(g).toContain("[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.00dB,adelay=1250:all=1,apad[t1]");
    expect(g).toContain("volume=-12.00dB");
    expect(g).toContain("[t1][t2]amix=inputs=2:normalize=0:duration=longest[voice]");
    expect(g).toContain("[voice]asplit=2[vkey][vmix];[music][vkey]sidechaincompress");
    expect(g).toContain("[vmix][ducked][sfx]amix=inputs=3:normalize=0:duration=longest,atrim=0:10.000000,asetpts=PTS-STARTPTS[mix]");
  });

  it("doesn't duck when there is no voice", () => {
    const g = buildMixGraph([{ role: "music", start: 0, gainDb: 0 }, { role: "sfx", start: 1, gainDb: 0 }], 5);
    expect(g).not.toContain("sidechaincompress");
    expect(g).toContain("[music][sfx]amix=inputs=2");
  });
});

const ffmpegAvailable = await run(defaultTools.ffmpeg, ["-version"]).then((r) => r.code === 0, () => false);

describe.skipIf(!ffmpegAvailable)("mixing and checks (ffmpeg)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "reelforge-mix-"));
    // "Music" is a 200 Hz tone, "voice" a 2 kHz tone: separable by filtering.
    await runOrThrow(defaultTools.ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=200:d=10:r=48000", join(dir, "music.wav")]);
    await runOrThrow(defaultTools.ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=2000:d=3:r=48000", "-af", "volume=6dB", join(dir, "voice.wav")]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const bandRms = async (file: string, at: number) => {
    const { stderr } = await runOrThrow(defaultTools.ffmpeg, [
      "-hide_banner", "-nostats", "-ss", String(at), "-t", "1", "-i", file, "-af", "lowpass=f=400,lowpass=f=400,astats=metadata=0", "-f", "null", "-",
    ]);
    return Number([...stderr.matchAll(/RMS level dB:\s*(-?[\d.]+)/g)].at(-1)![1]);
  };

  it("ducks music by over 10 dB while the voice speaks, restores it after, and hits the loudness target", async () => {
    const output = join(dir, "mix.wav");
    const report = await renderMix({
      tracks: [
        { path: join(dir, "music.wav"), role: "music", start: 0, gainDb: 0 },
        { path: join(dir, "voice.wav"), role: "voice", start: 4, gainDb: 0 },
      ],
      duration: 10,
      workDir: dir,
      output,
      loudness: -16,
    });
    expect(report.integrated).toBeCloseTo(-16, 0);
    expect(report.truePeak).toBeLessThanOrEqual(-0.5);
    const premix = join(dir, "premix.wav");
    const before = await bandRms(premix, 1.5);
    expect(before - (await bandRms(premix, 5.5))).toBeGreaterThan(10);
    expect(Math.abs(before - (await bandRms(premix, 8.5)))).toBeLessThan(1.5);
    const info = await probe(output);
    expect(info.duration).toBeCloseTo(10, 1);
    expect(info.audio).toMatchObject({ channels: 2, sampleRate: 48000 });
  });

  it("finds a second of black, and not a dark frame with something on it", async () => {
    const gap = join(dir, "gap.mp4");
    await runOrThrow(defaultTools.ffmpeg, [
      "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=30:d=1", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=30:d=1.5",
      "-filter_complex", "[0][1]concat=n=2:v=1:a=0", gap,
    ]);
    const black = await detectBlack(gap);
    expect(black).toHaveLength(1);
    expect(black[0]!.start).toBeCloseTo(1, 1);
    const dark = join(dir, "dark.mp4");
    await runOrThrow(defaultTools.ffmpeg, [
      "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x0B0F17:s=320x240:r=30:d=2",
      "-vf", "drawbox=x=100:y=80:w=120:h=60:color=0x38E1FF:t=fill", dark,
    ]);
    expect(await detectBlack(dark)).toEqual([]);
  });
});

const synthAvailable =
  ffmpegAvailable && (await run(findWorkerPython(), ["-c", "import numpy"]).then((r) => r.code === 0, () => false));

describe.skipIf(!synthAvailable)("procedural audio", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "reelforge-synth-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.each(["calm", "upbeat", "tense"] as const)("%s music: the requested length, stereo, peaking at -3 dBFS, and deterministic", async (mood) => {
    const a = join(dir, `${mood}-a.wav`);
    const b = join(dir, `${mood}-b.wav`);
    await synthMusic(a, 6, mood, 3);
    await synthMusic(b, 6, mood, 3);
    const info = await probe(a);
    expect(info.duration).toBeCloseTo(6, 2);
    expect(info.audio).toMatchObject({ channels: 2, sampleRate: 48000 });
    const loud = await measureOutputLoudness(a);
    expect(loud.truePeak).toBeLessThan(0);
    expect(loud.integrated).toBeGreaterThan(-30);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(a).equals(readFileSync(b))).toBe(true);
  });

  it.each(["whoosh", "pop", "tick", "rise"] as const)("%s is a short, non-silent effect", async (kind) => {
    const f = join(dir, `${kind}.wav`);
    await synthSfx(kind, f);
    const info = await probe(f);
    expect(info.duration).toBeLessThan(1.5);
    expect((await measureOutputLoudness(f)).truePeak).toBeGreaterThan(-12);
  });
});
