import { easing, mapRange, spring } from "@reelforge/core";
import { z } from "zod";
import { clamp01, type FrameContext } from "../context";

export const BrowserWindowProps = z.object({
  url: z.string().min(1),
  /** Page headline drawn once the page has loaded. */
  headline: z.string().default(""),
  /** Frames per typed character in the address bar. */
  typeSpeed: z.number().positive().default(1.5),
  /** Frames the loading bar takes once the URL is typed. */
  loadFrames: z.number().int().positive().default(36),
  delay: z.number().int().min(0).default(0),
});

/**
 * Browser mock-up: the window springs in, the URL types itself, a loading
 * bar runs, then the page's skeleton blocks fade in from top to bottom.
 */
export function BrowserWindow({ ctx, ...raw }: z.input<typeof BrowserWindowProps> & { ctx: FrameContext }) {
  const p = BrowserWindowProps.parse(raw);
  const { u, theme, fps } = ctx;
  const frame = ctx.frame - p.delay;

  const enter = spring(frame, fps, { damping: 15, stiffness: 160 });
  const typeStart = 10;
  const typed = Math.max(0, Math.min(p.url.length, Math.floor((frame - typeStart) / p.typeSpeed)));
  const loadStart = typeStart + Math.ceil(p.url.length * p.typeSpeed) + 6;
  const load = mapRange(frame, [loadStart, loadStart + p.loadFrames], [0, 1], { easing: easing.inOutCubic });
  const pageStart = loadStart + p.loadFrames - 6;
  const block = (i: number) => clamp01((frame - pageStart - i * 4) / 8);
  const cursorOn = typed < p.url.length ? true : Math.floor(frame / 12) % 2 === 0 && load === 0;

  const w = ctx.portrait ? 84 : 60;
  const h = ctx.portrait ? 40 : 64;
  const skeleton = { background: theme.muted, opacity: 0.22, borderRadius: u };

  return (
    <div
      style={{
        position: "absolute",
        left: `${(100 - w) / 2}%`,
        width: `${w}%`,
        top: ctx.portrait ? "17%" : "16%",
        height: `${h}%`,
        background: theme.surface,
        borderRadius: 2.4 * u,
        overflow: "hidden",
        boxShadow: `0 ${2 * u}px ${6 * u}px rgba(0,0,0,0.35)`,
        border: `${0.2 * u}px solid ${theme.muted}44`,
        fontFamily: theme.font,
        opacity: clamp01(frame / 6),
        transform: `translateY(${(1 - enter) * 6 * u}px) scale(${0.94 + 0.06 * enter})`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 1.4 * u, padding: `${1.8 * u}px ${2.4 * u}px`, borderBottom: `${0.2 * u}px solid ${theme.muted}33` }}>
        {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => (
          <div key={c} style={{ width: 1.8 * u, height: 1.8 * u, borderRadius: "50%", background: c }} />
        ))}
        <div
          style={{
            flex: 1,
            marginLeft: 1.6 * u,
            background: theme.background,
            borderRadius: 1.2 * u,
            padding: `${1 * u}px ${2 * u}px`,
            color: theme.text,
            fontSize: 3 * u,
            fontWeight: 600,
            whiteSpace: "nowrap",
            overflow: "hidden",
          }}
        >
          {p.url.slice(0, typed)}
          <span style={{ color: theme.accent, opacity: cursorOn && frame >= typeStart ? 1 : 0 }}>|</span>
        </div>
      </div>
      <div style={{ height: 0.6 * u, background: theme.accent, width: `${load * 100}%`, opacity: load > 0 && load < 1 ? 1 : 0 }} />
      <div style={{ padding: 3.4 * u, display: "flex", flexDirection: "column", gap: 2.4 * u }}>
        <div style={{ opacity: block(0), color: theme.text, fontSize: 5 * u, fontWeight: 800, minHeight: 5 * u }}>{p.headline}</div>
        <div style={{ ...skeleton, height: 12 * u, opacity: 0.22 * block(1) }} />
        <div style={{ ...skeleton, height: 2.4 * u, width: "90%", opacity: 0.22 * block(2) }} />
        <div style={{ ...skeleton, height: 2.4 * u, width: "75%", opacity: 0.22 * block(3) }} />
        <div style={{ display: "flex", gap: 2.4 * u, opacity: block(4) }}>
          <div style={{ ...skeleton, flex: 1, height: 9 * u }} />
          <div style={{ ...skeleton, flex: 1, height: 9 * u }} />
        </div>
      </div>
    </div>
  );
}
