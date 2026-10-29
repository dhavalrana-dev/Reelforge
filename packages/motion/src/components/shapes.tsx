import { z } from "zod";
import type { FrameContext } from "../context";

export const RectProps = z.object({
  /** Position and size as percentages of the frame. */
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  color: z.string().optional(),
  radius: z.number().min(0).default(0),
});

/** A plain rectangle. Mostly a building block, also used to test frame alignment. */
export function Rect({ ctx, ...raw }: z.input<typeof RectProps> & { ctx: FrameContext }) {
  const p = RectProps.parse(raw);
  return (
    <div
      style={{
        position: "absolute",
        left: `${p.x}%`,
        top: `${p.y}%`,
        width: `${p.w}%`,
        height: `${p.h}%`,
        background: p.color ?? ctx.theme.accent,
        borderRadius: p.radius * ctx.u,
      }}
    />
  );
}

export const BackdropProps = z.object({
  /** Seconds for one full drift cycle of the glow. */
  period: z.number().positive().default(8),
});

/** Slowly drifting two-colour glow over the theme background, for videos without footage. */
export function Backdrop({ ctx, ...raw }: z.input<typeof BackdropProps> & { ctx: FrameContext }) {
  const p = BackdropProps.parse(raw);
  const { theme, frame, fps } = ctx;
  const a = ((frame / fps) / p.period) * Math.PI * 2;
  const x1 = 30 + 12 * Math.cos(a);
  const y1 = 25 + 8 * Math.sin(a);
  const x2 = 70 - 12 * Math.cos(a * 0.7);
  const y2 = 75 - 8 * Math.sin(a * 0.7);
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background:
          `radial-gradient(circle at ${x1}% ${y1}%, ${theme.accent2}55 0%, transparent 45%),` +
          `radial-gradient(circle at ${x2}% ${y2}%, ${theme.accent}33 0%, transparent 40%),` +
          theme.background,
      }}
    />
  );
}
