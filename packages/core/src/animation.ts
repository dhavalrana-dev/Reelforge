/**
 * Animation primitives. Every function is a pure function of the frame
 * number, never wall-clock time, so any frame renders identically in any
 * order, on any machine, in parallel.
 */

export type Easing = (t: number) => number;

/** CSS-style cubic-bezier(x1, y1, x2, y2) timing function. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Easing {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s;
  const slopeX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;

  const solveS = (x: number) => {
    let s = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(s) - x;
      if (Math.abs(err) < 1e-7) return s;
      const d = slopeX(s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    // Newton failed to converge; fall back to bisection.
    let lo = 0;
    let hi = 1;
    s = x;
    while (hi - lo > 1e-7) {
      if (sampleX(s) < x) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return s;
  };

  return (t) => (t <= 0 ? 0 : t >= 1 ? 1 : sampleY(solveS(t)));
}

export const easing = {
  linear: (t: number) => t,
  inQuad: (t: number) => t * t,
  outQuad: (t: number) => t * (2 - t),
  inOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  inCubic: (t: number) => t ** 3,
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  outExpo: (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  outBack: (t: number) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
  standard: cubicBezier(0.4, 0, 0.2, 1),
} satisfies Record<string, Easing>;

export type EasingName = keyof typeof easing;

export type Extrapolate = "clamp" | "extend";

export interface MapRangeOptions {
  easing?: Easing;
  extrapolateLeft?: Extrapolate;
  extrapolateRight?: Extrapolate;
}

/**
 * Maps `value` from one piecewise-linear range onto another, e.g.
 * mapRange(frame, [0, 30], [0, 1]) for a one-second fade at 30 fps.
 */
export function mapRange(
  value: number,
  input: readonly number[],
  output: readonly number[],
  { easing: ease = easing.linear, extrapolateLeft = "clamp", extrapolateRight = "clamp" }: MapRangeOptions = {},
): number {
  if (input.length < 2 || input.length !== output.length) {
    throw new Error("mapRange needs input and output ranges of equal length (>= 2)");
  }
  for (let i = 1; i < input.length; i++) {
    if (input[i]! <= input[i - 1]!) throw new Error("mapRange input range must be strictly increasing");
  }

  const last = input.length - 1;
  if (value < input[0]! && extrapolateLeft === "clamp") return output[0]!;
  if (value > input[last]! && extrapolateRight === "clamp") return output[last]!;

  let i = 0;
  while (i < last - 1 && value > input[i + 1]!) i++;
  const [x0, x1, y0, y1] = [input[i]!, input[i + 1]!, output[i]!, output[i + 1]!];
  const t = (value - x0) / (x1 - x0);
  const eased = t >= 0 && t <= 1 ? ease(t) : t;
  return y0 + (y1 - y0) * eased;
}

export interface SpringConfig {
  mass?: number;
  stiffness?: number;
  damping?: number;
}

/**
 * Closed-form damped spring from 0 to 1 (no simulation steps, so frame N
 * never depends on frames before it).
 */
export function spring(frame: number, fps: number, { mass = 1, stiffness = 100, damping = 10 }: SpringConfig = {}): number {
  if (frame <= 0) return 0;
  const t = frame / fps;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));

  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  if (zeta === 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const root = Math.sqrt(zeta * zeta - 1);
  const r1 = -w0 * (zeta - root);
  const r2 = -w0 * (zeta + root);
  return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
}

export interface Keyframe {
  frame: number;
  value: number;
  /** Easing used for the transition *into* this keyframe. */
  easing?: Easing;
}

/** Evaluates a keyframe track at `frame`, holding the first/last value outside it. */
export function keyframes(frame: number, track: Keyframe[]): number {
  const sorted = [...track].sort((a, b) => a.frame - b.frame);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) throw new Error("keyframes needs at least one keyframe");
  if (frame <= first.frame) return first.value;
  if (frame >= last.frame) return last.value;
  const next = sorted.findIndex((k) => k.frame > frame);
  const a = sorted[next - 1]!;
  const b = sorted[next]!;
  return mapRange(frame, [a.frame, b.frame], [a.value, b.value], { easing: b.easing });
}
