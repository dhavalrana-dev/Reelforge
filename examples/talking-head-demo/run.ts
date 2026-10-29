/**
 * Repeatable end-to-end demo (blueprint §17): a raw talking-head recording in,
 * a finished 9:16 Reel out, with silence cuts, word-highlighted captions,
 * cleaned-up audio, a title, a name strap and an animated diagram timed to
 * the moment the speaker mentions it.
 *
 *   npm run demo                      # synthesises a recording (Windows TTS)
 *   npm run demo -- path/to/video.mp4 # uses your recording
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveTimeline, sourceToOutputFrame, TranscriptSchema, type Project } from "@reelforge/core";
import { defaultTools, runOrThrow } from "@reelforge/media";
import { planRecording, renderProject, renderStill } from "@reelforge/renderer";

const outDir = resolve("out/demo");
mkdirSync(outDir, { recursive: true });

const SCRIPT = [
  "Welcome back.",
  "Today I will show you what happens when a website loads.",
  "First, your browser asks a server for the page.",
  "The server reads from a database, and sends everything back.",
  "That whole trip takes less than a second. Follow for more.",
];

/** A 1280x720 "recording": drifting gradient as the camera, TTS speech with pauses, low room noise. */
async function synthesiseRecording(): Promise<string> {
  if (process.platform !== "win32") throw new Error("pass a recording: npm run demo -- path/to/video.mp4");
  const wav = join(outDir, "speech.wav");
  const prompt = SCRIPT.map((s) => `$p.AppendText('${s}'); $p.AppendBreak([TimeSpan]::FromMilliseconds(1600))`).join("; ");
  await runOrThrow("powershell", [
    "-NoProfile", "-Command",
    `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
      `$s.SetOutputToWaveFile('${wav.replace(/'/g, "''")}'); $p = New-Object System.Speech.Synthesis.PromptBuilder; ` +
      `${prompt}; $s.Speak($p); $s.Dispose()`,
  ]);
  const video = join(outDir, "raw-recording.mp4");
  await runOrThrow(defaultTools.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", "gradients=s=1280x720:r=30:c0=0x1d2b53:c1=0x7e2553:c2=0x008751:speed=0.008",
    "-i", wav,
    "-f", "lavfi", "-i", "anoisesrc=a=0.006:c=pink:r=22050:seed=11",
    "-filter_complex", "[1:a]aresample=48000[v];[2:a]aresample=48000[n];[v][n]amix=inputs=2:normalize=0:duration=first[a]",
    "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    video,
  ]);
  return video;
}

const step = (s: string) => console.log(`\n== ${s}`);
const started = Date.now();

const input = process.argv[2] ? resolve(process.argv[2]) : await synthesiseRecording();
step(`input: ${input}`);

step("plan: silence cuts, transcript, audio settings, starter scenes");
const projectFile = join(outDir, "project.json");
const plan = await planRecording(input, projectFile, {
  removeSilence: true,
  captions: { style: "bold-creator", model: "base.en", language: "en" },
  audio: { loudness: -14, denoise: "light" },
  title: "How a website loads",
  lowerThird: { title: "REELFORGE", subtitle: "Demo walkthrough" },
  onProgress: (l) => console.log(l),
});
console.log(`${plan.sourceDuration.toFixed(1)}s recording -> ${plan.outputDuration.toFixed(1)}s Reel, ${plan.words} words`);

step("add a diagram timed to the word \"browser\"");
const project = JSON.parse(readFileSync(projectFile, "utf8")) as Project;
const transcript = TranscriptSchema.parse(JSON.parse(readFileSync(plan.transcriptFile!, "utf8")));
const timeline = resolveTimeline(project.edit!.keep, project.project.fps);
const cue = transcript.words.find((w) => /browser/i.test(w.text));
const startFrame = cue ? sourceToOutputFrame(timeline, cue.start) : null;
if (startFrame !== null && startFrame !== undefined) {
  const durationFrames = Math.min(170, timeline.durationFrames - startFrame);
  // The name strap and the diagram share the middle of the frame: end the strap
  // before the diagram starts, or drop it if less than a second would remain.
  const strap = project.scenes.find((s) => s.id === "lower-third");
  if (strap && strap.startFrame + strap.durationFrames > startFrame) {
    strap.durationFrames = startFrame - strap.startFrame;
    if (strap.durationFrames < project.project.fps) project.scenes = project.scenes.filter((s) => s !== strap);
  }
  project.scenes.push({
    id: "diagram",
    startFrame,
    durationFrames,
    transition: "fade",
    components: [{ type: "network-diagram", nodes: ["Browser", "Server", "Database"], step: 14 }],
  });
  writeFileSync(projectFile, JSON.stringify(project, null, 2));
  console.log(`diagram at output frame ${startFrame} ("${cue!.text}" spoken at ${cue!.start.toFixed(2)}s in the recording)`);
} else {
  console.log("the word \"browser\" wasn't found; skipping the diagram scene");
}

step("preview stills");
for (const [frame, name] of [[20, "still-title"], [startFrame ? startFrame + 40 : 120, "still-diagram"]] as const) {
  await renderStill(projectFile, frame, join(outDir, `${name}.png`));
  console.log(`frame ${frame} -> out/demo/${name}.png`);
}

step("render");
let last = 0;
const output = join(outDir, "reel.mp4");
const result = await renderProject(projectFile, output, {
  onProgress: (done, total) => {
    if (done - last >= 60 || done === total) {
      last = done;
      console.log(`  frame ${done}/${total}`);
    }
  },
});
for (const w of result.warnings) console.log(`warning: ${w}`);
for (const c of result.report.checks) console.log(`  [${c.ok ? "OK  " : "FAIL"}] ${c.name}: ${c.detail}`);
console.log(`\nwrote ${output} in ${((Date.now() - started) / 1000).toFixed(0)}s total`);
if (!result.report.ok) process.exitCode = 1;
