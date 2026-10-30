import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FreefieldProvider, checkPolicy, configuredProvider, generate, isPermissive, isSensitive, type GenerativeApp } from "../src";

/**
 * A stand-in for Freefield's web server with the routes and response shapes
 * of server/server.ts and server/history.ts: GET /api/apps (publicApp),
 * POST /api/apps/:id/run (multipart → 202 run view), GET /api/history/:id,
 * GET /api/history/:id/files/:file, POST /api/history/:id/cancel, and the
 * hosted demo's ?key= → cookie passcode.
 */
const APPS = [
  {
    id: "video-remove-bg",
    name: "Video Background Remover",
    section: "video",
    summary: "Cuts the subject out of every frame.",
    status: "ready",
    runnable: true,
    inputs: [
      { id: "clip", type: "video", label: "Your clip", required: true, limits: { max_mb: 1 } },
      { id: "background", type: "select", label: "Background", default: "green", options: [{ value: "green", label: "Green" }, { value: "white", label: "White" }] },
      { id: "seconds", type: "slider", label: "Seconds", min: 1, max: 20, default: 10 },
    ],
    outputs: [{ type: "video", label: "Cutout" }, { type: "video", label: "Matte" }],
    models: [{ name: "birefnet.safetensors", repo: "Comfy-Org/BiRefNet", gb: 0.44, license: "MIT", gated: false }],
    vram: { whole_gb: 0.4, largest_phase_gb: 0.4, verdict: "fits whole", measured_gb: 1.2 },
  },
  {
    id: "video",
    name: "Create Video",
    section: "video",
    status: "ready",
    runnable: true,
    inputs: [{ id: "prompt", type: "textarea", label: "Prompt", required: true }],
    outputs: [{ type: "video", label: null }],
    models: [{ name: "ltx-2.5.safetensors", repo: "Lightricks/LTX", gb: 22, license: "LTX-2.x Community License" }],
    vram: null,
  },
  {
    id: "face-swap",
    name: "Face Swap",
    section: "image",
    status: "ready",
    runnable: true,
    inputs: [{ id: "photo", type: "image", label: "Photo", required: true }],
    outputs: [{ type: "image", label: null }],
    models: [{ name: "klein.safetensors", repo: "bfl/klein", gb: 5.8, license: "Apache-2.0" }],
    vram: null,
  },
  { id: "broken", name: 7 }, // unreadable entry: skipped, not fatal
];

interface FakeRun {
  id: string;
  app: string;
  polls: number;
  values: Record<string, string>;
  upload?: { name: string; bytes: number };
  fail?: string;
  never?: boolean;
  canceled?: boolean;
  outputUrl?: string;
}

