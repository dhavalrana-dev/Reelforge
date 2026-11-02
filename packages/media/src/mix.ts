import type { Timeline } from "@reelforge/core";
import { analyzeAudio, audioCleanupFilter, audioCutGraph, normalizeAudioFile, type AudioCleanupOptions, type LoudnessReport } from "./audio";
import { defaultTools, runOrThrow, type Tools } from "./exec";

export type TrackRole = "voice" | "music" | "sfx";

export interface MixTrack {
  path: string;
  role: TrackRole;
  /** Seconds into the output. */
  start: number;
  gainDb: number;
}

/**
 * Music ducks under voice by up to ~16 dB while anyone speaks, with a slow
 * release so it swells back between sentences rather than pumping.
 */
const DUCK = "sidechaincompress=threshold=0.02:ratio=6:attack=30:release=400:makeup=1";

/**
 * Filter graph mixing `tracks` (ffmpeg inputs 0..n-1) into [mix], exactly
 * `duration` seconds long: grouped by role, music ducked under voice, all
 * summed without normalisation (levels are set afterwards).
 */
export function buildMixGraph(tracks: Pick<MixTrack, "role" | "start" | "gainDb">[], duration: number): string {
  if (!tracks.length) throw new Error("nothing to mix");
  const parts: string[] = [];
  const groups: Record<TrackRole, string[]> = { voice: [], music: [], sfx: [] };
  tracks.forEach((t, i) => {
    const ms = Math.max(0, Math.round(t.start * 1000));
    parts.push(
      `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${t.gainDb.toFixed(2)}dB,adelay=${ms}:all=1,apad[t${i}]`,
    );
    groups[t.role].push(`[t${i}]`);
  });
  const group = (role: TrackRole) => {
    const labels = groups[role];
    if (!labels.length) return null;
    parts.push(labels.length === 1 ? `${labels[0]}anull[${role}]` : `${labels.join("")}amix=inputs=${labels.length}:normalize=0:duration=longest[${role}]`);
    return `[${role}]`;
  };
  const voice = group("voice");
  let music = group("music");
  const sfx = group("sfx");
  let voiceOut = voice;
  if (voice && music) {
    parts.push(`${voice}asplit=2[vkey][vmix]`, `${music}[vkey]${DUCK}[ducked]`);
    voiceOut = "[vmix]";
    music = "[ducked]";
  }
  const final = [voiceOut, music, sfx].filter((x): x is string => !!x);
  const sum = final.length === 1 ? `${final[0]}anull` : `${final.join("")}amix=inputs=${final.length}:normalize=0:duration=longest`;
  parts.push(`${sum},atrim=0:${duration.toFixed(6)},asetpts=PTS-STARTPTS[mix]`);
  return parts.join(";");
}

export interface DialogueSource {
  input: string;
  timeline: Timeline;
  /** Clean-up for the dialogue before mixing; loudness is set on the whole mix. */
  cleanup?: AudioCleanupOptions;
}

export interface RenderMixOptions {
  tracks: MixTrack[];
  /** Footage dialogue, cut like the picture; ducks music like a voice track. */
  dialogue?: DialogueSource;
  duration: number;
  /** Working files go here. */
  workDir: string;
  output: string;
  loudness?: number;
  truePeak?: number;
}

/** Mixes dialogue, voice, music and effects into one normalised WAV. */
export async function renderMix(opts: RenderMixOptions, tools: Tools = defaultTools): Promise<LoudnessReport> {
  const inputs: MixTrack[] = [...opts.tracks];
  if (opts.dialogue) {
    const { input, timeline, cleanup } = opts.dialogue;
    let chain = "anull";
    if (cleanup) {
      const { profile } = await analyzeAudio(input, timeline, cleanup, tools);
      chain = audioCleanupFilter(cleanup, 0, profile);
    }
    const dialogue = `${opts.workDir}/dialogue.wav`;
    await runOrThrow(tools.ffmpeg, [
      "-hide_banner", "-nostats", "-y", "-i", input,
      "-filter_complex", audioCutGraph(timeline, chain), "-map", "[aout]", "-c:a", "pcm_f32le", dialogue,
    ]);
    inputs.unshift({ path: dialogue, role: "voice", start: 0, gainDb: 0 });
  }
  const premix = `${opts.workDir}/premix.wav`;
  await runOrThrow(tools.ffmpeg, [
    "-hide_banner", "-nostats", "-y",
    ...inputs.flatMap((t) => ["-i", t.path]),
    "-filter_complex", buildMixGraph(inputs, opts.duration),
    "-map", "[mix]", "-c:a", "pcm_f32le", premix,
  ]);
  return normalizeAudioFile(premix, opts.output, { loudness: opts.loudness, truePeak: opts.truePeak }, tools);
}
