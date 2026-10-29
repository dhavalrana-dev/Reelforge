import type { TimeRange } from "@reelforge/core";
import { defaultTools, runOrThrow, type Tools } from "./exec";

export interface SilenceOptions {
  /** Level below which audio counts as silence, e.g. "-35dB". */
  noise?: string;
  /** Minimum silence length in seconds. */
  minDuration?: number;
  /** Filters applied before detection, e.g. denoising so hiss isn't mistaken for speech. */
  preFilter?: string[];
}

/** Parses ffmpeg `silencedetect` log output. A silence still open at EOF ends at `duration`. */
export function parseSilenceLog(log: string, duration: number): TimeRange[] {
  const out: TimeRange[] = [];
  let open: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (start) {
      open = Math.max(0, Number(start[1]));
      continue;
    }
    const end = /silence_end:\s*([\d.]+)/.exec(line);
    if (end && open !== null) {
      out.push({ start: open, end: Number(end[1]) });
      open = null;
    }
  }
  if (open !== null && duration > open) out.push({ start: open, end: duration });
  return out;
}

export async function detectSilences(
  path: string,
  duration: number,
  { noise = "-35dB", minDuration = 0.4, preFilter = [] }: SilenceOptions = {},
  tools: Tools = defaultTools,
): Promise<TimeRange[]> {
  const { stderr } = await runOrThrow(tools.ffmpeg, [
    "-hide_banner", "-nostats",
    "-i", path,
    "-vn",
    "-af", [...preFilter, `silencedetect=noise=${noise}:d=${minDuration}`].join(","),
    "-f", "null", "-",
  ]);
  return parseSilenceLog(stderr, duration);
}
