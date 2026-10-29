import { remapTimedItems, type Timeline, type TimeRange } from "./timeline";

export interface Word extends TimeRange {
  text: string;
}

export interface CaptionPage extends TimeRange {
  words: Word[];
  text: string;
}

export interface CaptionGroupingOptions {
  maxWords?: number;
  maxChars?: number;
  /** A pause longer than this starts a new page. */
  maxGap?: number;
}

/** Groups word-level timestamps into short on-screen caption pages. */
export function groupWords(
  words: Word[],
  { maxWords = 4, maxChars = 24, maxGap = 0.6 }: CaptionGroupingOptions = {},
): CaptionPage[] {
  const pages: CaptionPage[] = [];
  let current: Word[] = [];

  const flush = () => {
    const first = current[0];
    const last = current[current.length - 1];
    if (first && last) {
      pages.push({ start: first.start, end: last.end, words: current, text: current.map((w) => w.text).join(" ") });
    }
    current = [];
  };

  for (const word of words) {
    const last = current[current.length - 1];
    const chars = current.reduce((n, w) => n + w.text.length + 1, 0) + word.text.length;
    if (last && (current.length >= maxWords || chars > maxChars || word.start - last.end > maxGap)) flush();
    current.push(word);
  }
  flush();
  return pages;
}

/**
 * Moves source-time words onto the edited timeline, then groups them into
 * pages. Every cut starts a new page, so no caption straddles a jump cut.
 * The result is in output seconds, ready to render.
 */
export function captionPagesForTimeline(words: Word[], tl: Timeline, opts?: CaptionGroupingOptions): CaptionPage[] {
  const remapped = remapTimedItems(words, tl).map((w) => ({ text: w.text, start: w.outputStart, end: w.outputEnd }));
  return tl.segments.flatMap((s, i) => {
    const from = s.outputStartFrame / tl.fps;
    const to = s.outputEndFrame / tl.fps;
    const isLast = i === tl.segments.length - 1;
    return groupWords(remapped.filter((w) => w.start >= from && (isLast ? w.start <= to : w.start < to)), opts);
  });
}
