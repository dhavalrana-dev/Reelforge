import { ProjectSchema, SceneSchema, mapRange, type Project, type Scene } from "@reelforge/core";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { z, type AnyZodObject } from "zod";
import { BarChart, BarChartProps } from "./components/bar-chart";
import { BrowserWindow, BrowserWindowProps } from "./components/browser-window";
import { BulletList, BulletListProps } from "./components/bullet-list";
import { Counter, CounterProps } from "./components/counter";
import { KineticText, KineticTextProps } from "./components/kinetic-text";
import { LowerThird, LowerThirdProps } from "./components/lower-third";
import { NetworkDiagram, NetworkDiagramProps } from "./components/network-diagram";
import { Backdrop, BackdropProps, Rect, RectProps } from "./components/shapes";
import type { FrameContext } from "./context";
import { getTheme, type Theme } from "./theme";

interface RegisteredComponent {
  props: AnyZodObject;
  /** One line for agents choosing a component. */
  description: string;
  // Props are validated against `props` before rendering.
  render: ComponentType<any>;
}

export const COMPONENTS: Record<string, RegisteredComponent> = {
  "kinetic-text": {
    props: KineticTextProps,
    render: KineticText,
    description: "Headline text: word-by-word reveal, fade-up or typewriter; highlight words in the accent colour.",
  },
  "lower-third": { props: LowerThirdProps, render: LowerThird, description: "Name strap with title and optional subtitle." },
  "network-diagram": {
    props: NetworkDiagramProps,
    render: NetworkDiagram,
    description: "2-6 labelled nodes that appear in sequence, linked by lines that draw themselves, with data packets flowing.",
  },
  "browser-window": {
    props: BrowserWindowProps,
    render: BrowserWindow,
    description: "Browser mock-up: URL types itself, loading bar runs, page skeleton and headline appear.",
  },
  "bar-chart": { props: BarChartProps, render: BarChart, description: "Up to 7 horizontal bars growing in sequence with counting values." },
  "bullet-list": { props: BulletListProps, render: BulletList, description: "Optional heading and up to 6 items sliding in with check, dot or number markers." },
  counter: { props: CounterProps, render: Counter, description: "Large number counting up, with prefix, suffix and label." },
  rect: { props: RectProps, render: Rect, description: "Plain rectangle positioned in percent of the frame." },
  backdrop: { props: BackdropProps, render: Backdrop, description: "Full-frame theme background with a slowly drifting glow, for videos without footage." },
};

/** A component entry in a project file: its type plus that component's props. */
export function componentSchema() {
  const variants = Object.entries(COMPONENTS).map(([type, c]) =>
    z.object({ type: z.literal(type) }).merge(c.props).strict().describe(c.description),
  );
  return z.discriminatedUnion("type", variants as unknown as [AnyZodObject, AnyZodObject, ...AnyZodObject[]]);
}

/** The full project schema with every component's props spelled out (for JSON Schema export). */
export function projectSchemaWithComponents() {
  return ProjectSchema.extend({
    scenes: z.array(SceneSchema.extend({ components: z.array(componentSchema()) })).default([]),
  });
}

/** Frames a "fade" scene takes to fade in and out. */
const FADE_FRAMES = 6;

/** Checks every component type and its props up front, so a render never fails half way. */
export function validateComposition(project: Project): string[] {
  const errors: string[] = [];
  getTheme(project.theme);
  project.scenes.forEach((scene, si) => {
    scene.components.forEach((c, ci) => {
      const reg = COMPONENTS[c.type];
      const where = `scenes.${si}.components.${ci}`;
      if (!reg) {
        errors.push(`${where}: unknown component "${c.type}"; available: ${Object.keys(COMPONENTS).join(", ")}`);
        return;
      }
      const { type: _type, ...props } = c;
      // Strict: a misspelt prop is an error, not silently ignored.
      const parsed = reg.props.strict().safeParse(props);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) errors.push(`${where}.${issue.path.join(".") || "(props)"}: ${issue.message}`);
      }
    });
  });
  return errors;
}

export function activeScenes(project: Project, frame: number): Scene[] {
  return project.scenes.filter((s) => frame >= s.startFrame && frame < s.startFrame + s.durationFrames);
}

function sceneOpacity(scene: Scene, local: number): number {
  if (scene.transition === "cut") return 1;
  const fade = Math.min(FADE_FRAMES, Math.floor(scene.durationFrames / 2));
  if (fade === 0) return 1;
  return Math.min(
    mapRange(local, [0, fade], [0, 1]),
    mapRange(local, [scene.durationFrames - fade, scene.durationFrames], [1, 0]),
  );
}

function Frame({ project, frame, theme }: { project: Project; frame: number; theme: Theme }) {
  const { width, height, fps } = project.project;
  const u = Math.min(width, height) / 100;
  return (
    <>
      {activeScenes(project, frame).map((scene) => {
        const local = frame - scene.startFrame;
        const ctx: FrameContext = { frame: local, durationFrames: scene.durationFrames, fps, width, height, u, portrait: height > width, theme };
        return (
          <div key={scene.id} data-scene={scene.id} style={{ position: "absolute", inset: 0, opacity: sceneOpacity(scene, local) }}>
            {scene.components.map((c, i) => {
              const { type, ...props } = c;
              const Component = COMPONENTS[type]!.render;
              return <Component key={i} {...props} ctx={ctx} />;
            })}
          </div>
        );
      })}
    </>
  );
}

/** Markup for one frame. A pure function of (project, frame). */
export function renderFrameHtml(project: Project, frame: number): string {
  return renderToStaticMarkup(<Frame project={project} frame={frame} theme={getTheme(project.theme)} />);
}

/** The page that frames are painted into: transparent, exactly frame-sized, no scrollbars. */
export function pageHtml(project: Project): string {
  const { width, height } = project.project;
  const theme = getTheme(project.theme);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:${width}px;height:${height}px}
#root{position:relative;width:${width}px;height:${height}px;overflow:hidden;font-family:${theme.font};
-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
*{box-sizing:border-box}
</style></head><body><div id="root"></div></body></html>`;
}
