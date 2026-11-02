import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { OUTPUT_FORMATS, validateProject, type OutputFormat } from "@reelforge/core";
import { CAPTION_STYLES, synthesizeNarration, synthMusic, type MusicMood, type NarrationLine } from "@reelforge/media";

/**
 * Workflow C (script or voiceover to video): a script becomes narration
 * lines, timed one after another, with captions from what was actually
 * spoken, a backdrop and an optional music bed. The result is an editable
 * project plus a lines file giving each line's frames, so scenes can be
 * placed against the narration.
 */

export interface NarrateOptions {
  format?: OutputFormat;
  fps?: number;
  theme?: string;
  voice?: string;
  speed?: number;
  verify?: boolean;
  /** Caption style, or null for no captions. */
  captions?: string | null;
  music?: MusicMood | null;
  /** Music level relative to its generated level; voice should sit about 10 dB above it. */
  musicGainDb?: number;
  onProgress?: (line: string) => void;
}

export interface NarratedLine {
  id: string;
  text: string;
  startFrame: number;
  endFrame: number;
}

export interface NarrateResult {
  projectFile: string;
  linesFile: string;
  durationFrames: number;
  lines: NarratedLine[];
  /** Lines speech recognition didn't hear as written. */
  mismatches: { id: string; text: string; heard: string; similarity: number }[];
}

/** Silence before the first line, between lines, and after the last. */
const LEAD = 0.4;
const GAP = 0.35;
const TAIL = 0.9;

/** Reads a script: JSON lines, or plain text with one narration line per non-empty line. */
export async function readScript(path: string): Promise<NarrationLine[]> {
  const raw = await readFile(path, "utf8");
  if (extname(path).toLowerCase() === ".json") {
    const parsed = JSON.parse(raw) as (string | Partial<NarrationLine>)[];
    if (!Array.isArray(parsed)) throw new Error("a JSON script is an array of lines");
    return parsed.map((l, i) => (typeof l === "string" ? { id: `l${i + 1}`, text: l } : { ...l, id: l.id ?? `l${i + 1}`, text: String(l.text ?? "") }));
  }
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((text, i) => ({ id: `l${i + 1}`, text }));
}

const rel = (from: string, to: string) => relative(dirname(resolve(from)), resolve(to)).replace(/\\/g, "/");

export async function narrateScript(lines: NarrationLine[], projectFile: string, opts: NarrateOptions = {}): Promise<NarrateResult> {
  const fps = opts.fps ?? 30;
  const format = opts.format ?? "9:16";
  const { width, height } = OUTPUT_FORMATS[format];
  const base = basename(projectFile, extname(projectFile));
  const dir = dirname(resolve(projectFile));
  const voiceDir = join(dir, `${base}-voice`);
  mkdirSync(voiceDir, { recursive: true });
  if (lines.some((l) => !l.text.trim())) throw new Error("every script line needs text");
  const captionStyle = opts.captions === undefined ? "bold-creator" : opts.captions;
  if (captionStyle && !(captionStyle in CAPTION_STYLES)) throw new Error(`unknown caption style "${captionStyle}"`);

  const result = await synthesizeNarration(lines, voiceDir, { voice: opts.voice, speed: opts.speed, verify: opts.verify, onProgress: opts.onProgress });

  // Lay the lines end to end, each starting on a frame.
  let cursor = LEAD;
  const placed = result.lines.map((l) => {
    const startFrame = Math.round(cursor * fps);
    const start = startFrame / fps;
    cursor = start + l.duration + GAP;
    return { ...l, start, startFrame, endFrame: Math.ceil((start + l.duration) * fps) };
  });
  const durationFrames = Math.ceil((cursor - GAP + TAIL) * fps);
  const seconds = durationFrames / fps;

  // Captions come from what recognition heard, timed by its word timestamps.
  const words = placed.flatMap((l) => l.words.map((w) => ({ text: w.text, start: +(l.start + w.start).toFixed(3), end: +(l.start + w.end).toFixed(3) })));
  const transcriptFile = join(dir, `${base}.transcript.json`);
  await writeFile(
    transcriptFile,
    JSON.stringify(
      {
        schemaVersion: "1.0",
        source: "narration",
        model: "kokoro + whisper",
        language: "en",
        duration: seconds,
        segments: placed.map((l) => ({ start: l.start, end: l.start + l.duration, text: l.text })),
        words,
      },
      null,
      2,
    ),
  );

  const audioTracks: object[] = placed.map((l) => ({ path: rel(projectFile, l.file), role: "voice", startFrame: l.startFrame, gainDb: 0 }));
  if (opts.music) {
    const musicFile = join(dir, `${base}-music.wav`);
    await synthMusic(musicFile, seconds, opts.music);
    audioTracks.push({ path: rel(projectFile, musicFile), role: "music", startFrame: 0, gainDb: opts.musicGainDb ?? -12 });
  }

  const project = {
    schemaVersion: "1.0",
    project: { name: base, width, height, fps },
    theme: opts.theme ?? "dark-tech",
    audioTracks,
    ...(captionStyle && words.length ? { captions: { transcript: rel(projectFile, transcriptFile), style: captionStyle } } : {}),
    scenes: [{ id: "background", startFrame: 0, durationFrames, transition: "cut", components: [{ type: "backdrop" }] }],
  };
  const { issues } = validateProject(project);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) throw new Error(`narration produced an invalid project: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
  await writeFile(projectFile, JSON.stringify(project, null, 2));

  const narrated = placed.map(({ id, text, startFrame, endFrame }) => ({ id, text, startFrame, endFrame }));
  const linesFile = join(dir, `${base}.lines.json`);
  await writeFile(linesFile, JSON.stringify({ fps, durationFrames, lines: narrated }, null, 2));

  return {
    projectFile,
    linesFile,
    durationFrames,
    lines: narrated,
    mismatches: result.lines
      .filter((l) => l.ok === false)
      .map((l) => ({ id: l.id, text: l.text, heard: l.heard ?? "", similarity: l.similarity ?? 0 })),
  };
}
