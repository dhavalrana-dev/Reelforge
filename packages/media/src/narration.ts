import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { defaultTools, runOrThrow, type Tools } from "./exec";
import { findWorkerPython } from "./transcribe";

const ttsScript = fileURLToPath(new URL("../../../workers/tts/tts.py", import.meta.url));
const synthScript = fileURLToPath(new URL("../../../workers/audio/synth.py", import.meta.url));

export interface NarrationLine {
  id: string;
  text: string;
  voice?: string;
  speed?: number;
  /** What speech recognition should hear, when it differs from `text` (names, numbers). */
  asr?: string;
}

const WordSchema = z.object({ text: z.string(), start: z.number(), end: z.number() });

export const NarrationResultSchema = z.object({
  sampleRate: z.number(),
  lines: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      voice: z.string(),
      file: z.string(),
      duration: z.number(),
      heard: z.string().optional(),
      similarity: z.number().optional(),
      ok: z.boolean().optional(),
      words: z.array(WordSchema).default([]),
    }),
  ),
});

export type NarrationResult = z.infer<typeof NarrationResultSchema>;

export interface NarrationOptions {
  /** Kokoro voice, e.g. af_heart, am_michael, bf_emma. */
  voice?: string;
  speed?: number;
  lang?: string;
  /** Transcribe every line back and compare it with the script (default on). */
  verify?: boolean;
  whisperModel?: string;
  onProgress?: (line: string) => void;
}

async function runWorker<S extends z.ZodTypeAny>(
  script: string,
  args: string[],
  schema: S,
  onProgress: ((l: string) => void) | undefined,
  tools: Tools,
): Promise<z.output<S>> {
  const dir = mkdtempSync(join(tmpdir(), "reelforge-worker-"));
  const out = join(dir, "result.json");
  try {
    await runOrThrow(findWorkerPython(), [script, ...args, "--out", out], {
      env: { REELFORGE_FFMPEG: tools.ffmpeg, PYTHONIOENCODING: "utf-8" },
      onStderr: onProgress && ((chunk) => chunk.split(/\r?\n/).filter((l) => l.startsWith("[")).forEach(onProgress)),
    });
    return schema.parse(JSON.parse(await readFile(out, "utf8")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Speaks each line with Kokoro into `outDir/<id>.wav`; with verify, checks each against speech recognition. */
export async function synthesizeNarration(lines: NarrationLine[], outDir: string, opts: NarrationOptions = {}, tools: Tools = defaultTools): Promise<NarrationResult> {
  if (!lines.length) throw new Error("no lines to narrate");
  const ids = new Set<string>();
  for (const l of lines) {
    if (!/^[\w-]+$/.test(l.id)) throw new Error(`line id "${l.id}" may only use letters, digits, - and _`);
    if (ids.has(l.id)) throw new Error(`duplicate line id "${l.id}"`);
    ids.add(l.id);
  }
  const dir = mkdtempSync(join(tmpdir(), "reelforge-lines-"));
  const linesFile = join(dir, "lines.json");
  writeFileSync(linesFile, JSON.stringify(lines));
  try {
    const args = [linesFile, resolve(outDir), "--voice", opts.voice ?? "af_heart", "--speed", String(opts.speed ?? 1), "--lang", opts.lang ?? "en-us"];
    if (opts.verify ?? true) args.push("--verify", "--whisper-model", opts.whisperModel ?? "base.en");
    return await runWorker(ttsScript, args, NarrationResultSchema, opts.onProgress, tools);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function listVoices(tools: Tools = defaultTools): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "reelforge-voices-"));
  try {
    writeFileSync(join(dir, "none.json"), "[]");
    const r = await runWorker(ttsScript, [join(dir, "none.json"), dir, "--list-voices"], z.object({ voices: z.array(z.string()) }), undefined, tools);
    return r.voices;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type MusicMood = "calm" | "upbeat" | "tense";
export type SfxKind = "whoosh" | "pop" | "tick" | "rise";

/** A procedural music bed (no samples, so no third-party licence), as 48 kHz stereo WAV. */
export async function synthMusic(output: string, seconds: number, mood: MusicMood = "calm", seed = 1, tools: Tools = defaultTools): Promise<void> {
  await runOrThrow(findWorkerPython(), [synthScript, "music", resolve(output), "--seconds", String(seconds), "--mood", mood, "--seed", String(seed)], {
    env: { REELFORGE_FFMPEG: tools.ffmpeg },
  });
}

export async function synthSfx(kind: SfxKind, output: string, seed = 1): Promise<void> {
  await runOrThrow(findWorkerPython(), [synthScript, "sfx", kind, resolve(output), "--seed", String(seed)]);
}
