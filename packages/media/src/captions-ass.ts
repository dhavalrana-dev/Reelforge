import type { CaptionPage } from "@reelforge/core";

/** Visual treatment of burned-in captions. Sizes are fractions of the frame. */
export interface CaptionStyle {
  font: string;
  /** Font size as a fraction of the shorter frame side. */
  size: number;
  bold: boolean;
  uppercase: boolean;
  color: string;
  highlightColor: string;
  outlineColor: string;
  /** Outline width as a fraction of the font size. */
  outline: number;
  shadow: number;
  /** Scale (%) of the word currently being spoken. */
  highlightScale: number;
  fadeInMs: number;
}

export const CAPTION_STYLES = {
  "clean-pro": {
    font: "Arial",
    size: 0.062,
    bold: true,
    uppercase: false,
    color: "#FFFFFF",
    highlightColor: "#FFD84D",
    outlineColor: "#000000",
    outline: 0.08,
    shadow: 0,
    highlightScale: 108,
    fadeInMs: 80,
  },
  "bold-creator": {
    font: "Arial Black",
    size: 0.08,
    bold: true,
    uppercase: true,
    color: "#FFFFFF",
    highlightColor: "#3CF07A",
    outlineColor: "#000000",
    outline: 0.12,
    shadow: 3,
    highlightScale: 118,
    fadeInMs: 60,
  },
} satisfies Record<string, CaptionStyle>;

export type CaptionStyleName = keyof typeof CAPTION_STYLES;

/** "#RRGGBB" -> ASS "&HAABBGGRR" (alpha 0 = opaque). */
export function assColor(hex: string, alpha = 0): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`invalid color "${hex}"`);
  const a = alpha.toString(16).padStart(2, "0");
  return `&H${a}${m[3]}${m[2]}${m[1]}`.toUpperCase();
}

/** "#RRGGBB" -> "&HBBGGRR&", the form used inside override tags such as \c. */
export function assTagColor(hex: string): string {
  return `&H${assColor(hex).slice(4)}&`;
}

/** Seconds -> ASS "H:MM:SS.cc". */
export function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/** Neutralises characters libass would read as override tags or escapes. */
export function escapeAss(text: string): string {
  return text.replace(/\\/g, "/").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\r?\n/g, " ");
}

export interface AssOptions {
  width: number;
  height: number;
  style: CaptionStyle;
}

/**
 * One dialogue event per spoken word: the whole page stays on screen and the
 * active word is recoloured and enlarged. Events are back to back, so the
 * page never flickers between words.
 */
export function buildAssCaptions(pages: CaptionPage[], { width, height, style }: AssOptions): string {
  const fontSize = Math.round(Math.min(width, height) * style.size);
  const outline = Math.max(1, Math.round(fontSize * style.outline));
  const portrait = height > width;
  const marginV = Math.round(height * (portrait ? 0.24 : 0.08));
  const marginH = Math.round(width * 0.08);
  const caseFn = (t: string) => (style.uppercase ? t.toUpperCase() : t);
  const highlight = `{\\c${assTagColor(style.highlightColor)}\\fscx${style.highlightScale}\\fscy${style.highlightScale}}`;
  const reset = `{\\c${assTagColor(style.color)}\\fscx100\\fscy100}`;

  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Caption,${style.font},${fontSize},${assColor(style.color)},${assColor(style.color)},${assColor(style.outlineColor)},${assColor("#000000", 0x80)},${style.bold ? -1 : 0},0,0,0,100,100,0,0,1,${outline},${style.shadow},2,${marginH},${marginH},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  for (const page of pages) {
    const words = page.words.map((w) => escapeAss(caseFn(w.text)));
    page.words.forEach((word, i) => {
      const start = i === 0 ? page.start : word.start;
      const end = i === page.words.length - 1 ? page.end : page.words[i + 1]!.start;
      if (Math.round(end * 100) <= Math.round(start * 100)) return;
      const text = words.map((w, j) => (j === i ? `${highlight}${w}${reset}` : w)).join(" ");
      const fade = i === 0 && style.fadeInMs > 0 ? `{\\fad(${style.fadeInMs},0)}` : "";
      lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${fade}${text}`);
    });
  }
  return lines.join("\n") + "\n";
}
