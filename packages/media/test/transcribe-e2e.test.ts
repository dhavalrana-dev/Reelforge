import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captionPagesForTimeline, keepRangesFromSilences, resolveTimeline, sourceToOutputTime, type Transcript } from "@reelforge/core";
import {
  CAPTION_STYLES,
  buildAssCaptions,
  defaultTools,
  detectSilences,
  findWorkerPython,
  probe,
  renderCuts,
  run,
  runOrThrow,
  transcribe,
  validateOutput,
} from "../src";

const canRun =
  process.platform === "win32" &&
  (await run(findWorkerPython(), ["-c", "import faster_whisper"]).then((r) => r.code === 0, () => false));

/**
 * Real speech from Windows' built-in TTS: two sentences with a 2 s pause,
 * over a plain background so the burned-in caption colours can be measured.
 */
describe.skipIf(!canRun)("transcription + captions (faster-whisper, base.en)", () => {
  let dir: string;
  let source: string;
  let transcript: Transcript;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "reelforge-speech-"));
    const wav = join(dir, "speech.wav");
    const ps = [
      "Add-Type -AssemblyName System.Speech",
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      `$s.SetOutputToWaveFile('${wav.replace(/'/g, "''")}')`,
      "$p = New-Object System.Speech.Synthesis.PromptBuilder",
      "$p.AppendText('Hello and welcome to the channel.')",
      "$p.AppendBreak([TimeSpan]::FromSeconds(2))",
      "$p.AppendText('Today we build a video editor.')",
      "$s.Speak($p); $s.Dispose()",
    ].join("; ");
    await runOrThrow("powershell", ["-NoProfile", "-Command", ps]);

    source = join(dir, "talking-head.mp4");
    await runOrThrow(defaultTools.ffmpeg, [
      "-hide_banner", "-y",
      "-f", "lavfi", "-i", "color=c=0x203040:size=1280x720:rate=30",
      "-i", wav,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
      source,
    ]);
    transcript = await transcribe(source, { model: "base.en", language: "en" });
  }, 600_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("produces ordered word-level timestamps", () => {
    const text = transcript.words.map((w) => w.text.toLowerCase().replace(/[^a-z]/g, "")).join(" ");
    expect(text).toContain("welcome to the channel");
    expect(text).toContain("video editor");
    for (let i = 1; i < transcript.words.length; i++) {
      expect(transcript.words[i]!.start).toBeGreaterThanOrEqual(transcript.words[i - 1]!.start);
    }
  });

  it("keeps captions in sync after silence removal and burns them in", async () => {
    const info = await probe(source);
    const silences = await detectSilences(source, info.duration);
    const timeline = resolveTimeline(keepRangesFromSilences(silences, info.duration), 30);
    const removed = info.duration - timeline.durationFrames / 30;
    expect(removed).toBeGreaterThan(1);

    // "Today" moves earlier by roughly the removed pause. Whisper tends to start
    // words early after a pause; any part inside the cut silence is trimmed off.
    const today = transcript.words.find((w) => /today/i.test(w.text))!;
    const pages = captionPagesForTimeline(transcript.words, timeline);
    const todayPage = pages.find((p) => p.words.some((w) => /today/i.test(w.text)))!;
    const todayOut = todayPage.words.find((w) => /today/i.test(w.text))!;
    const seg = timeline.segments.find((s) => s.sourceEnd > today.start)!;
    expect(todayOut.start).toBeCloseTo(sourceToOutputTime(timeline, Math.max(today.start, seg.sourceStart))!, 3);
    expect(today.start - todayOut.start).toBeGreaterThan(1);
    expect(todayPage).not.toBe(pages[0]);

    const ass = join(dir, "reel.captions.ass");
    writeFileSync(ass, buildAssCaptions(pages, { width: 1080, height: 1920, style: CAPTION_STYLES["clean-pro"] }));
    const output = join(dir, "reel.mp4");
    await renderCuts({ input: source, output, timeline, width: 1080, height: 1920, hasAudio: true, captionsFile: ass });

    const report = await validateOutput(output, { width: 1080, height: 1920, fps: 30, duration: timeline.durationFrames / 30 });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);

    // Mid-way through "Today", the frame should contain white caption text and the yellow highlight.
    const at = ((todayOut.start + todayOut.end) / 2).toFixed(3);
    const frame = await new Promise<Buffer>((resolve, reject) => {
      import("node:child_process").then(({ spawn }) => {
        const p = spawn(defaultTools.ffmpeg, ["-v", "error", "-ss", at, "-i", output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
        const chunks: Buffer[] = [];
        p.stdout.on("data", (c: Buffer) => chunks.push(c));
        p.on("error", reject);
        p.on("close", () => resolve(Buffer.concat(chunks)));
      });
    });
    expect(frame.length).toBe(1080 * 1920 * 3);
    let yellow = 0;
    let white = 0;
    for (let i = 0; i < frame.length; i += 3) {
      const [r, g, b] = [frame[i]!, frame[i + 1]!, frame[i + 2]!];
      if (r > 220 && g > 190 && b < 120) yellow++;
      if (r > 230 && g > 230 && b > 230) white++;
    }
    expect(yellow).toBeGreaterThan(500);
    expect(white).toBeGreaterThan(500);
  }, 300_000);
});
