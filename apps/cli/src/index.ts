#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Command } from "commander";
import {
  OUTPUT_FORMATS,
  TranscriptSchema,
  captionPagesForTimeline,
  intersectRanges,
  keepRangesFromSilences,
  normalizeRanges,
  resolveTimeline,
  validateProject,
  type OutputFormat,
  type TimeRange,
  type Transcript,
} from "@reelforge/core";
import {
  CAPTION_STYLES,
  DEFAULT_AUDIO_CLEANUP,
  cleanupChain,
  type AudioCleanupOptions,
  buildAssCaptions,
  detectSilences,
  probe,
  usableDuration,
  renderCuts,
  runDoctor,
  transcribe,
  validateOutput,
  type CaptionStyleName,
} from "@reelforge/media";
import { COMPONENTS, THEMES } from "@reelforge/motion";
import { planRecording, renderProject, renderStill } from "@reelforge/renderer";

const program = new Command();
program.name("reelforge").description("REELFORGE AI: video editing and programmatic video for AI coding agents").version("0.1.0");

const print = (json: boolean, value: unknown, human: () => void) => (json ? console.log(JSON.stringify(value, null, 2)) : human());

/** Parses "0-2.5,4-9" into ranges. */
function parseRanges(spec: string): TimeRange[] {
  return spec.split(",").map((part) => {
    const [start, end] = part.split("-").map(Number);
    if (start === undefined || end === undefined || Number.isNaN(start) || Number.isNaN(end) || end <= start) {
      throw new Error(`invalid range "${part}", expected start-end in seconds`);
    }
    return { start, end };
  });
}

function parseFormat(value: string): OutputFormat {
  if (!(value in OUTPUT_FORMATS)) throw new Error(`format must be one of ${Object.keys(OUTPUT_FORMATS).join(", ")}`);
  return value as OutputFormat;
}

function parseCaptionStyle(value: string): CaptionStyleName {
  if (!(value in CAPTION_STYLES)) throw new Error(`caption style must be one of ${Object.keys(CAPTION_STYLES).join(", ")}`);
  return value as CaptionStyleName;
}

/** Loads a saved transcript, or runs the transcription worker. */
async function getTranscript(input: string, opts: { transcript?: string; model: string; language?: string }): Promise<Transcript> {
  if (opts.transcript) return TranscriptSchema.parse(JSON.parse(await readFile(opts.transcript, "utf8")));
  console.log(`transcribing with whisper "${opts.model}" (the first run downloads the model)...`);
  return transcribe(input, { model: opts.model, language: opts.language, onProgress: (l) => console.log(`  ${l}`) });
}

const sidecar = (output: string, suffix: string) => join(dirname(output), `${basename(output, extname(output))}${suffix}`);

program
  .command("doctor")
  .description("check the local toolchain")
  .option("--json", "machine-readable output")
  .action(async (opts) => {
    const checks = await runDoctor();
    print(opts.json, checks, () => {
      const icon = { ok: "OK  ", warn: "WARN", fail: "FAIL" };
      for (const c of checks) console.log(`[${icon[c.status]}] ${c.name}: ${c.detail}`);
    });
    if (checks.some((c) => c.status === "fail")) process.exitCode = 1;
  });

program
  .command("inspect <file>")
  .description("read media metadata and flag ingestion issues")
  .option("--json", "machine-readable output")
  .action(async (file, opts) => {
    const info = await probe(file);
    print(opts.json, info, () => {
      console.log(`${basename(file)}  ${info.container}  ${info.duration.toFixed(2)}s`);
      if (info.video) {
        const v = info.video;
        console.log(`  video  ${v.codec} ${v.displayWidth}x${v.displayHeight} ${info.orientation} @ ${v.fps.toFixed(3)} fps`);
      }
      if (info.audio) console.log(`  audio  ${info.audio.codec} ${info.audio.channels}ch ${info.audio.sampleRate} Hz`);
      for (const w of info.warnings) console.log(`  warning: ${w}`);
    });
  });

