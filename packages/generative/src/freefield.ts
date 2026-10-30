import { existsSync, mkdirSync, openAsBlob, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import type { GenerativeApp, GenerativeInput, GenerativeProvider, GenerativeResult, GenerativeRunOptions, GenerativeValue } from "./provider";

/**
 * Talks to a Freefield web server (github.com/neuregex/freefield, `npm run
 * serve`, default http://127.0.0.1:3000), which runs open-weight ComfyUI
 * workflows on a local GPU or on Modal. Only its HTTP API is used, so
 * REELFORGE needs no Python, ComfyUI or GPU of its own.
 *
 * Responses are treated as untrusted: shapes are checked, downloads must stay
 * on the same origin, and output file names are made locally.
 */

const FILE_TYPES = new Set(["image", "video", "audio"]);
const DONE = new Set(["succeeded", "failed", "canceled", "expired", "lost"]);

const InputSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    label: z.string().default(""),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    multiple: z.boolean().optional(),
    options: z.array(z.object({ value: z.union([z.string(), z.number()]) }).passthrough()).optional(),
    limits: z.object({ max_mb: z.number().optional() }).passthrough().optional(),
  })
  .passthrough();

const AppSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    section: z.string(),
    summary: z.string().default(""),
    runnable: z.boolean().default(false),
    inputs: z.array(InputSchema),
    outputs: z.array(z.object({ type: z.string(), label: z.string().nullable().default(null) }).passthrough()).default([]),
    models: z
      .array(
        z.object({ name: z.string().optional(), repo: z.string().nullable().optional(), license: z.string().nullable().optional(), gb: z.number().nullable().optional() }).passthrough(),
      )
      .default([]),
    vram: z
      .object({ whole_gb: z.number().nullable().optional(), largest_phase_gb: z.number().nullable().optional(), measured_gb: z.number().nullable().optional() })
      .passthrough()
      .nullable()
      .default(null),
  })
  .passthrough();

const RunSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    seconds: z.number().nullable().optional(),
    values: z.record(z.unknown()).default({}),
    progress: z.unknown().optional(),
    outputs: z.array(z.object({ file: z.string(), type: z.string(), name: z.string().default(""), url: z.string() }).passthrough()).default([]),
    error: z.object({ message: z.string() }).passthrough().nullable().optional(),
  })
  .passthrough();

type RawInput = z.infer<typeof InputSchema>;

export interface FreefieldOptions {
  /** e.g. http://127.0.0.1:3000 */
  baseUrl: string;
  /** For a hosted Freefield demo behind a passcode. */
  passcode?: string;
  /** For tests. */
  fetch?: typeof fetch;
}

export class FreefieldProvider implements GenerativeProvider {
  readonly name = "freefield";
  private readonly base: URL;
  private readonly fetchImpl: typeof fetch;
  private cookie: string | null = null;
  private apps: Map<string, { app: GenerativeApp; raw: RawInput[] }> | null = null;

