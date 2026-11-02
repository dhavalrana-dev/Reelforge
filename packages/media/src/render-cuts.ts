import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Timeline } from "@reelforge/core";
import { analyzeAudio, audioCleanupFilter, type AudioCleanupOptions } from "./audio";
import { defaultTools, pipeThrough, runOrThrow, runWithInput, type RunResult, type Tools } from "./exec";

export interface RenderCutsOptions {
  input: string;
  output: string;
  timeline: Timeline;
  width: number;
  height: number;
  hasAudio: boolean;
  crf?: number;
  /** ASS subtitle file, in output time, burned in on top of everything else. */
  captionsFile?: string;
  /** Transparent PNG frames (one per output frame) composited over the footage. */
  overlayFrames?: AsyncIterable<Buffer>;
  /** Clean up and loudness-normalise the dialogue (two-pass). */
  audioCleanup?: AudioCleanupOptions;
  /** A finished audio mix (see renderMix) used instead of the footage's audio. */
  mixFile?: string;
}

export interface CutFilterOptions {
  timeline: Timeline;
  width: number;
  height: number;
  hasAudio: boolean;
  captionsFile?: string;
  /** Input 1 is a graphics overlay. */
  overlay?: boolean;
  /** Filter chain applied to the joined audio. */
  audioFilter?: string;
}

/** Name the ASS file is staged under; ffmpeg runs in its directory so no path escaping is needed. */
const STAGED_CAPTIONS = "captions.ass";

const sec = (n: number) => n.toFixed(6);

/** Input that reads raw RGBA overlay frames from stdin at the project frame rate, starting at t=0. */
const overlayInput = (fps: number, width: number, height: number) => [
  "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-framerate", String(fps), "-i", "-",
];

/**
 * Chromium encodes fully opaque frames as RGB PNGs and everything else as
 * RGBA. A pixel-format change mid-stream makes ffmpeg rebuild the filter
 * graph: with cuts it silently drops everything after the next cut, and
 * without them the first frame after the switch can land a frame late
 * (seen intermittently in the graphics-only alignment test, so it's timing-
 * dependent). Decoding in a separate trivial ffmpeg first gives every main
 * graph one fixed format. Piping PNGs straight in was ~30% faster for
 * graphics-only renders, but not frame-exact, so every path decodes.
 */
export function pngToRawRgba(frames: AsyncIterable<Buffer>, tools: Tools = defaultTools): AsyncGenerator<Buffer> {
  return pipeThrough(tools.ffmpeg, ["-hide_banner", "-v", "error", "-f", "image2pipe", "-c:v", "png", "-i", "-", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], frames);
}

const OVERLAY = "overlay=0:0:format=auto:eof_action=pass";

const encodeArgs = (fps: number, crf = 20) => [
  "-c:v", "libx264", "-preset", "medium", "-crf", String(crf), "-pix_fmt", "yuv420p",
  "-r", String(fps),
  "-movflags", "+faststart",
];

/**
 * Builds the filter graph for a cut-down edit. Video is converted to the
 * output frame rate *before* trimming, so every cut lands exactly on the
 * frame grid the timeline was resolved against. Layer order, bottom to top:
 * footage, graphics overlay, captions.
 */
export function buildCutFilter({ timeline, width, height, hasAudio, captionsFile, overlay, audioFilter }: CutFilterOptions): string {
  const n = timeline.segments.length;
  if (n === 0) throw new Error("timeline has no segments to render");
  const parts: string[] = [];
  const vLabels = timeline.segments.map((_, i) => `[vs${i}]`).join("");
  const aLabels = timeline.segments.map((_, i) => `[as${i}]`).join("");

  parts.push(
    `[0:v]fps=${timeline.fps},scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},setsar=1,split=${n}${vLabels}`,
  );
  if (hasAudio) parts.push(`[0:a]aresample=48000,asplit=${n}${aLabels}`);

  let concatInputs = "";
  timeline.segments.forEach((s, i) => {
    parts.push(`[vs${i}]trim=start=${sec(s.sourceStart)}:end=${sec(s.sourceEnd)},setpts=PTS-STARTPTS[v${i}]`);
    concatInputs += `[v${i}]`;
    if (hasAudio) {
      parts.push(`[as${i}]atrim=start=${sec(s.sourceStart)}:end=${sec(s.sourceEnd)},asetpts=PTS-STARTPTS[a${i}]`);
      concatInputs += `[a${i}]`;
    }
  });
  const audioOut = audioFilter ? "[acat]" : "[aout]";
  parts.push(`${concatInputs}concat=n=${n}:v=1:a=${hasAudio ? 1 : 0}[vcat]${hasAudio ? audioOut : ""}`);
  if (hasAudio && audioFilter) parts.push(`[acat]${audioFilter}[aout]`);

  let video = "[vcat]";
  if (overlay) {
    parts.push(`${video}[1:v]${OVERLAY}[vov]`);
    video = "[vov]";
  }
  if (captionsFile) {
    parts.push(`${video}ass=${STAGED_CAPTIONS}[vsub]`);
    video = "[vsub]";
  }
  parts.push(`${video}null[vout]`);
  return parts.join(";");
}