program
  .command("silence <file>")
  .description("detect silent sections")
  .option("--noise <db>", "silence threshold", "-35dB")
  .option("--min <seconds>", "minimum silence length", "0.4")
  .option("--json", "machine-readable output")
  .action(async (file, opts) => {
    const info = await probe(file);
    const silences = await detectSilences(file, info.duration, { noise: opts.noise, minDuration: Number(opts.min) });
    print(opts.json, silences, () => {
      const total = silences.reduce((n, s) => n + s.end - s.start, 0);
      for (const s of silences) console.log(`  ${s.start.toFixed(2)}s - ${s.end.toFixed(2)}s`);
      console.log(`${silences.length} silences, ${total.toFixed(2)}s of ${info.duration.toFixed(2)}s`);
    });
  });

program
  .command("transcribe <file>")
  .description("word-level transcription with faster-whisper")
  .option("-o, --output <file>", "transcript JSON (default: <file>.transcript.json)")
  .option("--model <name>", "tiny, base, small, medium, large-v3", "base")
  .option("--language <code>", "skip language detection, e.g. en")
  .action(async (file, opts) => {
    const transcript = await getTranscript(file, opts);
    const out = opts.output ?? sidecar(file, ".transcript.json");
    if (resolve(out) === resolve(file)) throw new Error("output path must differ from the input");
    await writeFile(out, JSON.stringify(transcript, null, 2));
    console.log(`${transcript.words.length} words, language ${transcript.language} -> ${out}`);
  });

program
  .command("edit <input>")
  .description("cut a recording and export it; the source file is never modified")
  .requiredOption("-o, --output <file>", "output MP4")
  .option("--format <ratio>", "9:16 | 16:9 | 1:1", "9:16")
  .option("--fps <fps>", "output frame rate", "30")
  .option("--keep <ranges>", 'explicit ranges to keep, e.g. "0-12.5,14-30"')
  .option("--remove-silence", "cut silent sections")
  .option("--noise <db>", "silence threshold", "-35dB")
  .option("--min-silence <seconds>", "shortest silence to cut", "0.4")
  .option("--padding <seconds>", "audio kept around each cut", "0.1")
  .option("--captions", "burn in word-highlighted captions")
  .option("--caption-style <name>", Object.keys(CAPTION_STYLES).join(" | "), "clean-pro")
  .option("--transcript <json>", "reuse a transcript instead of transcribing")
  .option("--model <name>", "whisper model for --captions", "base")
  .option("--language <code>", "transcription language, e.g. en")
  .option("--enhance-audio", "denoise, level and loudness-normalise the dialogue")
  .option("--loudness <lufs>", "integrated loudness target for --enhance-audio", "-14")
  .option("--denoise <level>", "off | light | strong", "light")
  .action(async (input, opts) => {
    const format = parseFormat(opts.format);
    const captionStyle = parseCaptionStyle(opts.captionStyle);
    if (!["off", "light", "strong"].includes(opts.denoise)) throw new Error("--denoise must be off, light or strong");
    const audioCleanup: AudioCleanupOptions | undefined = opts.enhanceAudio
      ? { ...DEFAULT_AUDIO_CLEANUP, loudness: Number(opts.loudness), denoise: opts.denoise }
      : undefined;
    const fps = Number(opts.fps);
    const info = await probe(input);
    if (!info.video) throw new Error("input has no video stream");
    for (const w of info.warnings) console.log(`warning: ${w}`);

    const end = usableDuration(info);
    let keep: TimeRange[] = opts.keep ? normalizeRanges(parseRanges(opts.keep), end) : [{ start: 0, end }];
    let silences: TimeRange[] = [];
    if (opts.removeSilence) {
      if (!info.audio) throw new Error("--remove-silence needs an audio stream");
      silences = await detectSilences(input, end, {
        noise: opts.noise,
        minDuration: Number(opts.minSilence),
        preFilter: audioCleanup ? cleanupChain({ ...audioCleanup, compress: false }) : [],
      });
      const speech = keepRangesFromSilences(silences, end, { padding: Number(opts.padding), minSilence: Number(opts.minSilence) });
      keep = intersectRanges(keep, speech);
    }

    const timeline = resolveTimeline(keep, fps);
    if (timeline.durationFrames === 0) throw new Error("nothing left to render after cuts");
    const { width, height } = OUTPUT_FORMATS[format];

    let captionsFile: string | undefined;
    let captionPages: ReturnType<typeof captionPagesForTimeline> = [];
    if (opts.captions || opts.transcript) {
      if (!info.audio && !opts.transcript) throw new Error("--captions needs an audio stream");
      const transcript = await getTranscript(input, opts);
      // The source-time transcript is kept with the output so captions can be re-cut later.
      await writeFile(sidecar(opts.output, ".transcript.json"), JSON.stringify(transcript, null, 2));
      captionPages = captionPagesForTimeline(transcript.words, timeline);
      captionsFile = sidecar(opts.output, ".captions.ass");
      await writeFile(captionsFile, buildAssCaptions(captionPages, { width, height, style: CAPTION_STYLES[captionStyle] }));
      console.log(`captions: ${captionPages.length} pages, ${captionPages.reduce((n, p) => n + p.words.length, 0)} words (${captionStyle})`);
    }

    console.log(`rendering ${timeline.segments.length} segment(s), ${(timeline.durationFrames / fps).toFixed(2)}s of ${info.duration.toFixed(2)}s -> ${width}x${height} @ ${fps}`);
    await renderCuts({ input, output: opts.output, timeline, width, height, hasAudio: !!info.audio, captionsFile, audioCleanup });

    // Edit decision list next to the output, so cuts can be reviewed or reversed.
    const edlPath = sidecar(opts.output, ".edl.json");
    const edl = {
      schemaVersion: "1.0",
      source: resolve(input),
      output: resolve(opts.output),
      format,
      fps,
      sourceDuration: info.duration,
      silences,
      timeline,
      audio: audioCleanup ?? null,
      captions: captionsFile ? { style: captionStyle, pages: captionPages } : null,
    };
    await writeFile(edlPath, JSON.stringify(edl, null, 2));

    const report = await validateOutput(opts.output, {
      width,
      height,
      fps,
      duration: timeline.durationFrames / fps,
      requireAudio: !!info.audio,
      ...(audioCleanup && info.audio ? { loudness: audioCleanup.loudness, truePeak: audioCleanup.truePeak } : {}),
    });
    for (const c of report.checks) console.log(`  [${c.ok ? "OK  " : "FAIL"}] ${c.name}: ${c.detail}`);
    console.log(`wrote ${opts.output} and ${edlPath}`);
    if (!report.ok) process.exitCode = 1;
  });

