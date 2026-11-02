/**
 * Script to video (blueprint workflow C): narrate a script, place a visual
 * against each spoken line, add a whoosh on every scene change, render.
 *
 *   npm run demo:voiceover
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Project } from "@reelforge/core";
import { synthSfx } from "@reelforge/media";
import { checkReadability, describeReadabilityIssue } from "@reelforge/motion";
import { narrateScript, readScript, renderProject, type NarratedLine } from "@reelforge/renderer";

const outDir = resolve("out/voiceover");
mkdirSync(outDir, { recursive: true });
const projectFile = join(outDir, "project.json");

console.log("== narrate");
const narration = await narrateScript(await readScript("examples/voiceover/script.txt"), projectFile, {
  music: "calm",
  onProgress: (l) => console.log(`  ${l}`),
});
for (const m of narration.mismatches) console.log(`warning: ${m.id} heard as "${m.heard}"`);

console.log("== scenes against the narration");
const project = JSON.parse(readFileSync(projectFile, "utf8")) as Project;
const line = (id: string) => narration.lines.find((l) => l.id === id)!;
// Each visual starts with its line and holds until the next line begins.
const span = (from: NarratedLine, until?: NarratedLine) => ({
  startFrame: from.startFrame,
  durationFrames: (until ? until.startFrame : narration.durationFrames) - from.startFrame,
});
const visuals: { id: string; on: string; next?: string; component: object }[] = [
  { id: "dns", on: "l2", next: "l3", component: { type: "network-diagram", nodes: ["Browser", "DNS"], step: 14 } },
  // Kept simple on purpose: the readability check flagged a longer URL, a page
  // headline and a three-node diagram as too much to read in these lines' time.
  { id: "request", on: "l3", next: "l4", component: { type: "browser-window", url: "example.com", typeSpeed: 1 } },
  { id: "server", on: "l4", next: "l5", component: { type: "network-diagram", nodes: ["Server", "Database"], step: 8 } },
  { id: "total", on: "l5", component: { type: "counter", to: 1, prefix: "< ", suffix: " s", label: "from tap to pixels", duration: 30 } },
];
const whoosh = join(outDir, "whoosh.wav");
await synthSfx("whoosh", whoosh);
for (const v of visuals) {
  const scene = { id: v.id, ...span(line(v.on), v.next ? line(v.next) : undefined), transition: "fade" as const, components: [v.component] };
  project.scenes.push(scene as Project["scenes"][number]);
  // The whoosh peaks as the scene fades in.
  project.audioTracks.push({ path: "whoosh.wav", role: "sfx", startFrame: Math.max(0, scene.startFrame - 10), gainDb: -10 });
}
writeFileSync(projectFile, JSON.stringify(project, null, 2));
for (const i of checkReadability(project).issues) console.log(`warning: ${describeReadabilityIssue(i)}`);

console.log("== render");
const result = await renderProject(projectFile, join(outDir, "voiceover.mp4"));
for (const c of result.report.checks) console.log(`  [${c.ok ? "OK  " : "FAIL"}] ${c.name}: ${c.detail}`);
console.log(`wrote out/voiceover/voiceover.mp4 (${(result.durationFrames / 30).toFixed(1)}s) in ${result.seconds.toFixed(0)}s`);
if (!result.report.ok) process.exitCode = 1;
