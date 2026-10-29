import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateProject } from "@reelforge/core";
import { defaultTools, run, runOrThrow } from "@reelforge/media";
import { planRecording } from "../src";

const ffmpegAvailable = await run(defaultTools.ffmpeg, ["-version"]).then((r) => r.code === 0, () => false);

/** Tone at 0-2 s and 4-6 s, silence between: the planner should cut the pause. */
describe.skipIf(!ffmpegAvailable)("planRecording", () => {
  let dir: string;
  let source: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "reelforge-plan-"));
    source = join(dir, "media", "take 1.mp4");
    mkdirSync(join(dir, "media"));
    await runOrThrow(defaultTools.ffmpeg, [
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=6",
      "-f", "lavfi", "-i", "aevalsrc='if(lt(t,2)+gte(t,4),0.4*sin(2*PI*440*t),0)':s=48000:d=6",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
      source,
    ]);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a valid, editable project with frame-snapped cuts and relative paths", async () => {
    const projectFile = join(dir, "projects", "reel.json");
    mkdirSync(join(dir, "projects"));
    const result = await planRecording(source, projectFile, {
      removeSilence: true,
      audio: { loudness: -16 },
      title: "Hello",
      lowerThird: { title: "Ada", subtitle: "Engineer" },
    });

    expect(result.silences).toHaveLength(1);
    expect(result.outputDuration).toBeGreaterThan(4.1);
    expect(result.outputDuration).toBeLessThan(4.4);

    const json = JSON.parse(readFileSync(projectFile, "utf8"));
    const { project, issues } = validateProject(json);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(project!.sources[0]!.path).toBe("../media/take 1.mp4");
    expect(project!.edit!.keep).toHaveLength(2);
    for (const r of project!.edit!.keep) {
      expect(Math.abs(r.start * 30 - Math.round(r.start * 30))).toBeLessThan(1e-6);
      expect(Math.abs(r.end * 30 - Math.round(r.end * 30))).toBeLessThan(1e-6);
    }
    expect(project!.audio).toMatchObject({ loudness: -16, denoise: "light" });
    expect(project!.scenes.map((s) => [s.id, s.startFrame])).toEqual([["title", 0], ["lower-third", 75]]);
    expect(project!.scenes[1]!.startFrame + project!.scenes[1]!.durationFrames).toBeLessThanOrEqual(Math.round(result.outputDuration * 30));
  });

  it("refuses a recording without video", async () => {
    const wav = join(dir, "audio.wav");
    await runOrThrow(defaultTools.ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=d=1", wav]);
    await expect(planRecording(wav, join(dir, "x.json"))).rejects.toThrow(/no video/);
  });
});
