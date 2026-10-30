/**
 * Optional generative backends. REELFORGE's own pipeline is deterministic and
 * local; a provider adds model-generated media (cut-outs, upscales, clips,
 * music) as plain files that projects then use like any other source.
 */

export type MediaType = "image" | "video" | "audio";

export interface GenerativeModel {
  name: string;
  repo: string | null;
  license: string | null;
  gb: number | null;
}

export interface GenerativeInput {
  id: string;
  type: string;
  label: string;
  required: boolean;
  default?: unknown;
  options?: string[];
  min?: number;
  max?: number;
  maxMb?: number;
}

export interface GenerativeApp {
  id: string;
  name: string;
  section: string;
  summary: string;
  runnable: boolean;
  inputs: GenerativeInput[];
  outputs: { type: string; label: string | null }[];
  models: GenerativeModel[];
  /** Weights size and verdict for a 24 GB card, when the provider knows them. */
  vram: { wholeGb: number | null; largestPhaseGb: number | null; measuredGb: number | null } | null;
}

/** A value for an input: text/number/bool, or a local file to upload. */
export type GenerativeValue = string | number | boolean | { file: string };

export interface GenerativeRunOptions {
  /** Directory the outputs are written to. */
  outDir: string;
  preset?: string;
  /** Give up (and cancel the remote run) after this long. */
  timeoutMs?: number;
  /** How often to ask for status. */
  pollMs?: number;
  onProgress?: (status: string, progress: number | null) => void;
}

export interface GenerativeOutput {
  path: string;
  type: MediaType | string;
  name: string;
}

export interface GenerativeResult {
  provider: string;
  app: string;
  runId: string;
  outputs: GenerativeOutput[];
  /** GPU seconds as reported by the provider, if it reports them. */
  seconds: number | null;
  values: Record<string, unknown>;
}

export interface GenerativeProvider {
  readonly name: string;
  /** Whether the provider answers at all; never throws. */
  health(): Promise<{ ok: boolean; detail: string }>;
  listApps(): Promise<GenerativeApp[]>;
  run(app: string, values: Record<string, GenerativeValue>, opts: GenerativeRunOptions): Promise<GenerativeResult>;
}
