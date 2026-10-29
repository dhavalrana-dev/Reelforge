import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TranscriptSchema, type Transcript } from "@reelforge/core";
import { defaultTools, runOrThrow, type Tools } from "./exec";

const workerDir = fileURLToPath(new URL("../../../workers/transcribe/", import.meta.url));

/** REELFORGE_PYTHON, then the worker's own venv, then whatever `python` is on PATH. */
export function findWorkerPython(): string {
  if (process.env.REELFORGE_PYTHON) return process.env.REELFORGE_PYTHON;
  for (const rel of [".venv/Scripts/python.exe", ".venv/bin/python"]) {
    const p = join(workerDir, rel);
    if (existsSync(p)) return p;
  }
  return "python";
}

export interface TranscribeOptions {
  model?: string;
  language?: string;
  vad?: boolean;
  onProgress?: (line: string) => void;
}

export async function transcribe(input: string, opts: TranscribeOptions = {}, tools: Tools = defaultTools): Promise<Transcript> {
  const dir = mkdtempSync(join(tmpdir(), "reelforge-transcribe-"));
  const out = join(dir, "transcript.json");
  try {
    const args = [join(workerDir, "transcribe.py"), resolve(input), "--out", out, "--model", opts.model ?? "base"];
    if (opts.language) args.push("--language", opts.language);
    if (opts.vad) args.push("--vad");
    await runOrThrow(findWorkerPython(), args, {
      onStderr: opts.onProgress && ((chunk) => chunk.split(/\r?\n/).filter((l) => l.startsWith("[")).forEach(opts.onProgress!)),
      // The worker decodes audio with the same ffmpeg binary as the renderer.
      env: { REELFORGE_FFMPEG: tools.ffmpeg, PYTHONIOENCODING: "utf-8" },
    });
    return TranscriptSchema.parse(JSON.parse(await readFile(out, "utf8")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