  constructor(private readonly opts: FreefieldOptions) {
    this.base = new URL(opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`);
    if (!/^https?:$/.test(this.base.protocol)) throw new Error(`Freefield URL must be http(s): ${opts.baseUrl}`);
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async health() {
    try {
      const apps = await this.listApps();
      return { ok: true, detail: `${this.base.origin}: ${apps.length} apps, ${apps.filter((a) => a.runnable).length} runnable` };
    } catch (e) {
      return { ok: false, detail: `${this.base.origin}: ${(e as Error).message}` };
    }
  }

  async listApps(): Promise<GenerativeApp[]> {
    const body = z.object({ apps: z.array(z.unknown()) }).parse(await this.json("api/apps"));
    const map = new Map<string, { app: GenerativeApp; raw: RawInput[] }>();
    for (const item of body.apps) {
      const parsed = AppSchema.safeParse(item);
      if (!parsed.success) continue; // skip entries we can't read rather than failing the whole list
      const a = parsed.data;
      map.set(a.id, {
        raw: a.inputs,
        app: {
          id: a.id,
          name: a.name,
          section: a.section,
          summary: a.summary,
          runnable: a.runnable,
          inputs: a.inputs.map(toInput),
          outputs: a.outputs.map((o) => ({ type: o.type, label: o.label })),
          models: a.models.map((m) => ({ name: m.name ?? "?", repo: m.repo ?? null, license: m.license ?? null, gb: m.gb ?? null })),
          vram: a.vram
            ? { wholeGb: a.vram.whole_gb ?? null, largestPhaseGb: a.vram.largest_phase_gb ?? null, measuredGb: a.vram.measured_gb ?? null }
            : null,
        },
      });
    }
    this.apps = map;
    return [...map.values()].map((v) => v.app);
  }

  async getApp(id: string): Promise<GenerativeApp> {
    if (!this.apps?.has(id)) await this.listApps();
    const entry = this.apps!.get(id);
    if (!entry) throw new Error(`Freefield has no app "${id}"`);
    return entry.app;
  }

  async run(appId: string, values: Record<string, GenerativeValue>, opts: GenerativeRunOptions): Promise<GenerativeResult> {
    const app = await this.getApp(appId);
    if (!app.runnable) throw new Error(`${appId} is not runnable on this Freefield server`);
    const form = await buildForm(app, values);
    if (opts.preset) form.set("preset", opts.preset);

    const started = RunSchema.parse(await this.json(`api/apps/${encodeURIComponent(appId)}/run`, { method: "POST", body: form }));
    const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60 * 1000);
    const pollMs = opts.pollMs ?? 2000;
    let run = started;
    while (!DONE.has(run.status)) {
      if (Date.now() > deadline) {
        await this.request(`api/history/${encodeURIComponent(run.id)}/cancel`, { method: "POST" }).catch(() => undefined);
        throw new Error(`${appId} did not finish within ${Math.round((opts.timeoutMs ?? 0) / 1000)} s; the run was cancelled`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
      run = RunSchema.parse(await this.json(`api/history/${encodeURIComponent(run.id)}`));
      opts.onProgress?.(run.status, typeof run.progress === "number" ? run.progress : progressValue(run.progress));
    }
    if (run.status !== "succeeded") throw new Error(`${appId} ${run.status}: ${run.error?.message ?? "no reason given"}`);
    if (!run.outputs.length) throw new Error(`${appId} finished without outputs`);

    mkdirSync(opts.outDir, { recursive: true });
    const outputs = [];
    for (const [i, o] of run.outputs.entries()) {
      const ext = extname(o.file).toLowerCase();
      const safeExt = /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : ".bin";
      const path = join(opts.outDir, `${appId}-${run.id.replace(/[^\w-]/g, "")}-${i + 1}${safeExt}`);
      const res = await this.request(this.sameOrigin(o.url));
      await writeFile(path, new Uint8Array(await res.arrayBuffer()));
      outputs.push({ path, type: o.type, name: o.name });
    }
    return { provider: this.name, app: appId, runId: run.id, outputs, seconds: run.seconds ?? null, values: run.values };
  }

  /** Resolves a server-given URL, refusing anything that points off the server. */
  private sameOrigin(url: string): string {
    const resolved = new URL(url, this.base);
    if (resolved.origin !== this.base.origin) throw new Error(`refusing to download from another origin: ${resolved.origin}`);
    return resolved.href;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    if (this.opts.passcode && !this.cookie) await this.login();
    const url = path.startsWith("http") ? path : new URL(path, this.base).href;
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("cookie", this.cookie);
    const res = await this.fetchImpl(url, { ...init, headers, redirect: "manual" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let message = text.slice(0, 300);
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? message;
      } catch {
        // not JSON
      }
      throw new Error(`Freefield ${init.method ?? "GET"} /${path.replace(this.base.href, "")} answered ${res.status}: ${message}`);
    }
    return res;
  }

  private async json(path: string, init?: RequestInit): Promise<unknown> {
    return (await this.request(path, init)).json();
  }

  /** Freefield's hosted demo trades `?key=<passcode>` for a session cookie. */
  private async login(): Promise<void> {
    const url = new URL(this.base.href);
    url.searchParams.set("key", this.opts.passcode!);
    const res = await this.fetchImpl(url.href, { redirect: "manual" });
    const setCookie = res.headers.get("set-cookie");
    if (!setCookie) throw new Error("Freefield did not accept the passcode");
    this.cookie = setCookie.split(";")[0]!;
  }
}

function toInput(i: RawInput): GenerativeInput {
  return {
    id: i.id,
    type: i.type,
    label: i.label,
    required: !!i.required,
    ...(i.default !== undefined ? { default: i.default } : {}),
    ...(i.options ? { options: i.options.map((o) => String(o.value)) } : {}),
    ...(i.min !== undefined ? { min: i.min } : {}),
    ...(i.max !== undefined ? { max: i.max } : {}),
    ...(i.limits?.max_mb !== undefined ? { maxMb: i.limits.max_mb } : {}),
  };
}

function progressValue(p: unknown): number | null {
  if (p && typeof p === "object" && "value" in p && "max" in p) {
    const { value, max } = p as { value: unknown; max: unknown };
    if (typeof value === "number" && typeof max === "number" && max > 0) return value / max;
  }
  return null;
}

/** Checks values against the app's inputs and builds the multipart body Freefield expects. */
export async function buildForm(app: GenerativeApp, values: Record<string, GenerativeValue>): Promise<FormData> {
  const byId = new Map(app.inputs.map((i) => [i.id, i]));
  const unknown = Object.keys(values).filter((k) => !byId.has(k));
  if (unknown.length) throw new Error(`${app.id} has no input ${unknown.map((k) => `"${k}"`).join(", ")}; inputs: ${[...byId.keys()].join(", ")}`);

  const form = new FormData();
  for (const input of app.inputs) {
    const value = values[input.id];
    if (value === undefined) {
      if (input.required && input.default === undefined) throw new Error(`${app.id}: "${input.id}" (${input.label}) is required`);
      continue;
    }
    if (FILE_TYPES.has(input.type)) {
      if (typeof value !== "object" || !("file" in value)) throw new Error(`${app.id}: "${input.id}" takes a file (--file ${input.id}=path)`);
      if (!existsSync(value.file) || !statSync(value.file).isFile()) throw new Error(`${app.id}: file not found: ${value.file}`);
      const mb = statSync(value.file).size / 2 ** 20;
      if (input.maxMb !== undefined && mb > input.maxMb) throw new Error(`${app.id}: "${input.id}" is ${mb.toFixed(1)} MB; the limit is ${input.maxMb} MB`);
      form.set(input.id, await openAsBlob(value.file), basename(value.file));
      continue;
    }
    if (typeof value === "object") throw new Error(`${app.id}: "${input.id}" is a ${input.type}, not a file`);
    if (input.type === "select" && input.options && !input.options.includes(String(value))) {
      throw new Error(`${app.id}: "${input.id}" must be one of ${input.options.join(", ")}`);
    }
    if (["number", "slider", "seed"].includes(input.type)) {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${app.id}: "${input.id}" must be a number`);
      if ((input.min !== undefined && n < input.min) || (input.max !== undefined && n > input.max)) {
        throw new Error(`${app.id}: "${input.id}" must be between ${input.min} and ${input.max}`);
      }
    }
    form.set(input.id, String(value));
  }
  return form;
}
