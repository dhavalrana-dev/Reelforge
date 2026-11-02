import { defaultTools, run, type Tools } from "./exec";
import { measureOutputLoudness } from "./audio";
import { probe, type MediaInfo } from "./probe";

export interface OutputExpectations {
  width?: number;
  height?: number;
  fps?: number;
  /** Expected duration in seconds. */
  duration?: number;
  requireAudio?: boolean;
  /** Expected integrated loudness in LUFS (±1 LU). */
  loudness?: number;
  /** True-peak ceiling in dBTP. Without it, anything above 0 dBTP fails as clipping. */
  truePeak?: number;
}

/** AAC encoding can lift true peak slightly above the pre-encode ceiling. */
const TRUE_PEAK_ALLOWANCE = 0.5;

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

  if (info.audio) {
    const loud = await measureOutputLoudness(path, tools);
    const ceiling = expect.truePeak !== undefined ? expect.truePeak + TRUE_PEAK_ALLOWANCE : 0;
    add("audio peak", loud.truePeak <= ceiling, `true peak ${loud.truePeak.toFixed(1)} dBTP (max ${ceiling.toFixed(1)})`);
    if (expect.loudness !== undefined) {
      add("loudness", Math.abs(loud.integrated - expect.loudness) <= 1, `${loud.integrated.toFixed(1)} LUFS (target ${expect.loudness})`);
    }
  }

  const decode = await run(tools.ffmpeg, ["-v", "error", "-i", path, "-f", "null", "-"]);
  const errors = decode.stderr.trim();
  add("full decode", decode.code === 0 && !errors, errors ? errors.split("\n").slice(0, 3).join(" | ") : "clean");

  if (v) {
    const black = await detectBlack(path, tools);
    add(
      "no black stretches",
      black.length === 0,
      black.length ? black.map((b) => `${b.start.toFixed(2)}-${b.end.toFixed(2)}s`).join(", ") : `none of ${BLACK_MIN_SECONDS}s or longer`,
    );
  }

  return { ok: checks.every((c) => c.ok), checks, info };
}

/** Shortest near-black stretch reported: a dip to black in a transition is fine, a second of it is dead air. */
const BLACK_MIN_SECONDS = 1;

/**
 * Near-black stretches: 98% of pixels at or below 5% luma. Dark themes pass
 * as long as anything (a glow, text) is on screen, which is the point: a
 * full-frame near-black second means nothing is being shown.
 */
export async function detectBlack(path: string, tools: Tools = defaultTools): Promise<{ start: number; end: number }[]> {
  const { stderr } = await run(tools.ffmpeg, [
    "-hide_banner", "-nostats", "-i", path, "-an",
    "-vf", `blackdetect=d=${BLACK_MIN_SECONDS}:pix_th=0.05:pic_th=0.98`, "-f", "null", "-",
  ]);
  return [...stderr.matchAll(/black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));
}
