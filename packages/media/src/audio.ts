import type { Timeline } from "@reelforge/core";
import { defaultTools, runOrThrow, type Tools } from "./exec";

export interface AudioCleanupOptions {
  /** Integrated loudness target. -14 LUFS suits Instagram, TikTok, YouTube and Shorts. */
  loudness?: number;
  /** True-peak ceiling in dBTP. */
  truePeak?: number;
  /** Stationary noise reduction (hiss, hum, fan noise). */
  denoise?: "off" | "light" | "strong";
  /** High-pass cutoff in Hz to remove rumble and handling noise; 0 disables it. */
  highpass?: number;
  /** Gentle compression so quiet and loud passages sit closer together. */
  compress?: boolean;
  /**
   * Soft downward expander that lowers background noise in pauses. Its
   * threshold comes from the measured noise floor (see analyzeAudio).
   */
  expand?: boolean;
}

export const DEFAULT_AUDIO_CLEANUP: Required<AudioCleanupOptions> = {
  loudness: -14,
  truePeak: -1,
  denoise: "light",
  highpass: 80,
  compress: true,
  expand: true,
};

/** Level statistics of the edited, denoised audio, measured in 100 ms windows. */
export interface NoiseProfile {
  /** 10th-percentile window RMS (dBFS): the background between words. */
  noiseFloor: number;
  /** Median window RMS (dBFS): typical speech level. */
  speechLevel: number;
}

const DENOISE = {
  light: "afftdn=nr=10:nf=-50:tn=1",
  strong: "afftdn=nr=20:nf=-40:tn=1",
} as const;

/** The expander threshold sits this far above the noise floor; any closer and noise peaks hold it open. */
const EXPANDER_MARGIN_DB = 10;
/** The expander never acts on audio louder than this, whatever the noise floor. */
const EXPANDER_MAX_THRESHOLD_DB = -30;
/** Required gap between threshold and typical speech, so words are never attenuated. */
const EXPANDER_SPEECH_HEADROOM_DB = 6;
/** Pauses are lowered by at most 18 dB rather than muted, which sounds natural. */
const EXPANDER_RANGE = 0.125;

/** Expander threshold in dBFS for a noise profile, or null when it would be unsafe or pointless. */
export function expanderThreshold(profile: NoiseProfile): number | null {
  if (profile.noiseFloor < -75) return null; // already clean
  const threshold = Math.min(profile.noiseFloor + EXPANDER_MARGIN_DB, EXPANDER_MAX_THRESHOLD_DB);
  if (profile.speechLevel - threshold < EXPANDER_SPEECH_HEADROOM_DB) return null; // noise too close to speech
  return threshold;
}

const linear = (db: number) => Number((10 ** (db / 20)).toPrecision(6));

/** Stages that run before the noise floor is measured. */
function preChain(o: Required<AudioCleanupOptions>): string[] {
  const chain: string[] = [];
  if (o.highpass > 0) chain.push(`highpass=f=${o.highpass}`);
  if (o.denoise !== "off") chain.push(DENOISE[o.denoise]);
  return chain;
}

/**
 * Clean-up stages that run before loudness normalisation. The expander is
 * included only when a noise profile is given and it is safe to use.
 */
export function cleanupChain(opts: AudioCleanupOptions = {}, profile?: NoiseProfile): string[] {
  const o = { ...DEFAULT_AUDIO_CLEANUP, ...opts };
  const chain = preChain(o);
  const threshold = o.expand && profile ? expanderThreshold(profile) : null;
  if (threshold !== null) {
    chain.push(`agate=threshold=${linear(threshold)}:ratio=4:range=${EXPANDER_RANGE}:attack=5:release=200:knee=2.828`);
  }
  // threshold 0.125 = -18 dBFS; a 3:1 ratio levels speech without pumping.
  if (o.compress) chain.push("acompressor=threshold=0.125:ratio=3:attack=10:release=150:makeup=1");
  return chain;
}

/**
 * The sample-peak limit sits this far under the true-peak ceiling: true peaks
 * between samples, and AAC encoding, can land above the sample peak.
 */
const LIMITER_MARGIN_DB = 1;
/** Gain is never raised by more than this, so near-silent input isn't turned into amplified noise. */
const MAX_GAIN_DB = 30;

/** Gain to apply, then a peak limiter so the gain can be fully used without clipping. */
function gainStage(o: Required<AudioCleanupOptions>, gainDb: number): string[] {
  const limit = linear(o.truePeak - LIMITER_MARGIN_DB);
  return [`volume=${gainDb.toFixed(2)}dB`, `alimiter=limit=${limit}:attack=5:release=50:level=0`];
}

/**
 * The complete chain: clean-up, make-up gain to the loudness target, a peak
 * limiter, and a return to 48 kHz.
 *
 * Not loudnorm: when the gain a quiet recording needs would push peaks over
 * the ceiling, loudnorm switches to dynamic mode and undershoots on short
 * clips (measured: -15.4 LUFS for a -14 target on a 5 s Reel).
 */