/** Runs ffmpeg, staging the captions file and streaming overlay frames if present. */
async function runFfmpeg(args: string[], captionsFile: string | undefined, frames: AsyncIterable<Buffer> | undefined, tools: Tools) {
  const stage = mkdtempSync(join(tmpdir(), "reelforge-render-"));
  try {
    if (captionsFile) copyFileSync(captionsFile, join(stage, STAGED_CAPTIONS));
    let result: RunResult;
    if (frames) {
      result = await runWithInput(tools.ffmpeg, args, pngToRawRgba(frames, tools), { cwd: stage });
      if (result.code !== 0) {
        throw new Error(`ffmpeg exited with code ${result.code}\n${result.stderr.trim().split("\n").slice(-8).join("\n")}`);
      }
    } else {
      await runOrThrow(tools.ffmpeg, args, { cwd: stage });
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Renders the edit to a new file. Refuses to overwrite the source recording. */
export async function renderCuts(opts: RenderCutsOptions, tools: Tools = defaultTools): Promise<void> {
  if (resolve(opts.input).toLowerCase() === resolve(opts.output).toLowerCase()) {
    throw new Error("output path must differ from the source recording");
  }
  const overlay = !!opts.overlayFrames;
  let audioFilter: string | undefined;
  if (opts.audioCleanup && opts.hasAudio && !opts.mixFile) {
    const { profile, gainDb } = await analyzeAudio(resolve(opts.input), opts.timeline, opts.audioCleanup, tools);
    audioFilter = audioCleanupFilter(opts.audioCleanup, gainDb, profile);
  }
  // A finished mix (already cut, cleaned and levelled) replaces the footage's own audio.
  const mixInput = overlay ? 2 : 1;
  const audioArgs = opts.mixFile
    ? ["-map", `${mixInput}:a`, "-c:a", "aac", "-b:a", "192k"]
    : opts.hasAudio
      ? ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"]
      : [];
  const args = [
    "-hide_banner", "-nostats", "-y",
    "-i", resolve(opts.input),
    ...(overlay ? overlayInput(opts.timeline.fps, opts.width, opts.height) : []),
    ...(opts.mixFile ? ["-i", resolve(opts.mixFile)] : []),
    "-filter_complex", buildCutFilter({ ...opts, hasAudio: opts.hasAudio && !opts.mixFile, overlay, audioFilter }),
    "-map", "[vout]",
    ...audioArgs,
    "-frames:v", String(opts.timeline.durationFrames),
    ...encodeArgs(opts.timeline.fps, opts.crf),
    resolve(opts.output),
  ];
  await runFfmpeg(args, opts.captionsFile, opts.overlayFrames, tools);
}

export interface RenderGraphicsOptions {
  output: string;
  width: number;
  height: number;
  fps: number;
  durationFrames: number;
  /** "#RRGGBB" shown wherever the graphics are transparent. */
  background: string;
  overlayFrames: AsyncIterable<Buffer>;
  captionsFile?: string;
  crf?: number;
  /**
   * A pre-rendered (usually lower-resolution) background video, scaled up to
   * the frame size and used instead of the flat colour.
   */
  backgroundVideo?: string;
  /** A finished audio mix; without one the video gets a silent track. */
  audioFile?: string;
}

export interface BackgroundPassOptions {
  output: string;
  width: number;
  height: number;
  fps: number;
  durationFrames: number;
  /** "#RRGGBB" where the background frames are transparent. */
  background: string;
  frames: AsyncIterable<Buffer>;
}

/**
 * Renders the background layer to a lossless intermediate (FFV1 in
 * Matroska), flattened over the background colour, for renderGraphics to
 * scale up beneath the foreground.
 */
export async function renderBackgroundPass(opts: BackgroundPassOptions, tools: Tools = defaultTools): Promise<void> {
  if (!/^#[0-9a-f]{6}$/i.test(opts.background)) throw new Error(`invalid background "${opts.background}"`);
  const seconds = sec(opts.durationFrames / opts.fps);
  const args = [
    "-hide_banner", "-nostats", "-y",
    "-f", "lavfi", "-i", `color=c=0x${opts.background.slice(1)}:s=${opts.width}x${opts.height}:r=${opts.fps}:d=${seconds}`,
    ...overlayInput(opts.fps, opts.width, opts.height),
    "-filter_complex", `[0:v][1:v]${OVERLAY},format=bgr0[vout]`,
    "-map", "[vout]",
    "-frames:v", String(opts.durationFrames),
    "-c:v", "ffv1", "-level", "3", "-g", "1",
    resolve(opts.output),
  ];
  await runFfmpeg(args, undefined, opts.frames, tools);
}

/**
 * Renders a video made only of generated graphics (prompt-to-video). A silent
 * stereo track is included because several platforms reject video-only uploads.
 */
export async function renderGraphics(opts: RenderGraphicsOptions, tools: Tools = defaultTools): Promise<void> {
  if (!/^#[0-9a-f]{6}$/i.test(opts.background)) throw new Error(`invalid background "${opts.background}"`);
  const seconds = sec(opts.durationFrames / opts.fps);
  const video = opts.captionsFile ? `${OVERLAY},ass=${STAGED_CAPTIONS}` : OVERLAY;
  const base = opts.backgroundVideo
    ? ["-i", resolve(opts.backgroundVideo)]
    : ["-f", "lavfi", "-i", `color=c=0x${opts.background.slice(1)}:s=${opts.width}x${opts.height}:r=${opts.fps}:d=${seconds}`];
  const baseChain = opts.backgroundVideo ? `[0:v]scale=${opts.width}:${opts.height}:flags=bicubic,setsar=1[base];[base]` : "[0:v]";
  const args = [
    "-hide_banner", "-nostats", "-y",
    ...base,
    ...overlayInput(opts.fps, opts.width, opts.height),
    ...(opts.audioFile ? ["-i", resolve(opts.audioFile)] : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]),
    "-filter_complex", `${baseChain}[1:v]${video}[vout]`,
    "-map", "[vout]", "-map", "2:a",
    "-c:a", "aac", "-b:a", opts.audioFile ? "192k" : "128k",
    "-frames:v", String(opts.durationFrames), "-t", seconds,
    ...encodeArgs(opts.fps, opts.crf),
    resolve(opts.output),
  ];
  await runFfmpeg(args, opts.captionsFile, opts.overlayFrames, tools);
}