let server: Server;
let base: string;
let dir: string;
const runs = new Map<string, FakeRun>();
const state = { passcode: null as string | null, mode: "ok" as "ok" | "fail" | "never" | "foreign" };

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return new Request(`http://local${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: Buffer.concat(chunks) });
}

function view(r: FakeRun) {
  const status = r.canceled ? "canceled" : r.never ? "running" : r.polls < 2 ? ["starting", "running"][r.polls]! : r.fail ? "failed" : "succeeded";
  const done = status === "succeeded";
  return {
    id: r.id,
    app: r.app,
    status,
    seconds: done ? 3.5 : null,
    values: r.values,
    progress: status === "running" ? { value: 5, max: 10 } : null,
    outputs: done
      ? [
          { file: "out-1.mp4", type: "video", name: "cutout", node: "11", url: r.outputUrl ?? `/api/history/${r.id}/files/out-1.mp4` },
          { file: "../../evil name.mp4", type: "video", name: "matte", node: "14", url: `/api/history/${r.id}/files/out-2.mp4` },
        ]
      : [],
    error: r.fail && r.polls >= 2 ? { message: r.fail } : null,
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "reelforge-gen-"));
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://local");
    const send = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(data));
    };
    if (state.passcode) {
      const key = url.searchParams.get("key");
      if (key !== null) {
        if (key !== state.passcode) return send(401, { error: "wrong passcode" });
        res.writeHead(303, { "set-cookie": "ff_pass=ok; HttpOnly; Path=/", location: "/" });
        return res.end();
      }
      if (!req.headers.cookie?.includes("ff_pass=ok")) return send(401, { error: "this demo needs its passcode" });
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (req.method === "GET" && url.pathname === "/api/apps") return send(200, { apps: APPS, drafts: false, hosted: !!state.passcode });
    if (req.method === "POST" && parts[1] === "apps" && parts[3] === "run") {
      const form = await (await body(req)).formData();
      const values: Record<string, string> = {};
      let upload: FakeRun["upload"];
      form.forEach((v, k) => {
        if (typeof v === "string") values[k] = v;
        else upload = { name: v.name, bytes: v.size };
      });
      const id = `20261030-${String(runs.size + 1).padStart(4, "0")}`;
      const run: FakeRun = { id, app: parts[2]!, polls: 0, values, upload };
      if (state.mode === "fail") run.fail = "CUDA out of memory";
      if (state.mode === "never") run.never = true;
      if (state.mode === "foreign") run.outputUrl = "http://attacker.example/x.mp4";
      runs.set(id, run);
      return send(202, view(run));
    }
    if (parts[1] === "history") {
      const run = runs.get(parts[2]!);
      if (!run) return send(404, { error: "unknown run" });
      if (req.method === "POST" && parts[3] === "cancel") {
        run.canceled = true;
        return send(200, { canceled: true });
      }
      if (parts[3] === "files") {
        res.writeHead(200, { "content-type": "video/mp4" });
        return res.end(`video bytes of ${parts[4]}`);
      }
      run.polls++;
      return send(200, view(run));
    }
    send(404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  state.passcode = null;
  state.mode = "ok";
});

const clip = () => {
  const p = join(dir, "clip.mp4");
  writeFileSync(p, Buffer.alloc(1024, 7));
  return p;
};

describe("FreefieldProvider", () => {
  it("lists apps with models, licences and VRAM, skipping unreadable entries", async () => {
    const apps = await new FreefieldProvider({ baseUrl: base }).listApps();
    expect(apps.map((a) => a.id)).toEqual(["video-remove-bg", "video", "face-swap"]);
    const bg = apps[0]!;
    expect(bg.inputs.find((i) => i.id === "clip")).toMatchObject({ type: "video", required: true, maxMb: 1 });
    expect(bg.inputs.find((i) => i.id === "background")?.options).toEqual(["green", "white"]);
    expect(bg.models[0]).toEqual({ name: "birefnet.safetensors", repo: "Comfy-Org/BiRefNet", license: "MIT", gb: 0.44 });
    expect(bg.vram).toEqual({ wholeGb: 0.4, largestPhaseGb: 0.4, measuredGb: 1.2 });
  });

  it("uploads the file, follows the run to completion and downloads every output", async () => {
    const provider = new FreefieldProvider({ baseUrl: base });
    const statuses: string[] = [];
    const out = join(dir, "out-ok");
    const result = await provider.run("video-remove-bg", { clip: { file: clip() }, background: "white", seconds: 4 }, {
      outDir: out,
      pollMs: 5,
      onProgress: (s, p) => statuses.push(`${s}:${p}`),
    });
    const run = runs.get(result.runId)!;
    expect(run.upload).toEqual({ name: "clip.mp4", bytes: 1024 });
    expect(run.values).toEqual({ background: "white", seconds: "4" });
    expect(statuses).toEqual(["running:0.5", "succeeded:null"]);
    expect(result.seconds).toBe(3.5);
    expect(result.outputs.map((o) => o.path)).toEqual([
      join(out, `video-remove-bg-${result.runId}-1.mp4`),
      join(out, `video-remove-bg-${result.runId}-2.mp4`), // the server's "../../evil name.mp4" never becomes a path
    ]);
    expect(readFileSync(result.outputs[1]!.path, "utf8")).toBe("video bytes of out-2.mp4");
  });

  it("validates values against the app's inputs before uploading", async () => {
    const provider = new FreefieldProvider({ baseUrl: base });
    const run = (values: Record<string, never> | Record<string, unknown>) =>
      provider.run("video-remove-bg", values as never, { outDir: dir, pollMs: 5 });
    await expect(run({ clip: { file: clip() }, colour: "red" })).rejects.toThrow(/no input "colour"; inputs: clip, background, seconds/);
    await expect(run({})).rejects.toThrow(/"clip" \(Your clip\) is required/);
    await expect(run({ clip: "clip.mp4" })).rejects.toThrow(/takes a file/);
    await expect(run({ clip: { file: join(dir, "missing.mp4") } })).rejects.toThrow(/file not found/);
    await expect(run({ clip: { file: clip() }, background: "purple" })).rejects.toThrow(/one of green, white/);
    await expect(run({ clip: { file: clip() }, seconds: 99 })).rejects.toThrow(/between 1 and 20/);
    const big = join(dir, "big.mp4");
    writeFileSync(big, Buffer.alloc(2 * 2 ** 20));
    await expect(run({ clip: { file: big } })).rejects.toThrow(/2\.0 MB; the limit is 1 MB/);
    expect([...runs.values()].every((r) => r.app === "video-remove-bg")).toBe(true);
  });

  it("reports a failed run with the server's reason", async () => {
    state.mode = "fail";
    await expect(new FreefieldProvider({ baseUrl: base }).run("video-remove-bg", { clip: { file: clip() } }, { outDir: dir, pollMs: 5 })).rejects.toThrow(
      /video-remove-bg failed: CUDA out of memory/,
    );
  });

  it("cancels a run that outlives its timeout", async () => {
    state.mode = "never";
    const provider = new FreefieldProvider({ baseUrl: base });
    await expect(provider.run("video-remove-bg", { clip: { file: clip() } }, { outDir: dir, pollMs: 5, timeoutMs: 40 })).rejects.toThrow(/cancelled/);
    expect([...runs.values()].at(-1)!.canceled).toBe(true);
  });

  it("refuses to download outputs from another origin", async () => {
    state.mode = "foreign";
    await expect(new FreefieldProvider({ baseUrl: base }).run("video-remove-bg", { clip: { file: clip() } }, { outDir: dir, pollMs: 5 })).rejects.toThrow(
      /another origin: http:\/\/attacker\.example/,
    );
  });

  it("logs in to a hosted demo with its passcode", async () => {
    state.passcode = "s3cret";
    expect((await new FreefieldProvider({ baseUrl: base }).health()).ok).toBe(false);
    expect((await new FreefieldProvider({ baseUrl: base, passcode: "nope" }).health()).detail).toMatch(/passcode/);
    const ok = await new FreefieldProvider({ baseUrl: base, passcode: "s3cret" }).health();
    expect(ok).toEqual({ ok: true, detail: `${base}: 3 apps, 3 runnable` });
  });
});

describe("policy and provenance", () => {
  const appWith = (id: string, license: string | null): GenerativeApp => ({
    id, name: id, section: "video", summary: "", runnable: true, inputs: [], outputs: [], vram: null,
    models: [{ name: "m", repo: null, license, gb: 1 }],
  });

  it("only treats well-known permissive licences as commercial-safe", () => {
    expect(["MIT", "Apache-2.0", "apache-2.0", "BSD-3-Clause"].every(isPermissive)).toBe(true);
    expect(["LTX-2.x Community License", "OpenRAIL", "CC-BY-NC-4.0", "", null].some((l) => isPermissive(l as string | null))).toBe(false);
  });

  it("requires licence acceptance and likeness consent where they apply", () => {
    expect(checkPolicy(appWith("upscale-video", "Apache-2.0")).allowed).toBe(true);
    const community = checkPolicy(appWith("video", "LTX-2.x Community License"));
    expect(community.allowed).toBe(false);
    expect(community.reasons[0]).toMatch(/m \(LTX-2.x Community License\).*--accept-license/);
    expect(checkPolicy(appWith("video", null), { acceptLicense: true }).allowed).toBe(true);
    expect(["face-swap", "dub", "character-3", "recast", "ai-influencer-photo"].every(isSensitive)).toBe(true);
    expect(["video-remove-bg", "upscale-video", "music"].some(isSensitive)).toBe(false);
    expect(checkPolicy(appWith("face-swap", "MIT")).reasons[0]).toMatch(/--allow-sensitive/);
    expect(checkPolicy(appWith("face-swap", "MIT"), { allowSensitive: true }).allowed).toBe(true);
  });

  it("generate() enforces the policy and writes provenance next to each output", async () => {
    const provider = new FreefieldProvider({ baseUrl: base });
    const apps = await provider.listApps();
    const video = apps.find((a) => a.id === "video")!;
    await expect(generate(provider, video, { prompt: "a cat" }, { outDir: dir, pollMs: 5 })).rejects.toThrow(/licence review/);

    const result = await generate(provider, video, { prompt: "a cat" }, { outDir: join(dir, "gen"), pollMs: 5, acceptLicense: true });
    const record = JSON.parse(readFileSync(result.provenance[0]!, "utf8"));
    expect(record.generatedBy).toMatchObject({ provider: "freefield", app: "video", runId: result.runId });
    expect(record.licenseReview.models).toEqual([{ name: "ltx-2.5.safetensors", license: "LTX-2.x Community License" }]);
    expect(record.values).toEqual({ prompt: "a cat" });
  });

  it("is off unless configured", () => {
    expect(configuredProvider({})).toBeNull();
    expect(configuredProvider({ REELFORGE_FREEFIELD_URL: "http://127.0.0.1:3000" })?.name).toBe("freefield");
    expect(() => configuredProvider({ REELFORGE_FREEFIELD_URL: "file:///etc/passwd" })).toThrow(/http/);
  });
});