export function audioCleanupFilter(opts: AudioCleanupOptions = {}, gainDb = 0, profile?: NoiseProfile): string {
  const o = { ...DEFAULT_AUDIO_CLEANUP, ...opts };
  return [...cleanupChain(o, profile), ...gainStage(o, gainDb), "aresample=48000"].join(",");
}

/** Parses per-window RMS levels printed by ametadata and summarises them. */
export function parseNoiseProfile(log: string): NoiseProfile {
  const levels = [...log.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-inf)/g)]
    .map((m) => (m[1] === "-inf" ? -120 : Number(m[1])))
    .sort((a, b) => a - b);
  if (!levels.length) throw new Error("no audio levels measured");
  const pct = (p: number) => levels[Math.min(levels.length - 1, Math.floor(levels.length * p))]!;
  return { noiseFloor: pct(0.1), speechLevel: pct(0.5) };
}

const sec = (n: number) => n.toFixed(6);

/** Audio-only graph that applies the same cuts as the video render. */
export function audioCutGraph(timeline: Timeline, tail: string): string {
  const n = timeline.segments.length;
  const labels = timeline.segments.map((_, i) => `[as${i}]`).join("");
  const parts = [`[0:a]aresample=48000,asplit=${n}${labels}`];
  timeline.segments.forEach((s, i) => {
    parts.push(`[as${i}]atrim=start=${sec(s.sourceStart)}:end=${sec(s.sourceEnd)},asetpts=PTS-STARTPTS[a${i}]`);
  });
  parts.push(`${timeline.segments.map((_, i) => `[a${i}]`).join("")}concat=n=${n}:v=0:a=1,${tail}[aout]`);
  return parts.join(";");
}

async function runAudioGraph(input: string, timeline: Timeline, tail: string, tools: Tools): Promise<string> {
  const { stderr } = await runOrThrow(tools.ffmpeg, [
    "-hide_banner", "-nostats",
    "-i", input,
    "-filter_complex", audioCutGraph(timeline, tail),
    "-map", "[aout]", "-f", "null", "-",
  ]);
  return stderr;
}

export interface AudioAnalysis {
  profile: NoiseProfile;
  /** Make-up gain (dB) that brings the cleaned, limited audio to the loudness target. */
  gainDb: number;
}

/**
 * Analyses the edited audio (cuts applied) in three fast audio-only passes:
 * the noise profile after denoising; the loudness of the cleaned signal,
 * giving a first gain; and the loudness after that gain and the limiter,
 * which corrects for what the limiter took off the peaks.
 */
export async function analyzeAudio(
  input: string,
  timeline: Timeline,
  opts: AudioCleanupOptions = {},
  tools: Tools = defaultTools,
): Promise<AudioAnalysis> {
  const o = { ...DEFAULT_AUDIO_CLEANUP, ...opts };
  const windows = "asetnsamples=n=4800:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level";
  const profile = parseNoiseProfile(await runAudioGraph(input, timeline, [...preChain(o), windows].join(","), tools));

  const measure = async (chain: string[]) =>
    parseEbur128Summary(await runAudioGraph(input, timeline, [...chain, "ebur128=peak=true"].join(","), tools)).integrated;
  const clamp = (g: number) => Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, g));

  const cleaned = cleanupChain(o, profile);
  const before = await measure(cleaned);
  if (!Number.isFinite(before)) return { profile, gainDb: 0 }; // silent: nothing to normalise
  let gainDb = clamp(o.loudness - before);
  const after = await measure([...cleaned, ...gainStage(o, gainDb)]);
  if (Number.isFinite(after)) gainDb = clamp(gainDb + (o.loudness - after));
  return { profile, gainDb };
}

export interface LoudnessReport {
  integrated: number;
  truePeak: number;
}

/** Parses the summary the ebur128 filter prints at the end of a run. */
export function parseEbur128Summary(log: string): LoudnessReport {
  const summary = log.slice(log.lastIndexOf("Summary:"));
  const i = /I:\s+(-?[\d.]+|-inf) LUFS/.exec(summary);
  const p = /Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(summary);
  if (!i || !p) throw new Error("ebur128 produced no summary");
  const n = (s: string) => (s === "-inf" ? -Infinity : Number(s));
  return { integrated: n(i[1]!), truePeak: n(p[1]!) };
}

/** Integrated loudness (EBU R128) and true peak of a file's first audio stream. */
export async function measureOutputLoudness(path: string, tools: Tools = defaultTools): Promise<LoudnessReport> {
  const { stderr } = await runOrThrow(tools.ffmpeg, [
    "-hide_banner", "-nostats",
    "-i", path,
    "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-",
  ]);
  return parseEbur128Summary(stderr);
}
