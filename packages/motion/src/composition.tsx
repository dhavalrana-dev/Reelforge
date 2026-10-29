import { mapRange, type Project, type Scene } from "@reelforge/core";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ZodTypeAny } from "zod";
import { Counter, CounterProps } from "./components/counter";
import { KineticText, KineticTextProps } from "./components/kinetic-text";
import { LowerThird, LowerThirdProps } from "./components/lower-third";
import { NetworkDiagram, NetworkDiagramProps } from "./components/network-diagram";
import { Backdrop, BackdropProps, Rect, RectProps } from "./components/shapes";
import type { FrameContext } from "./context";
import { getTheme, type Theme } from "./theme";

interface RegisteredComponent {
  props: ZodTypeAny;
  // Props are validated against `props` before rendering.
  render: ComponentType<any>;
}

export const COMPONENTS: Record<string, RegisteredComponent> = {
  "kinetic-text": { props: KineticTextProps, render: KineticText },
  "lower-third": { props: LowerThirdProps, render: LowerThird },
  "network-diagram": { props: NetworkDiagramProps, render: NetworkDiagram },
  counter: { props: CounterProps, render: Counter },
  rect: { props: RectProps, render: Rect },
  backdrop: { props: BackdropProps, render: Backdrop },
};

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
      const parsed = reg.props.safeParse(props);
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
