import { easing, mapRange } from "@reelforge/core";
import { z } from "zod";
import { clamp01, type FrameContext } from "../context";
import { formatNumber } from "./counter";

export const BarChartProps = z.object({
  bars: z.array(z.object({ label: z.string().min(1), value: z.number().min(0) })).min(1).max(7),
  title: z.string().optional(),
  unit: z.string().default(""),
  decimals: z.number().int().min(0).max(3).default(0),
  /** Axis maximum; defaults to the largest value. */
  max: z.number().positive().optional(),
  /** Bar index drawn in the accent colour; others use the secondary accent. */
  highlight: z.number().int().min(0).optional(),
  stagger: z.number().int().min(0).default(6),
  delay: z.number().int().min(0).default(0),
});

/** Horizontal bars that grow in sequence, each with its value counting up. */
export function BarChart({ ctx, ...raw }: z.input<typeof BarChartProps> & { ctx: FrameContext }) {
  const p = BarChartProps.parse(raw);
  const { u, theme } = ctx;
  const frame = ctx.frame - p.delay;
  const max = p.max ?? Math.max(...p.bars.map((b) => b.value), 1e-9);
  const titleIn = mapRange(frame, [0, 12], [0, 1], { easing: easing.outCubic });
  const first = p.title ? 8 : 0;

  return (
    <div style={{ position: "absolute", left: "8%", right: "8%", top: ctx.portrait ? "20%" : "16%", fontFamily: theme.font, color: theme.text }}>
      {p.title && <div style={{ fontSize: 6 * u, fontWeight: 800, marginBottom: 4 * u, opacity: titleIn }}>{p.title}</div>}
      {p.bars.map((bar, i) => {
        const local = frame - first - i * p.stagger;
        const grow = mapRange(local, [0, 24], [0, 1], { easing: easing.outCubic });
        const color = p.highlight === undefined || p.highlight === i ? theme.accent : theme.accent2;
        return (
          <div key={i} style={{ marginBottom: 3 * u, opacity: clamp01(local / 5) }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 3.6 * u, fontWeight: 650, marginBottom: 1 * u }}>
              <span>{bar.label}</span>
              <span style={{ color, fontVariantNumeric: "tabular-nums" }}>
                {formatNumber(bar.value * grow, p.decimals)}
                {p.unit}
              </span>
            </div>
            <div style={{ height: 3.2 * u, background: `${theme.muted}33`, borderRadius: 1.6 * u, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${(bar.value / max) * grow * 100}%`, background: color, borderRadius: 1.6 * u }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
