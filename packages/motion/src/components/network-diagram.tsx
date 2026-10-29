import { easing, mapRange, spring } from "@reelforge/core";
import { z } from "zod";
import { clamp01, type FrameContext } from "../context";

export const NetworkDiagramProps = z.object({
  nodes: z.array(z.string().min(1)).min(2).max(6),
  animation: z.enum(["sequential-flow"]).default("sequential-flow"),
  /** Defaults to vertical in portrait frames, horizontal otherwise. */
  direction: z.enum(["vertical", "horizontal"]).optional(),
  /** Frames between one node appearing and the next. */
  step: z.number().int().positive().default(18),
  delay: z.number().int().min(0).default(0),
});

/**
 * Nodes pop in one after another, each link draws itself, and once the chain
 * is complete data packets loop along it.
 */
export function NetworkDiagram({ ctx, ...raw }: z.input<typeof NetworkDiagramProps> & { ctx: FrameContext }) {
  const p = NetworkDiagramProps.parse(raw);
  const { u, theme, fps, width, height } = ctx;
  const frame = ctx.frame - p.delay;
  const vertical = (p.direction ?? (ctx.portrait ? "vertical" : "horizontal")) === "vertical";
  const n = p.nodes.length;

  const boxW = vertical ? 44 * u : Math.min(26 * u, (width * 0.84) / n - 4 * u);
  const boxH = vertical ? 11 * u : 14 * u;
  const centers = p.nodes.map((_, i) => {
    const t = n === 1 ? 0.5 : i / (n - 1);
    return vertical
      ? { x: width / 2, y: height * (0.24 + 0.52 * t) }
      : { x: width * (0.1 + 0.8 * t), y: height / 2 };
  });

  const linksDone = (n - 1) * p.step + 12;
  const flowFrame = frame - linksDone;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ position: "absolute", inset: 0 }}>
      {centers.slice(1).map((c, i) => {
        const a = centers[i]!;
        const from = vertical ? { x: a.x, y: a.y + boxH / 2 } : { x: a.x + boxW / 2, y: a.y };
        const to = vertical ? { x: c.x, y: c.y - boxH / 2 } : { x: c.x - boxW / 2, y: c.y };
        const length = Math.hypot(to.x - from.x, to.y - from.y);
        const draw = mapRange(frame, [i * p.step + 6, i * p.step + p.step], [0, 1], { easing: easing.inOutCubic });
        // Packets start once every link is drawn; offset per link so they ripple down the chain.
        const cycle = 30;
        const pt = flowFrame < 0 ? -1 : (((flowFrame - i * 6) % cycle) + cycle) % cycle / cycle;
        return (
          <g key={i}>
            <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={theme.muted} strokeOpacity={0.35} strokeWidth={0.5 * u} />
            <line
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={theme.accent}
              strokeWidth={0.5 * u}
              strokeLinecap="round"
              strokeDasharray={length}
              strokeDashoffset={length * (1 - draw)}
            />
            {pt >= 0 && (
              <circle
                cx={from.x + (to.x - from.x) * pt}
                cy={from.y + (to.y - from.y) * pt}
                r={1.1 * u}
                fill={theme.accent}
                opacity={Math.sin(pt * Math.PI)}
              />
            )}
          </g>
        );
      })}
      {centers.map((c, i) => {
        const local = frame - i * p.step;
        const s = spring(local, fps, { damping: 12, stiffness: 200 });
        const active = flowFrame >= 0 || local >= 0;
        return (
          <g key={i} transform={`translate(${c.x} ${c.y}) scale(${s})`} opacity={clamp01(local / 4)}>
            <rect
              x={-boxW / 2}
              y={-boxH / 2}
              width={boxW}
              height={boxH}
              rx={2 * u}
              fill={theme.surface}
              stroke={active ? theme.accent : theme.muted}
              strokeWidth={0.4 * u}
            />
            <text
              x={0}
              y={0}
              textAnchor="middle"
              dominantBaseline="central"
              fill={theme.text}
              fontFamily={theme.font}
              fontWeight={700}
              fontSize={(vertical ? 4.4 : 3.4) * u}
            >
              {p.nodes[i]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
