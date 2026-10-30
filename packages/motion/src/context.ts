import type { Theme } from "./theme";

/** Everything a component may depend on. Nothing else (no clock, no randomness). */
export interface FrameContext {
  /** Frame relative to the start of the component's scene. */
  frame: number;
  /** Length of the scene in frames. */
  durationFrames: number;
  fps: number;
  width: number;
  height: number;
  /** 1% of the shorter frame side, in px. Sizes are expressed in these units. */
  u: number;
  portrait: boolean;
  theme: Theme;
}

/** Deterministic pseudo-random number in [0, 1) for a seed, for effects that need variation. */
export function seeded(seed: number): number {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * In portrait frames, burned-in captions occupy the band from here down to
 * about 0.76 of the height. Components keep their content above it.
 */
export const CAPTION_ZONE_TOP = 0.68;

/** Vertical anchor for a named slot, as a fraction of frame height (safe-area aware). */
export function slotY(position: "top" | "center" | "bottom", portrait: boolean): number {
  if (position === "top") return portrait ? 0.16 : 0.14;
  // Portrait "bottom" is centred well above CAPTION_ZONE_TOP so two-line text clears the captions.
  if (position === "bottom") return portrait ? 0.6 : 0.78;
  return 0.5;
}