program
  .command("plan <input>")
  .description("analyse a recording and write an editable project file (no rendering)")
  .requiredOption("-o, --output <project.json>", "project file to write")
  .option("--format <ratio>", "9:16 | 16:9 | 1:1", "9:16")
  .option("--fps <fps>", "output frame rate", "30")
  .option("--theme <name>", Object.keys(THEMES).join(" | "), "dark-tech")
  .option("--keep <ranges>", 'source ranges to keep, e.g. "0-12.5,14-30"')
  .option("--remove-silence", "cut silent sections")
  .option("--noise <db>", "silence threshold", "-35dB")
  .option("--min-silence <seconds>", "shortest silence to cut", "0.4")
  .option("--padding <seconds>", "audio kept around each cut", "0.1")
  .option("--captions", "transcribe and add captions")
  .option("--caption-style <name>", Object.keys(CAPTION_STYLES).join(" | "), "clean-pro")
  .option("--model <name>", "whisper model", "base")
  .option("--language <code>", "transcription language, e.g. en")
  .option("--enhance-audio", "add audio clean-up settings")
  .option("--loudness <lufs>", "loudness target", "-14")
  .option("--denoise <level>", "off | light | strong", "light")
  .option("--title <text>", "intro headline over the opening seconds")
  .option("--lower-third <name|role>", 'name strap, e.g. "Ada Lovelace|Systems engineer"')
  .action(async (input, opts) => {
    if (resolve(opts.output).toLowerCase() === resolve(input).toLowerCase()) throw new Error("output path must differ from the input");
    if (!["off", "light", "strong"].includes(opts.denoise)) throw new Error("--denoise must be off, light or strong");
    const [ltTitle, ltSubtitle] = opts.lowerThird ? String(opts.lowerThird).split("|").map((s: string) => s.trim()) : [];
    const result = await planRecording(input, opts.output, {
      format: parseFormat(opts.format),
      fps: Number(opts.fps),
      theme: opts.theme,
      keep: opts.keep ? parseRanges(opts.keep) : undefined,
      removeSilence: !!opts.removeSilence,
      silence: { noise: opts.noise, minDuration: Number(opts.minSilence), padding: Number(opts.padding) },
      captions: opts.captions ? { style: parseCaptionStyle(opts.captionStyle), model: opts.model, language: opts.language } : undefined,
      audio: opts.enhanceAudio ? { loudness: Number(opts.loudness), denoise: opts.denoise } : undefined,
      title: opts.title,
      lowerThird: ltTitle ? { title: ltTitle, ...(ltSubtitle ? { subtitle: ltSubtitle } : {}) } : undefined,
      onProgress: (l) => console.log(l),
    });
    console.log(`${result.sourceDuration.toFixed(2)}s -> ${result.outputDuration.toFixed(2)}s${result.words ? `, ${result.words} words transcribed` : ""}`);
    console.log(`wrote ${result.projectFile}${result.transcriptFile ? ` and ${result.transcriptFile}` : ""}`);
    console.log(`next: review or edit it, preview with "reelforge still ${opts.output} --frame 30 -o check.png", then "reelforge render ${opts.output} -o out.mp4"`);
  });

