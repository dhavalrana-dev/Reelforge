import { describe, expect, it } from "vitest";
import { validateProject, type Project } from "@reelforge/core";
import { COMPONENTS, checkReadability, minSceneFrames, renderFrameHtml, requiredSeconds } from "../src";

const projectWith = (components: object[], durationFrames = 120, transition: "fade" | "cut" = "cut"): Project =>
  validateProject({
    schemaVersion: "1.0",
    project: { name: "t", width: 1080, height: 1920, fps: 30 },
    scenes: [{ id: "s", startFrame: 0, durationFrames, transition, components }],
  }).project!;

/** Every CSS opacity in the markup, i.e. how faded each text-bearing element still is. */
const opacities = (html: string) => [...html.matchAll(/opacity:([\d.]+)/g)].map((m) => Number(m[1]));

describe("requiredSeconds", () => {
  it("reads Latin at 15 characters a second plus a second to find the text, at least 1.5 s", () => {
    expect(requiredSeconds("Hi")).toBe(1.5);
    expect(requiredSeconds("What happens when you open a website?")).toBeCloseTo(31 / 15 + 1);
  });

  it("gives CJK characters more time each", () => {
    expect(requiredSeconds("网站是怎么加载的")).toBeCloseTo(8 / 4.5 + 1);
    expect(requiredSeconds("DNS 查询")).toBeCloseTo(2 / 4.5 + 3 / 15 + 1);
  });
});

describe("text timing matches the animation", () => {
  const cases: [string, object][] = [
    ["word-reveal", { type: "kinetic-text", text: "one two three four", stagger: 4, delay: 3 }],
    ["fade-up", { type: "kinetic-text", text: "one two", animation: "fade-up", delay: 2 }],
    ["lower-third", { type: "lower-third", title: "Ada", subtitle: "Engineer", delay: 5 }],
    ["bullet-list", { type: "bullet-list", title: "Tips", items: ["a", "b", "c"], stagger: 7 }],
  ];

  it.each(cases)("%s: fully faded in at the reported frame, not one frame before", (_, component) => {
    const project = projectWith([component]);
    const c = project.scenes[0]!.components[0]!;
    const reg = COMPONENTS[c.type]!;
    const { type: _t, ...raw } = c;
    const from = Math.max(...reg.texts!(reg.props.parse(raw)).map((t) => t.from));
    expect(Math.min(...opacities(renderFrameHtml(project, from)))).toBeCloseTo(1, 6);
    expect(Math.min(...opacities(renderFrameHtml(project, from - 1)))).toBeLessThan(1);
  });

  it("typewriter: the whole text is on screen at the reported frame, not before", () => {
    const project = projectWith([{ type: "kinetic-text", text: "typed out", animation: "typewriter" }]);
    const from = COMPONENTS["kinetic-text"]!.texts!(COMPONENTS["kinetic-text"]!.props.parse({ text: "typed out", animation: "typewriter" }))[0]!.from;
    expect(renderFrameHtml(project, from)).toContain("typed out");
    expect(renderFrameHtml(project, from - 1)).not.toContain("typed out");
  });
});

describe("checkReadability", () => {
  const headline = { type: "kinetic-text", text: "What happens when you open a website?" };

  it("flags text that isn't on screen long enough, with how far short it is", () => {
    const { checked, issues } = checkReadability(projectWith([headline], 60));
    expect(checked).toBe(1);
    expect(issues[0]).toMatchObject({ scene: "s", type: "kinetic-text", id: "text" });
    expect(issues[0]!.shortByFrames).toBeGreaterThan(0);
    expect(checkReadability(projectWith([headline], 150)).issues).toEqual([]);
  });

  it("doesn't count a fading scene's fade-out as readable time", () => {
    const frames = minSceneFrames(projectWith([headline], 1, "cut").scenes[0]!, 30);
    expect(checkReadability(projectWith([headline], frames, "cut")).issues).toEqual([]);
    expect(checkReadability(projectWith([headline], frames, "fade")).issues).toHaveLength(1);
  });

  it("minSceneFrames is exactly the shortest passing length", () => {
    for (const transition of ["cut", "fade"] as const) {
      const scene = projectWith([headline, { type: "lower-third", title: "Ada Lovelace" }], 1, transition).scenes[0]!;
      const frames = minSceneFrames(scene, 30);
      expect(checkReadability(projectWith(scene.components, frames, transition)).issues).toEqual([]);
      expect(checkReadability(projectWith(scene.components, frames - 1, transition)).issues.length).toBeGreaterThan(0);
    }
  });

  it("reports text that never settles before its scene ends", () => {
    const { issues } = checkReadability(projectWith([{ type: "counter", to: 5, duration: 90 }], 60));
    expect(issues[0]!.visibleSeconds).toBe(0);
  });

  it("ignores components without text", () => {
    expect(checkReadability(projectWith([{ type: "backdrop" }, { type: "rect", x: 0, y: 0, w: 1, h: 1 }]))).toEqual({ checked: 0, issues: [] });
  });
});
