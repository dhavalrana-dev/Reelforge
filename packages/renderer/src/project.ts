import { mkdtempSync, rmSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import {
  TranscriptSchema,
  captionPagesForTimeline,
  groupWords,
  normalizeRanges,
  outputFrameToSourceTime,
  resolveTimeline,
  validateProject,
  type Project,
  type Timeline,
} from "@reelforge/core";
import {
  CAPTION_STYLES,
  buildAssCaptions,
  defaultTools,
  probe,
  usableDuration,
  renderCuts,
  renderBackgroundPass,
  renderGraphics,
  runWithInput,
  validateOutput,
  type CaptionStyleName,
  type ValidationReport,
} from "@reelforge/media";
import { getTheme, splitBackground } from "@reelforge/motion";
import { FrameRenderer, type RenderStats } from "./frame-renderer";

export interface LoadedProject {
  project: Project;
  warnings: string[];
  /** Resolves a path written in the project file (relative to the file). */
  path: (p: string) => string;
}

export async function loadProject(projectFile: string): Promise<LoadedProject> {
  const { project, issues } = validateProject(JSON.parse(await readFile(projectFile, "utf8")));
  const errors = issues.filter((i) => i.level === "error");
  if (!project || errors.length) throw new Error(`invalid project:\n  ${errors.map((i) => `${i.path}: ${i.message}`).join("\n  ")}`);
  const dir = dirname(resolve(projectFile));
  return {
    project,
    warnings: issues.filter((i) => i.level === "warning").map((i) => `${i.path}: ${i.message}`),
    path: (p) => (isAbsolute(p) ? p : join(dir, p)),
  };
}

interface Plan {
  durationFrames: number;
  /** Present when the project edits footage. */
  footage?: { path: string; timeline: Timeline; hasAudio: boolean };
}

async function plan({ project, path, warnings }: LoadedProject): Promise<Plan> {
  const sceneEnd = Math.max(0, ...project.scenes.map((s) => s.startFrame + s.durationFrames));
  if (!project.edit) {
    if (sceneEnd === 0) throw new Error("project has no edit and no scenes: nothing to render");
    return { durationFrames: sceneEnd };
  }
  const source = project.sources.find((s) => s.id === project.edit!.sourceId)!;
  const info = await probe(path(source.path));
  if (!info.video) throw new Error(`source "${source.id}" has no video stream`);
  const timeline = resolveTimeline(normalizeRanges(project.edit.keep, usableDuration(info)), project.project.fps);
  if (sceneEnd > timeline.durationFrames) {
    warnings.push(`scenes run to frame ${sceneEnd} but the edited footage ends at ${timeline.durationFrames}; graphics past the end are dropped`);
  }
  return { durationFrames: timeline.durationFrames, footage: { path: path(source.path), timeline, hasAudio: !!info.audio } };
}

async function writeCaptions(loaded: LoadedProject, p: Plan, output: string): Promise<string | undefined> {
  const { project, path } = loaded;
  if (!project.captions) return undefined;
  const style = project.captions.style;
  if (!(style in CAPTION_STYLES)) throw new Error(`unknown caption style "${style}"; available: ${Object.keys(CAPTION_STYLES).join(", ")}`);
  const transcript = TranscriptSchema.parse(JSON.parse(await readFile(path(project.captions.transcript), "utf8")));
  // Without an edit, transcript time is output time (script or voiceover driven videos).
  const pages = p.footage ? captionPagesForTimeline(transcript.words, p.footage.timeline) : groupWords(transcript.words);
  const { width, height } = project.project;
  const file = join(dirname(output), `${basename(output, extname(output))}.captions.ass`);
  await writeFile(file, buildAssCaptions(pages, { width, height, style: CAPTION_STYLES[style as CaptionStyleName] }));
  return file;
}

export interface RenderProjectOptions {
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface RenderProjectResult {
  durationFrames: number;
  stats: RenderStats;
  seconds: number;
  warnings: string[];
  report: ValidationReport;
}

/** Renders a project file to an MP4: footage (if any), graphics overlay, captions; then validates it. */
export async function renderProject(projectFile: string, output: string, opts: RenderProjectOptions = {}): Promise<RenderProjectResult> {
  const started = Date.now();
  const loaded = await loadProject(projectFile);
  const { project } = loaded;
  const { width, height, fps } = project.project;
  const p = await plan(loaded);
  if (p.footage && resolve(p.footage.path).toLowerCase() === resolve(output).toLowerCase()) {
    throw new Error("output path must differ from the source recording");
  }
  const captionsFile = await writeCaptions(loaded, p, output);

  // Without footage, background-layer components render in their own
  // low-resolution pass first; the main pass then draws only the foreground.
  const layers = p.footage ? null : splitBackground(project);
  const stats: RenderStats = { painted: 0, reused: 0, empty: 0 };
  const addStats = (s: RenderStats) => {
    stats.painted += s.painted;
    stats.reused += s.reused;
    stats.empty += s.empty;
  };
  const stage = layers?.background ? mkdtempSync(join(tmpdir(), "reelforge-bg-")) : null;
  let backgroundVideo: string | undefined;
  if (layers?.background && stage) {
    const bg = layers.background;
    const bgRenderer = await FrameRenderer.create(bg, { concurrency: opts.concurrency });
    try {
      backgroundVideo = join(stage, "background.mkv");
      await renderBackgroundPass({
        output: backgroundVideo,
        width: bg.project.width,
        height: bg.project.height,
        fps,
        durationFrames: p.durationFrames,
        background: project.background ?? getTheme(project.theme).background,
        frames: bgRenderer.frames(0, p.durationFrames),
      });
    } finally {
      await bgRenderer.close();
      addStats(bgRenderer.stats);
    }
  }

  const renderer = await FrameRenderer.create(layers ? layers.foreground : project, { concurrency: opts.concurrency });
  try {
    async function* frames() {
      let done = 0;
      for await (const f of renderer.frames(0, p.durationFrames)) {
        yield f;
        opts.onProgress?.(++done, p.durationFrames);
      }
    }
    if (p.footage) {
      await renderCuts({
        input: p.footage.path,
        output,
        timeline: p.footage.timeline,
        width,
        height,
        hasAudio: p.footage.hasAudio,
        captionsFile,
        overlayFrames: frames(),
        audioCleanup: project.audio,
      });
    } else {
      const background = project.background ?? getTheme(project.theme).background;
      await renderGraphics({ output, width, height, fps, durationFrames: p.durationFrames, background, overlayFrames: frames(), captionsFile, backgroundVideo });
    }
  } finally {
    await renderer.close();
    addStats(renderer.stats);
    if (stage) rmSync(stage, { recursive: true, force: true });
  }

  const report = await validateOutput(output, {
    width,
    height,
    fps,
    duration: p.durationFrames / fps,
    requireAudio: p.footage ? p.footage.hasAudio : true,
    ...(p.footage?.hasAudio && project.audio ? { loudness: project.audio.loudness, truePeak: project.audio.truePeak } : {}),
  });
  return { durationFrames: p.durationFrames, stats, seconds: (Date.now() - started) / 1000, warnings: loaded.warnings, report };
}

/**
 * One output frame as a PNG, graphics composited over the footage (or the
 * background colour) exactly as the full render would show it. Captions are
 * not included.
 */
export async function renderStill(projectFile: string, frame: number, output: string): Promise<void> {
  const loaded = await loadProject(projectFile);
  const { project } = loaded;
  const { width, height } = project.project;
  const p = await plan(loaded);
  if (frame < 0 || frame >= p.durationFrames) throw new Error(`frame must be between 0 and ${p.durationFrames - 1}`);

  const renderer = await FrameRenderer.create(project, { concurrency: 1 });
  let graphics: Buffer;
  try {
    graphics = await renderer.renderFrame(frame);
  } finally {
    await renderer.close();
  }

  const fit = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
  const base = p.footage
    ? ["-ss", outputFrameToSourceTime(p.footage.timeline, frame)!.toFixed(6), "-i", p.footage.path]
    : ["-f", "lavfi", "-i", `color=c=0x${(project.background ?? getTheme(project.theme).background).slice(1)}:s=${width}x${height}`];
  const args = [
    "-hide_banner", "-v", "error", "-y",
    ...base,
    "-f", "image2pipe", "-c:v", "png", "-i", "-",
    "-filter_complex", `[0:v]${fit}[bg];[bg][1:v]overlay=0:0:format=auto`,
    "-frames:v", "1",
    resolve(output),
  ];
  const result = await runWithInput(defaultTools.ffmpeg, args, (async function* () { yield graphics; })());
  if (result.code !== 0) throw new Error(`ffmpeg failed to compose the still:\n${result.stderr.trim()}`);
}