program
  .command("validate <file>")
  .description("check an exported video")
  .option("--width <px>")
  .option("--height <px>")
  .option("--fps <fps>")
  .option("--duration <seconds>")
  .option("--no-audio", "don't require an audio stream")
  .option("--json", "machine-readable output")
  .action(async (file, opts) => {
    const n = (v?: string) => (v === undefined ? undefined : Number(v));
    const report = await validateOutput(file, {
      width: n(opts.width),
      height: n(opts.height),
      fps: n(opts.fps),
      duration: n(opts.duration),
      requireAudio: opts.audio,
    });
    print(opts.json, report, () => {
      for (const c of report.checks) console.log(`[${c.ok ? "OK  " : "FAIL"}] ${c.name}: ${c.detail}`);
    });
    if (!report.ok) process.exitCode = 1;
  });

program
  .command("render <projectJson>")
  .description("render a project: footage edit (if any), motion graphics and captions")
  .requiredOption("-o, --output <file>", "output MP4")
  .option("--concurrency <n>", "parallel browser workers", "4")
  .action(async (projectFile, opts) => {
    let last = 0;
    const started = Date.now();
    const result = await renderProject(projectFile, opts.output, {
      concurrency: Number(opts.concurrency),
      onProgress: (done, total) => {
        if (done === total || done - last >= 30) {
          last = done;
          const fps = done / ((Date.now() - started) / 1000);
          console.log(`  frame ${done}/${total}  (${fps.toFixed(1)} fps)`);
        }
      },
    });
    for (const w of result.warnings) console.log(`warning: ${w}`);
    const { painted, reused, empty } = result.stats;
    console.log(`rendered ${result.durationFrames} frames in ${result.seconds.toFixed(1)}s (painted ${painted}, reused ${reused}, empty ${empty})`);
    for (const c of result.report.checks) console.log(`  [${c.ok ? "OK  " : "FAIL"}] ${c.name}: ${c.detail}`);
    console.log(`wrote ${opts.output}`);
    if (!result.report.ok) process.exitCode = 1;
  });

program
  .command("still <projectJson>")
  .description("render one frame to PNG for a quick visual check (captions not included)")
  .requiredOption("--frame <n>", "output frame number")
  .requiredOption("-o, --output <file>", "output PNG")
  .action(async (projectFile, opts) => {
    await renderStill(projectFile, Number(opts.frame), opts.output);
    console.log(`wrote ${opts.output}`);
  });

program
  .command("components")
  .description("list motion components and themes")
  .action(() => {
    console.log(`components: ${Object.keys(COMPONENTS).join(", ")}`);
    console.log(`themes: ${Object.keys(THEMES).join(", ")}`);
    console.log(`caption styles: ${Object.keys(CAPTION_STYLES).join(", ")}`);
  });

program
  .command("project-validate <projectJson>")
  .description("validate a REELFORGE project file")
  .action(async (path) => {
    if (!existsSync(path)) throw new Error(`file not found: ${path}`);
    const { issues } = validateProject(JSON.parse(await readFile(path, "utf8")));
    for (const i of issues) console.log(`${i.level.toUpperCase()} ${i.path}: ${i.message}`);
    if (!issues.length) console.log("project is valid");
    if (issues.some((i) => i.level === "error")) process.exitCode = 1;
  });

program.parseAsync().catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
