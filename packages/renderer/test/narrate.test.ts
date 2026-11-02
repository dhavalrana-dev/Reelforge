import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TranscriptSchema, validateProject } from "@reelforge/core";
import { findWorkerPython, run } from "@reelforge/media";
import { narrateScript, readScript, renderProject } from "../src";

const ttsReady =
  existsSync(new URL("../../../workers/tts/models/kokoro-v1.0.onnx", import.meta.url)) &&
  (await run(findWorkerPython(), ["-c", "import kokoro_onnx, faster_whisper"]).then((r) => r.code === 0, () => false));

describe("readScript", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "reelforge-script-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads one line per non-empty line of text, or JSON lines", async () => {
    writeFileSync(join(dir, "s.txt"), "First line.\n\n  Second line.  \r\n");
    expect(await readScript(join(dir, "s.txt"))).toEqual([{ id: "l1", text: "First line." }, { id: "l2", text: "Second line." }]);
    writeFileSync(join(dir, "s.json"), JSON.stringify(["Hi.", { id: "outro", text: "Bye.", voice: "bm_george" }]));
    expect(await readScript(join(dir, "s.json"))).toEqual([{ id: "l1", text: "Hi." }, { id: "outro", text: "Bye.", voice: "bm_george" }]);
  });
});

describe.skipIf(!ttsReady)("narrateScript (Kokoro + whisper)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "reelforge-narrate-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("speaks, verifies and times every line, then renders with captions and ducked music", async () => {
    const projectFile = join(dir, "vo.json");
    const result = await narrateScript(
      [
        { id: "a", text: "Every website starts with a request." },
        { id: "b", text: "The server answers in milliseconds." },
      ],
      projectFile,
      { music: "calm", format: "16:9" },
    );
    expect(result.mismatches).toEqual([]);
    const [a, b] = result.lines;
    expect(a!.startFrame).toBe(12); // 0.4 s lead-in
    expect(b!.startFrame).toBeGreaterThan(a!.endFrame);
    expect(result.durationFrames).toBeGreaterThan(b!.endFrame);

    const { project, issues } = validateProject(JSON.parse(readFileSync(projectFile, "utf8")));
    expect(issues).toEqual([]);
    expect(project!.audioTracks.map((t) => [t.role, t.startFrame])).toEqual([["voice", a!.startFrame], ["voice", b!.startFrame], ["music", 0]]);
    const transcript = TranscriptSchema.parse(JSON.parse(readFileSync(join(dir, "vo.transcript.json"), "utf8")));
    const answers = transcript.words.find((w) => /answers/i.test(w.text))!;
    expect(answers.start).toBeGreaterThan(b!.startFrame / 30); // word times are in output time

    const render = await renderProject(projectFile, join(dir, "vo.mp4"), { concurrency: 2 });
    expect(render.report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(render.report.checks.find((c) => c.name === "loudness")?.ok).toBe(true);
  }, 300_000);
});
