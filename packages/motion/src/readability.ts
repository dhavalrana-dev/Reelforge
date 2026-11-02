import type { Project, Scene } from "@reelforge/core";
import { COMPONENTS, sceneFadeFrames } from "./composition";
import type { TextItem } from "./context";

/**
 * Checks that every on-screen text stays fully visible long enough to read,
 * from the project file alone (no rendering). Each component reports its
 * texts and the frame each is settled; a text is readable from then until
 * its scene starts fading out.
 *
 * Reading speed follows common subtitle guidance (about 15 characters a
 * second for Latin script, 4.5 for Chinese, Japanese and Korean, where one
 * character carries more), plus time to find the text on screen. Burned-in
 * captions follow speech and are not checked here.
 */

export interface ReadabilityOptions {
  /** Non-space Latin (and other non-CJK) characters read per second. */
  latinCps?: number;
  /** CJK characters read per second. */
  cjkCps?: number;
  /** Seconds added to every text to find it and start reading. */
  padSeconds?: number;
  /** No text may be readable for less than this. */
  minSeconds?: number;
}

export const DEFAULT_READABILITY: Required<ReadabilityOptions> = { latinCps: 15, cjkCps: 4.5, padSeconds: 1, minSeconds: 1.5 };

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function requiredSeconds(text: string, opts: ReadabilityOptions = {}): number {
  const o = { ...DEFAULT_READABILITY, ...opts };
  let cjk = 0;
  let other = 0;
  for (const ch of text.replace(/\s+/g, "")) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  return Math.max(o.minSeconds, cjk / o.cjkCps + other / o.latinCps + o.padSeconds);
}

export interface ReadabilityIssue {
  scene: string;
  component: number;
  type: string;
  id: string;
  text: string;
  /** Seconds the text is fully visible; 0 when it never settles before the scene ends. */
  visibleSeconds: number;
  requiredSeconds: number;
  /** Frames to add to the scene (or take off the animation) to pass. */
  shortByFrames: number;
}

export interface ReadabilityReport {
  checked: number;
  issues: ReadabilityIssue[];
}

export function checkReadability(project: Project, opts: ReadabilityOptions = {}): ReadabilityReport {
  const fps = project.project.fps;
  const issues: ReadabilityIssue[] = [];
  let checked = 0;
  for (const scene of project.scenes) {
    const readableUntil = scene.durationFrames - sceneFadeFrames(scene);
    scene.components.forEach((c, index) => {
      const reg = COMPONENTS[c.type];
      if (!reg?.texts) return;
      const { type: _type, ...raw } = c;
      const parsed = reg.props.safeParse(raw);
      if (!parsed.success) return; // validateComposition reports invalid props
      for (const item of reg.texts(parsed.data) as TextItem[]) {
        checked++;
        const visibleFrames = Math.max(0, readableUntil - item.from);
        const need = requiredSeconds(item.text, opts);
        const needFrames = Math.ceil(need * fps);
        if (visibleFrames < needFrames) {
          issues.push({
            scene: scene.id,
            component: index,
            type: c.type,
            id: item.id,
            text: item.text,
            visibleSeconds: visibleFrames / fps,
            requiredSeconds: need,
            shortByFrames: needFrames - visibleFrames,
          });
        }
      }
    });
  }
  return { checked, issues };
}

/**
 * The shortest scene length (frames) at which every text in the scene is
 * readable, for tools that lay scenes out.
 */
export function minSceneFrames(scene: Scene, fps: number, opts: ReadabilityOptions = {}): number {
  let frames = 1;
  for (const c of scene.components) {
    const reg = COMPONENTS[c.type];
    if (!reg?.texts) continue;
    const { type: _type, ...raw } = c;
    const parsed = reg.props.safeParse(raw);
    if (!parsed.success) continue;
    for (const item of reg.texts(parsed.data) as TextItem[]) {
      frames = Math.max(frames, item.from + Math.ceil(requiredSeconds(item.text, opts) * fps));
    }
  }
  // A fading scene needs its fade-out frames on top; the fade length depends on the length itself.
  return scene.transition === "cut" ? frames : frames + sceneFadeFrames({ ...scene, durationFrames: frames * 2 });
}

/** One line per issue, for CLI output and render warnings. */
export function describeReadabilityIssue(i: ReadabilityIssue): string {
  const quoted = i.text.length > 40 ? `${i.text.slice(0, 37)}...` : i.text;
  const visible = i.visibleSeconds > 0 ? `readable for ${i.visibleSeconds.toFixed(1)}s` : "never fully visible";
  return `scene "${i.scene}" ${i.type} "${quoted}": ${visible}, needs ${i.requiredSeconds.toFixed(1)}s (${i.shortByFrames} frames short)`;
}
