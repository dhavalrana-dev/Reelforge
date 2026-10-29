/**
 * Timeline engine: converts "keep" ranges on a source recording into an
 * output timeline snapped to the project frame grid, and maps timestamps in
 * both directions so captions, effects and cues stay in sync after cuts.
 *
 * Source times are seconds. Output positions are integer frames.
 */

export interface TimeRange {
  start: number;
  end: number;
}

export interface ResolvedSegment {
  /** Source range snapped to the output frame grid (seconds). */
  sourceStart: number;
  sourceEnd: number;
  outputStartFrame: number;
  /** Exclusive. */
  outputEndFrame: number;
}

export interface Timeline {
  fps: number;
  segments: ResolvedSegment[];
  durationFrames: number;
}

/** Clamps to [0, duration], drops empty ranges, sorts and merges overlapping or touching ranges. */
export function normalizeRanges(ranges: TimeRange[], duration = Infinity): TimeRange[] {
  const clamped = ranges
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(duration, r.end) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  const merged: TimeRange[] = [];
  for (const r of clamped) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

/** Returns the parts of [0, duration] not covered by `ranges`. */
export function invertRanges(ranges: TimeRange[], duration: number): TimeRange[] {
  const out: TimeRange[] = [];
  let cursor = 0;
  for (const r of normalizeRanges(ranges, duration)) {
    if (r.start > cursor) out.push({ start: cursor, end: r.start });
    cursor = r.end;
  }
  if (cursor < duration) out.push({ start: cursor, end: duration });
  return out;
}

/** Parts covered by both `a` and `b`. */
export function intersectRanges(a: TimeRange[], b: TimeRange[]): TimeRange[] {
  const out: TimeRange[] = [];
  for (const x of a) {
    for (const y of b) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end > start) out.push({ start, end });
    }
  }
  return normalizeRanges(out);
}

export interface SilenceCutOptions {
  /** Speech kept on each side of a removed silence, so words aren't clipped. */
  padding?: number;
  /** Silences shorter than this are left in place. */
  minSilence?: number;
}

/** Turns detected silences into the ranges to keep. */
export function keepRangesFromSilences(
  silences: TimeRange[],
  duration: number,
  { padding = 0.1, minSilence = 0.4 }: SilenceCutOptions = {},
): TimeRange[] {
  const removals = silences
    .filter((s) => s.end - s.start >= minSilence)
    .map((s) => ({
      start: s.start <= 0 ? 0 : s.start + padding,
      end: s.end >= duration ? duration : s.end - padding,
    }))
    .filter((r) => r.end > r.start);
  return invertRanges(removals, duration);
}

/** Snaps keep ranges to the frame grid and lays them end to end on the output timeline. */
export function resolveTimeline(keep: TimeRange[], fps: number): Timeline {
  const segments: ResolvedSegment[] = [];
  let cursor = 0;
  for (const r of normalizeRanges(keep)) {
    const startFrame = Math.round(r.start * fps);
    const endFrame = Math.round(r.end * fps);
    if (endFrame <= startFrame) continue;
    const length = endFrame - startFrame;
    segments.push({
      sourceStart: startFrame / fps,
      sourceEnd: endFrame / fps,
      outputStartFrame: cursor,
      outputEndFrame: cursor + length,
    });
    cursor += length;
  }
  return { fps, segments, durationFrames: cursor };
}

/** Output time in seconds for a source time, or null if that moment was cut. */
export function sourceToOutputTime(tl: Timeline, t: number): number | null {
  for (const s of tl.segments) {
    if (t >= s.sourceStart && t <= s.sourceEnd) {
      return s.outputStartFrame / tl.fps + (t - s.sourceStart);
    }
  }
  return null;
}

export function sourceToOutputFrame(tl: Timeline, t: number): number | null {
  const out = sourceToOutputTime(tl, t);
  return out === null ? null : Math.round(out * tl.fps);
}

/** Source time shown at a given output frame, or null outside the timeline. */
export function outputFrameToSourceTime(tl: Timeline, frame: number): number | null {
  for (const s of tl.segments) {
    if (frame >= s.outputStartFrame && frame < s.outputEndFrame) {
      return s.sourceStart + (frame - s.outputStartFrame) / tl.fps;
    }
  }
  return null;
}

export type Remapped<T> = T & { outputStart: number; outputEnd: number };

/**
 * Moves timed items (words, caption lines, cues) onto the output timeline.
 * Items entirely inside removed sections are dropped; items spanning a cut
 * are trimmed to the parts that survive.
 */
export function remapTimedItems<T extends TimeRange>(items: T[], tl: Timeline): Remapped<T>[] {
  const out: Remapped<T>[] = [];
  for (const item of items) {
    let outputStart: number | null = null;
    let outputEnd: number | null = null;
    for (const s of tl.segments) {
      const start = Math.max(item.start, s.sourceStart);
      const end = Math.min(item.end, s.sourceEnd);
      if (end <= start) continue;
      const offset = s.outputStartFrame / tl.fps - s.sourceStart;
      outputStart ??= start + offset;
      outputEnd = end + offset;
    }
    if (outputStart !== null && outputEnd !== null) out.push({ ...item, outputStart, outputEnd });
  }
  return out;
}
