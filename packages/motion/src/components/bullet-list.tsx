import { easing, mapRange, spring } from "@reelforge/core";
import { z } from "zod";
import { clamp01, type FrameContext } from "../context";

export const BulletListProps = z.object({
  items: z.array(z.string().min(1)).min(1).max(6),
  title: z.string().optional(),
  marker: z.enum(["check", "dot", "number"]).default("check"),
  /** Frames between items appearing. */
  stagger: z.number().int().min(1).default(10),
  delay: z.number().int().min(0).default(0),
});

/** A heading, then items that slide in one after another with a marker that pops. */
export function BulletList({ ctx, ...raw }: z.input<typeof BulletListProps> & { ctx: FrameContext }) {
  const p = BulletListProps.parse(raw);
  const { u, theme, fps } = ctx;
  const frame = ctx.frame - p.delay;
  const titleIn = mapRange(frame, [0, 12], [0, 1], { easing: easing.outCubic });
  const first = p.title ? 10 : 0;

  return (
    <div
      style={{
        position: "absolute",
        left: "9%",
        right: "9%",
        top: ctx.portrait ? "20%" : "18%",
        fontFamily: theme.font,
        color: theme.text,
      }}
    >
      {p.title && (
        <div style={{ fontSize: 6.4 * u, fontWeight: 800, letterSpacing: "-0.02em", marginBottom: 4 * u, opacity: titleIn, transform: `translateY(${(1 - titleIn) * 2 * u}px)` }}>
          {p.title}
        </div>
      )}
      {p.items.map((item, i) => {
        const local = frame - first - i * p.stagger;
        const slide = mapRange(local, [0, 12], [0, 1], { easing: easing.outCubic });
        const pop = spring(local - 4, fps, { damping: 10, stiffness: 220 });
        const marker = p.marker === "number" ? String(i + 1) : p.marker === "check" ? "✓" : "";
        return (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 3 * u,
              marginBottom: 3 * u,
              opacity: clamp01(local / 6),
              transform: `translateX(${(1 - slide) * -6 * u}px)`,
            }}
          >
            <div
              style={{
                flex: "none",
                width: 7 * u,
                height: 7 * u,
                borderRadius: p.marker === "dot" ? "50%" : 1.6 * u,
                background: p.marker === "dot" ? theme.accent : theme.surface,
                border: p.marker === "dot" ? "none" : `${0.4 * u}px solid ${theme.accent}`,
                color: theme.accent,
                fontSize: 4 * u,
                fontWeight: 800,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transform: `scale(${p.marker === "dot" ? 0.45 * pop : pop})`,
              }}
            >
              {marker}
            </div>
            <div style={{ fontSize: 4.8 * u, fontWeight: 650, lineHeight: 1.2 }}>{item}</div>
          </div>
        );
      })}
    </div>
  );
}
