import { writeFile, readFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import {
  TranscriptSchema,
  captionPagesForTimeline,
  groupWords,
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
  renderCuts,
  renderGraphics,
  runWithInput,
  validateOutput,
  type CaptionStyleName,
  type ValidationReport,
} from "@reelforge/media";
import { getTheme } from "@reelforge/motion";
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
  const timeline = resolveTimeline(project.edit.keep, project.project.fps);
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

  const renderer = await FrameRenderer.create(project, { concurrency: opts.concurrency });
  try {
    async function* frames() {
      let done = 0;
      for await (const f of renderer.frames(0, p.durationFrames)) {
        yield f;
        opts.onProgress?.(++done, p.durationFrames);
      }
    }
    if (p.footage) {
      await renderCuts({ input: p.footage.path, output, timeline: p.footage.timeline, width, height, hasAudio: p.footage.hasAudio, captionsFile, overlayFrames: frames() });
    } else {
      const background = project.background ?? getTheme(project.theme).background;
      await renderGraphics({ output, width, height, fps, durationFrames: p.durationFrames, background, overlayFrames: frames(), captionsFile });
    }
  } finally {
    await renderer.close();
  }

  const report = await validateOutput(output, {
    width,
    height,
    fps,
    duration: p.durationFrames / fps,
    requireAudio: p.footage ? p.footage.hasAudio : true,
  });
  return { durationFrames: p.durationFrames, stats: renderer.stats, seconds: (Date.now() - started) / 1000, warnings: loaded.warnings, report };
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
