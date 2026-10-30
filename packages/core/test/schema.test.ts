import { describe, expect, it } from "vitest";
import { validateProject } from "../src";

const blueprintExample = {
  schemaVersion: "1.0",
  project: { name: "How Websites Load", width: 1080, height: 1920, fps: 30 },
  theme: "dark-tech",
  scenes: [
    {
      id: "intro",
      startFrame: 0,
      durationFrames: 90,
      components: [{ type: "kinetic-text", text: "What happens when you open a website?", animation: "word-reveal" }],
    },
    {
      id: "diagram",
      startFrame: 90,
      durationFrames: 180,
      components: [{ type: "network-diagram", nodes: ["Browser", "Server", "Database"], animation: "sequential-flow" }],
    },
  ],
};

describe("validateProject", () => {
  it("accepts the blueprint example and keeps component props", () => {
    const { project, issues } = validateProject(blueprintExample);
    expect(issues).toEqual([]);
    expect(project!.scenes[1]!.components[0]).toMatchObject({ nodes: ["Browser", "Server", "Database"] });
  });

  it("reports structural errors with paths", () => {
    const { issues } = validateProject({ ...blueprintExample, project: { ...blueprintExample.project, fps: -1 } });
    expect(issues[0]).toMatchObject({ level: "error", path: "project.fps" });
  });

  it("flags odd dimensions, duplicate ids and unknown sources, but not layered scenes", () => {
    const { issues } = validateProject({
      ...blueprintExample,
      project: { ...blueprintExample.project, width: 1081 },
      scenes: [blueprintExample.scenes[0], { ...blueprintExample.scenes[1], id: "intro", startFrame: 60 }],
      edit: { sourceId: "missing", keep: [{ start: 0, end: 1 }] },
    });
    expect(issues.map((i) => `${i.level}:${i.path}`).sort()).toEqual([
      "error:edit.sourceId",
      "error:project",
      "error:scenes.1.id",
    ]);
  });
});
