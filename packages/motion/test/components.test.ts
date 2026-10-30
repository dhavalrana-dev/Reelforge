import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateProject, type Project } from "@reelforge/core";
import { COMPONENTS, componentSchema, projectSchemaWithComponents, renderFrameHtml, splitBackground, validateComposition } from "../src";

const example = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../examples/prompt-to-video/how-websites-load.json", import.meta.url)), "utf8"),
);

/** Minimal valid props for each component, so every one gets exercised. */
const SAMPLES: Record<string, object> = {
  "kinetic-text": { text: "Hello world" },
  "lower-third": { title: "Ada" },
  "network-diagram": { nodes: ["A", "B", "C"] },
  "browser-window": { url: "example.com", headline: "Hi" },
  "bar-chart": { bars: [{ label: "a", value: 1 }, { label: "b", value: 3 }] },
  "bullet-list": { items: ["one", "two"] },
  counter: { to: 100 },
  rect: { x: 0, y: 0, w: 10, h: 10 },
  backdrop: {},
};

const projectWith = (components: object[], width = 1080, height = 1920): Project =>
  validateProject({
    schemaVersion: "1.0",
    project: { name: "t", width, height, fps: 30 },
    scenes: [{ id: "s", startFrame: 0, durationFrames: 120, components }],
  }).project!;

describe("components", () => {
  it("has a sample for every registered component", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(COMPONENTS).sort());
  });

  it.each(Object.keys(COMPONENTS))("%s renders every frame in portrait and landscape", (type) => {
    for (const [w, h] of [[1080, 1920], [1920, 1080]] as const) {
      const project = projectWith([{ type, ...SAMPLES[type] }], w, h);
      expect(validateComposition(project)).toEqual([]);
      const frames = [0, 1, 15, 45, 119].map((f) => renderFrameHtml(project, f));
      expect(frames.every((html) => html.length > 0)).toBe(true);
      expect(renderFrameHtml(project, 45)).toBe(frames[3]);
    }
  });

  it("rejects misspelt props instead of ignoring them", () => {
    const errors = validateComposition(projectWith([{ type: "network-diagram", nodess: ["A", "B"] }]));
    expect(errors.join("\n")).toMatch(/nodes/);
    expect(errors.join("\n")).toMatch(/Unrecognized key/);
  });

  it("exposes one schema variant per component, keyed on type", () => {
    const schema = componentSchema();
    expect(schema.safeParse({ type: "counter", to: 5 }).success).toBe(true);
    expect(schema.safeParse({ type: "counter" }).success).toBe(false);
    expect(schema.safeParse({ type: "sparkles" }).success).toBe(false);
  });

  it("splits background components into a quarter-size layer that keeps scene timing", () => {
    const { background, foreground } = splitBackground(validateProject(example).project!);
    expect(background!.project).toMatchObject({ width: 270, height: 480, fps: 30 });
    expect(background!.scenes.map((s) => [s.id, s.startFrame, s.durationFrames, s.transition])).toEqual([["background", 0, 900, "cut"]]);
    expect(foreground.project).toMatchObject({ width: 1080, height: 1920 });
    expect(foreground.scenes.some((s) => s.components.some((c) => c.type === "backdrop"))).toBe(false);
    expect(foreground.scenes).toHaveLength(7);
    expect(splitBackground(projectWith([{ type: "counter", to: 1 }])).background).toBeNull();
  });

  it("the prompt-to-video example is valid against the full schema", () => {
    const parsed = projectSchemaWithComponents().safeParse(example);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    const { project, issues } = validateProject(example);
    expect(issues).toEqual([]);
    expect(validateComposition(project!)).toEqual([]);
    expect(Math.max(...project!.scenes.map((s) => s.startFrame + s.durationFrames))).toBe(30 * 30);
  });
});
