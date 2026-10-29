import { easing, mapRange, spring } from "@reelforge/core";
import type { CSSProperties } from "react";
import { z } from "zod";
import { clamp01, slotY, type FrameContext } from "../context";

export const KineticTextProps = z.object({
  text: z.string().min(1),
  animation: z.enum(["word-reveal", "fade-up", "typewriter"]).default("word-reveal"),
  position: z.enum(["top", "center", "bottom"]).default("center"),
  /** Font size in frame units (1 unit = 1% of the shorter side). */
  size: z.number().positive().default(8),
  weight: z.number().int().min(100).max(900).default(800),
  /** Words drawn in the accent colour. Matched case-insensitively, ignoring punctuation. */
  highlight: z.array(z.string()).default([]),
  /** Frames between consecutive words in word-reveal. */
  stagger: z.number().int().min(0).default(3),
  delay: z.number().int().min(0).default(0),
});

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export function KineticText({ ctx, ...raw }: z.input<typeof KineticTextProps> & { ctx: FrameContext }) {
  const p = KineticTextProps.parse(raw);
  const { u, theme, fps } = ctx;
  const frame = ctx.frame - p.delay;
  const highlight = new Set(p.highlight.map(norm));
  const words = p.text.split(/\s+/);

  const box: CSSProperties = {
    position: "absolute",
    left: "8%",
    right: "8%",
    top: `${slotY(p.position, ctx.portrait) * 100}%`,
    transform: "translateY(-50%)",
    textAlign: "center",
    fontFamily: theme.font,
    fontWeight: p.weight,
    fontSize: p.size * u,
    lineHeight: 1.12,
    letterSpacing: "-0.02em",
    color: theme.text,
  };
  const color = (w: string) => (highlight.has(norm(w)) ? theme.accent : theme.text);

  if (p.animation === "typewriter") {
    const chars = Math.max(0, Math.floor(frame / 2));
    const shown = p.text.slice(0, chars);
    const cursorOn = Math.floor(frame / 15) % 2 === 0 || chars < p.text.length;
    return (
      <div style={box}>
        {shown}
        <span style={{ color: theme.accent, opacity: cursorOn ? 1 : 0 }}>▍</span>
      </div>
    );
  }

  if (p.animation === "fade-up") {
    const t = mapRange(frame, [0, 14], [0, 1], { easing: easing.outCubic });
    return (
      <div style={{ ...box, opacity: t, transform: `translateY(calc(-50% + ${(1 - t) * 3 * u}px))` }}>
        {words.map((w, i) => (
          <span key={i} style={{ color: color(w) }}>
            {w}{" "}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div style={box}>
      {words.map((w, i) => {
        const local = frame - i * p.stagger;
        const rise = spring(local, fps, { damping: 14, stiffness: 170 });
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              marginRight: "0.25em",
              color: color(w),
              opacity: clamp01(local / 5),
              transform: `translateY(${(1 - rise) * 4 * u}px) scale(${0.92 + 0.08 * rise})`,
            }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
}
