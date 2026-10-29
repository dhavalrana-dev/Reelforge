import { defaultTools, run, type Tools } from "./exec";
import { probe, type MediaInfo } from "./probe";

export interface OutputExpectations {
  width?: number;
  height?: number;
  fps?: number;
  /** Expected duration in seconds. */
  duration?: number;
  requireAudio?: boolean;
}

export interface ValidationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ValidationReport {
  ok: boolean;
  checks: ValidationCheck[];
  info: MediaInfo;
}

/** Max audio/video length mismatch before we call it a sync problem. */
const SYNC_TOLERANCE = 0.1;

export async function validateOutput(path: string, expect: OutputExpectations = {}, tools: Tools = defaultTools): Promise<ValidationReport> {
  const info = await probe(path, tools);
  const checks: ValidationCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const v = info.video;

  add("video stream", !!v, v ? `${v.codec} ${v.width}x${v.height}` : "missing");
  if (expect.requireAudio ?? true) add("audio stream", !!info.audio, info.audio ? `${info.audio.codec} ${info.audio.channels}ch` : "missing");

  if (v && expect.width && expect.height) {
    add("resolution", v.width === expect.width && v.height === expect.height, `${v.width}x${v.height} (expected ${expect.width}x${expect.height})`);
  }
  if (v && expect.fps) {
    add("frame rate", Math.abs(v.fps - expect.fps) < 0.01 && !v.variableFrameRate, `${v.fps.toFixed(3)} fps (expected ${expect.fps})`);
  }
  if (expect.duration !== undefined) {
    const actual = v?.duration ?? info.duration;
    const tolerance = expect.fps ? 1.5 / expect.fps : 0.05;
    add("duration", Math.abs(actual - expect.duration) <= tolerance, `${actual.toFixed(3)}s (expected ${expect.duration.toFixed(3)}s)`);
  }
  if (v?.duration != null && info.audio?.duration != null) {
    const drift = Math.abs(v.duration - info.audio.duration);
    add("a/v length match", drift <= SYNC_TOLERANCE, `video ${v.duration.toFixed(3)}s, audio ${info.audio.duration.toFixed(3)}s`);
  }

  const decode = await run(tools.ffmpeg, ["-v", "error", "-i", path, "-f", "null", "-"]);
  const errors = decode.stderr.trim();
  add("full decode", decode.code === 0 && !errors, errors ? errors.split("\n").slice(0, 3).join(" | ") : "clean");

  return { ok: checks.every((c) => c.ok), checks, info };
}
