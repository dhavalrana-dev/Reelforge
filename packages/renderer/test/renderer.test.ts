import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateProject, type Project } from "@reelforge/core";
import { defaultTools, runOrThrow } from "@reelforge/media";
import { formatNumber, renderFrameHtml, validateComposition } from "@reelforge/motion";
import { FrameRenderer, launchBrowser, renderProject } from "../src";

const project = (input: object): Project => {
  const { project, issues } = validateProject({ schemaVersion: "1.0", project: { name: "t", width: 540, height: 960, fps: 30 }, ...input });
  if (!project) throw new Error(JSON.stringify(issues));
  return project;
};

const explainer = project({
  theme: "dark-tech",
  scenes: [
    { id: "a", startFrame: 0, durationFrames: 60, components: [{ type: "kinetic-text", text: "What happens when you open a website?" }] },
    { id: "b", startFrame: 60, durationFrames: 60, components: [{ type: "network-diagram", nodes: ["Browser", "Server", "Database"] }] },
  ],
});

describe("composition (no browser)", () => {
  it("frame markup is a pure function of the frame", () => {
    const order = [45, 10, 90, 10, 45];
    const first = new Map(order.map((f) => [f, renderFrameHtml(explainer, f)]));
    for (const f of order.reverse()) expect(renderFrameHtml(explainer, f)).toBe(first.get(f));
    expect(renderFrameHtml(explainer, 10)).not.toBe(renderFrameHtml(explainer, 11));
    expect(renderFrameHtml(explainer, 500)).toBe("");
  });

  it("validates component types and props before rendering", () => {
    const bad = project({
      scenes: [{ id: "a", startFrame: 0, durationFrames: 10, components: [{ type: "sparkles" }, { type: "network-diagram", nodes: ["only one"] }] }],
    });
    const errors = validateComposition(bad);
    expect(errors[0]).toMatch(/unknown component "sparkles"/);
    expect(errors[1]).toMatch(/components\.1\.nodes/);
  });

  it("formats numbers without depending on the system locale", () => {
    expect(formatNumber(1250000, 0)).toBe("1,250,000");
    expect(formatNumber(-1234.5, 2)).toBe("-1,234.50");
  });
});

const browserAvailable = await launchBrowser().then(
  async (b) => (await b.close(), true),
  () => false,
);

/**
 * Average RGB of a small centre patch of output frame `n`. Decodes every
 * frame and indexes, since select + -frames:v doesn't reliably return frame n.
 */
async function centrePixel(file: string, n: number): Promise<[number, number, number]> {
  const buf = await new Promise<Buffer>((resolve, reject) => {
    const p = spawn(defaultTools.ffmpeg, ["-v", "error", "-i", file, "-vf", "crop=8:8,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    const chunks: Buffer[] = [];
    p.stdout.on("data", (c: Buffer) => chunks.push(c));
    p.on("error", reject);
    p.on("close", () => resolve(Buffer.concat(chunks)));
  });
  if (buf.length < (n + 1) * 3) throw new Error(`video has only ${buf.length / 3} frames`);
  return [buf[n * 3]!, buf[n * 3 + 1]!, buf[n * 3 + 2]!];
}

const isRed = ([r, g, b]: number[]) => r! > 200 && g! < 70 && b! < 70;

describe.skipIf(!browserAvailable)("frame renderer (Chromium)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "reelforge-render-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("paints identical pixels regardless of order or worker count", async () => {
    const one = await FrameRenderer.create(explainer, { concurrency: 1 });
    const many = await FrameRenderer.create(explainer, { concurrency: 3 });
    try {
      const a = [];
      for await (const f of one.frames(70, 76)) a.push(f);
      const b = await Promise.all([75, 74, 73, 72, 71, 70].map((f) => many.renderFrame(f)));
      b.reverse();
      a.forEach((frame, i) => expect(frame.equals(b[i]!), `frame ${70 + i}`).toBe(true));
      expect(a[0]!.equals(a[5]!)).toBe(false);
    } finally {
      await Promise.all([one.close(), many.close()]);
    }
  }, 120_000);

  it("graphics land on exactly the scene's start frame in a graphics-only render", async () => {
    const file = join(dir, "graphics.json");
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "align", width: 540, height: 960, fps: 30 },
        background: "#000000",
        scenes: [{ id: "red", startFrame: 30, durationFrames: 30, transition: "cut", components: [{ type: "rect", x: 0, y: 0, w: 100, h: 100, color: "#FF0000" }] }],
      }),
    );
    const output = join(dir, "graphics.mp4");
    const result = await renderProject(file, output, { concurrency: 2 });
    expect(result.report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.stats.empty).toBe(30);
    expect(isRed(await centrePixel(output, 29))).toBe(false);
    expect(isRed(await centrePixel(output, 30))).toBe(true);
    expect(isRed(await centrePixel(output, 59))).toBe(true);
  }, 120_000);

  it("renders a backdrop in its own low-resolution pass, beneath frame-aligned graphics", async () => {
    const file = join(dir, "layers.json");
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "layers", width: 540, height: 960, fps: 30 },
        theme: "dark-tech",
        scenes: [
          // Listed after the rect on purpose: background components always draw beneath.
          { id: "red", startFrame: 30, durationFrames: 15, transition: "cut", components: [{ type: "rect", x: 40, y: 40, w: 20, h: 20, color: "#FF0000" }] },
          { id: "bg", startFrame: 0, durationFrames: 60, transition: "cut", components: [{ type: "backdrop" }] },
        ],
      }),
    );
    const output = join(dir, "layers.mp4");
    const result = await renderProject(file, output, { concurrency: 2 });
    expect(result.report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.stats.painted).toBeGreaterThanOrEqual(60); // the background pass painted every frame
    const [r, g, b] = await centrePixel(output, 29);
    expect(Math.max(r, g, b)).toBeLessThan(90); // dark-tech backdrop, no rect yet
    expect(isRed(await centrePixel(output, 30))).toBe(true);
    expect(isRed(await centrePixel(output, 45))).toBe(false);
  }, 120_000);

  it("graphics stay frame-aligned with footage after cuts", async () => {
    const source = join(dir, "blue.mp4");
    await runOrThrow(defaultTools.ffmpeg, [
      "-hide_banner", "-y",
      "-f", "lavfi", "-i", "color=c=0x0000FF:size=640x360:rate=30:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
    ]);
    const file = join(dir, "footage.json");
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "align", width: 540, height: 960, fps: 30 },
        sources: [{ id: "cam", path: "blue.mp4" }],
        // 0-1 s and 1.5-2 s: output is 45 frames with a cut at frame 30.
        edit: { sourceId: "cam", keep: [{ start: 0, end: 1 }, { start: 1.5, end: 2 }] },
        scenes: [{ id: "red", startFrame: 32, durationFrames: 5, transition: "cut", components: [{ type: "rect", x: 0, y: 0, w: 100, h: 100, color: "#FF0000" }] }],
      }),
    );
    const output = join(dir, "footage.mp4");
    const result = await renderProject(file, output, { concurrency: 2 });
    expect(result.durationFrames).toBe(45);
    expect(result.report.checks.filter((c) => !c.ok)).toEqual([]);
    const [r, g, b] = await centrePixel(output, 31);
    expect(b).toBeGreaterThan(200);
    expect(r + g).toBeLessThan(80);
    expect(isRed(await centrePixel(output, 32))).toBe(true);
    expect(isRed(await centrePixel(output, 36))).toBe(true);
    expect(isRed(await centrePixel(output, 37))).toBe(false);
  }, 120_000);
});
