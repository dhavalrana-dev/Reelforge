import { easing, mapRange, spring } from "@reelforge/core";
import { z } from "zod";
import type { FrameContext } from "../context";

export const LowerThirdProps = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  delay: z.number().int().min(0).default(0),
});

/** Name strap: accent bar springs in, panel wipes open behind it, text follows. */
export function LowerThird({ ctx, ...raw }: z.input<typeof LowerThirdProps> & { ctx: FrameContext }) {
  const p = LowerThirdProps.parse(raw);
  const { u, theme, fps } = ctx;
  const frame = ctx.frame - p.delay;
  const bar = spring(frame, fps, { damping: 16, stiffness: 180 });
  const wipe = mapRange(frame, [4, 18], [100, 0], { easing: easing.outCubic });
  const text = mapRange(frame, [10, 22], [0, 1], { easing: easing.outCubic });

  return (
    <div
      style={{
        position: "absolute",
        left: "6%",
        bottom: ctx.portrait ? "38%" : "12%",
        display: "flex",
        alignItems: "stretch",
        fontFamily: theme.font,
      }}
    >
      <div style={{ width: 1.2 * u, background: theme.accent, transform: `scaleY(${bar})`, transformOrigin: "bottom" }} />
      <div
        style={{
          background: theme.surface,
          padding: `${1.6 * u}px ${3 * u}px`,
          clipPath: `inset(0 ${wipe}% 0 0)`,
          boxShadow: `0 ${u}px ${3 * u}px rgba(0,0,0,0.25)`,
        }}
      >
        <div style={{ opacity: text, transform: `translateX(${(1 - text) * -2 * u}px)` }}>
          <div style={{ color: theme.text, fontSize: 4.6 * u, fontWeight: 800, lineHeight: 1.1 }}>{p.title}</div>
          {p.subtitle && <div style={{ color: theme.muted, fontSize: 2.8 * u, fontWeight: 600, marginTop: 0.6 * u }}>{p.subtitle}</div>}
        </div>
      </div>
    </div>
  );
}
