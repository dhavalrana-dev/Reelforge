import { writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import {
  OUTPUT_FORMATS,
  intersectRanges,
  keepRangesFromSilences,
  resolveTimeline,
  validateProject,
  type OutputFormat,
  type TimeRange,
} from "@reelforge/core";
import {
  CAPTION_STYLES,
  DEFAULT_AUDIO_CLEANUP,
  cleanupChain,
  detectSilences,
  probe,
  transcribe,
  usableDuration,
  type AudioCleanupOptions,
} from "@reelforge/media";

export interface PlanOptions {
  format?: OutputFormat;
  fps?: number;
  theme?: string;
  /** Explicit source ranges to keep; silence removal further narrows them. */
  keep?: TimeRange[];
  removeSilence?: boolean;
  silence?: { noise?: string; minDuration?: number; padding?: number };
  captions?: { style?: string; model?: string; language?: string };
  /** Audio clean-up settings; omit for untouched audio. */
  audio?: AudioCleanupOptions;
  /** Intro headline shown over the first seconds. */
  title?: string;
  lowerThird?: { title: string; subtitle?: string };
  onProgress?: (line: string) => void;
}

export interface PlanResult {
  projectFile: string;
  transcriptFile?: string;
  sourceDuration: number;
  outputDuration: number;
  silences: TimeRange[];
  words: number;
}

const TITLE_FRAMES = 75;
const LOWER_THIRD_FRAMES = 90;

/** Path as written into a project file: relative to it, with forward slashes. */
const projectPath = (projectFile: string, target: string) => relative(dirname(resolve(projectFile)), resolve(target)).replace(/\\/g, "/");

/**
 * Stage B of the recorded-video pipeline: analyses a recording and writes a
 * reviewable, editable project (cuts, transcript, audio settings, starter
 * scenes) that `renderProject` turns into the final video. Nothing is
 * rendered and the recording is never modified.
 */
export async function planRecording(input: string, projectFile: string, opts: PlanOptions = {}): Promise<PlanResult> {
  const format = opts.format ?? "9:16";
  const fps = opts.fps ?? 30;
  const { width, height } = OUTPUT_FORMATS[format];
  const log = opts.onProgress ?? (() => undefined);

  const info = await probe(input);
  if (!info.video) throw new Error("input has no video stream");
  for (const w of info.warnings) log(`warning: ${w}`);
  const end = usableDuration(info);

  let keep: TimeRange[] = intersectRanges(opts.keep ?? [{ start: 0, end }], [{ start: 0, end }]);
  let silences: TimeRange[] = [];
  if (opts.removeSilence) {
    if (!info.audio) throw new Error("silence removal needs an audio stream");
    const s = opts.silence ?? {};
    silences = await detectSilences(input, end, {
      noise: s.noise,
      minDuration: s.minDuration,
      preFilter: opts.audio ? cleanupChain({ ...opts.audio, compress: false }) : [],
    });
    keep = intersectRanges(keep, keepRangesFromSilences(silences, end, { padding: s.padding, minSilence: s.minDuration }));
    log(`silences: ${silences.length}, ${silences.reduce((n, r) => n + r.end - r.start, 0).toFixed(2)}s`);
  }
  const timeline = resolveTimeline(keep, fps);
  if (timeline.durationFrames === 0) throw new Error("nothing left after cuts");

  let transcriptFile: string | undefined;
  let words = 0;
  if (opts.captions) {
    if (!info.audio) throw new Error("captions need an audio stream");
    const style = opts.captions.style ?? "clean-pro";
    if (!(style in CAPTION_STYLES)) throw new Error(`unknown caption style "${style}"`);
    log(`transcribing with whisper "${opts.captions.model ?? "base"}"...`);
    const transcript = await transcribe(input, { model: opts.captions.model, language: opts.captions.language, onProgress: (l) => log(`  ${l}`) });
    transcriptFile = join(dirname(resolve(projectFile)), `${basename(projectFile, extname(projectFile))}.transcript.json`);
    await writeFile(transcriptFile, JSON.stringify(transcript, null, 2));
    words = transcript.words.length;
  }

  const scenes: object[] = [];
  const lastFrame = timeline.durationFrames;
  if (opts.title) {
    scenes.push({
      id: "title",
      startFrame: 0,
      durationFrames: Math.min(TITLE_FRAMES, lastFrame),
      components: [{ type: "kinetic-text", text: opts.title, position: "top", size: 7 }],
    });
  }
  if (opts.lowerThird) {
    const start = Math.min(opts.title ? TITLE_FRAMES : 15, Math.max(0, lastFrame - 1));
    scenes.push({
      id: "lower-third",
      startFrame: start,
      durationFrames: Math.min(LOWER_THIRD_FRAMES, lastFrame - start),
      components: [{ type: "lower-third", ...opts.lowerThird }],
    });
  }

  const project = {
    schemaVersion: "1.0",
    project: { name: basename(input, extname(input)), width, height, fps },
    theme: opts.theme ?? "dark-tech",
    sources: [{ id: "main", path: projectPath(projectFile, input) }],
    edit: { sourceId: "main", keep: timeline.segments.map((s) => ({ start: s.sourceStart, end: s.sourceEnd })) },
    ...(opts.audio ? { audio: { ...DEFAULT_AUDIO_CLEANUP, ...opts.audio } } : {}),
    ...(transcriptFile ? { captions: { transcript: projectPath(projectFile, transcriptFile), style: opts.captions!.style ?? "clean-pro" } } : {}),
    scenes,
  };

  const { issues } = validateProject(project);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) throw new Error(`planner produced an invalid project: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
  await writeFile(projectFile, JSON.stringify(project, null, 2));

  return {
    projectFile,
    transcriptFile,
    sourceDuration: end,
    outputDuration: timeline.durationFrames / fps,
    silences,
    words,
  };
}
