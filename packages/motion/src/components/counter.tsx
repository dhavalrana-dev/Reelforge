import { easing, mapRange } from "@reelforge/core";
import { z } from "zod";
import { slotY, type FrameContext } from "../context";

export const CounterProps = z.object({
  to: z.number(),
  from: z.number().default(0),
  prefix: z.string().default(""),
  suffix: z.string().default(""),
  label: z.string().optional(),
  decimals: z.number().int().min(0).max(4).default(0),
  /** Frames the count takes. */
  duration: z.number().int().positive().default(45),
  position: z.enum(["top", "center", "bottom"]).default("center"),
  delay: z.number().int().min(0).default(0),
});

/** Locale-independent formatting so output never varies with system settings. */
export function formatNumber(value: number, decimals: number): string {
  const [int, frac] = Math.abs(value).toFixed(decimals).split(".");
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${value < 0 ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

export function Counter({ ctx, ...raw }: z.input<typeof CounterProps> & { ctx: FrameContext }) {
  const p = CounterProps.parse(raw);
  const { u, theme } = ctx;
  const frame = ctx.frame - p.delay;
  const value = mapRange(frame, [0, p.duration], [p.from, p.to], { easing: easing.outExpo });
  const label = mapRange(frame, [p.duration * 0.4, p.duration * 0.8], [0, 1], { easing: easing.outCubic });

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: `${slotY(p.position, ctx.portrait) * 100}%`,
        transform: "translateY(-50%)",
        textAlign: "center",
        fontFamily: theme.font,
        opacity: frame < 0 ? 0 : 1,
      }}
    >
      <div style={{ color: theme.accent, fontSize: 18 * u, fontWeight: 900, letterSpacing: "-0.04em", fontVariantNumeric: "tabular-nums" }}>
        {p.prefix}
        {formatNumber(value, p.decimals)}
        {p.suffix}
      </div>
      {p.label && (
        <div style={{ color: theme.text, fontSize: 4.2 * u, fontWeight: 700, opacity: label, transform: `translateY(${(1 - label) * 2 * u}px)` }}>
          {p.label}
        </div>
      )}
    </div>
  );
}
