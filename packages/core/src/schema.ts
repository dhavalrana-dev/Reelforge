import { z } from "zod";

export const SCHEMA_VERSION = "1.0";

const TimeRangeSchema = z
  .object({ start: z.number().min(0), end: z.number().min(0) })
  .refine((r) => r.end > r.start, { message: "end must be greater than start" });

export const ComponentSchema = z
  .object({
    type: z.string().min(1),
    animation: z.string().optional(),
  })
  .passthrough();

export const SceneSchema = z.object({
  id: z.string().min(1),
  startFrame: z.number().int().min(0),
  durationFrames: z.number().int().positive(),
  /** How the scene enters and leaves: a short fade, or a hard cut. */
  transition: z.enum(["fade", "cut"]).default("fade"),
  components: z.array(ComponentSchema).default([]),
});

export const SourceSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  kind: z.enum(["video", "audio", "image"]).default("video"),
});

export const EditSchema = z.object({
  sourceId: z.string().min(1),
  keep: z.array(TimeRangeSchema).min(1),
});

export const ProjectSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  project: z.object({
    name: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive().max(120),
  }),
  theme: z.string().optional(),
  /** Background colour for videos without footage. Defaults to the theme's. */
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected #RRGGBB").optional(),
  sources: z.array(SourceSchema).default([]),
  edit: EditSchema.optional(),
  /** Dialogue clean-up and loudness normalisation for footage audio. Omit to leave audio untouched. */
  audio: z
    .object({
      loudness: z.number().min(-40).max(-5).default(-14),
      truePeak: z.number().min(-9).max(0).default(-1),
      denoise: z.enum(["off", "light", "strong"]).default("light"),
      highpass: z.number().min(0).max(300).default(80),
      compress: z.boolean().default(true),
      expand: z.boolean().default(true),
    })
    .optional(),
  captions: z
    .object({
      /** Transcript JSON (source time), relative to the project file. */
      transcript: z.string().min(1),
      style: z.string().default("clean-pro"),
    })
    .optional(),
  scenes: z.array(SceneSchema).default([]),
});

export type Project = z.infer<typeof ProjectSchema>;
export type Scene = z.infer<typeof SceneSchema>;

export interface ProjectIssue {
  level: "error" | "warning";
  path: string;
  message: string;
}

/** Structural validation (zod) followed by checks the schema alone can't express. */
export function validateProject(input: unknown): { project?: Project; issues: ProjectIssue[] } {
  const parsed = ProjectSchema.safeParse(input);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((i) => ({ level: "error", path: i.path.join(".") || "(root)", message: i.message })),
    };
  }

  const project = parsed.data;
  const issues: ProjectIssue[] = [];
  const { width, height } = project.project;

  // H.264 with 4:2:0 chroma subsampling requires even dimensions.
  if (width % 2 || height % 2) {
    issues.push({ level: "error", path: "project", message: `dimensions must be even, got ${width}x${height}` });
  }

  const seen = new Set<string>();
  project.scenes.forEach((scene, i) => {
    if (seen.has(scene.id)) issues.push({ level: "error", path: `scenes.${i}.id`, message: `duplicate scene id "${scene.id}"` });
    seen.add(scene.id);
  });

  const ordered = [...project.scenes].sort((a, b) => a.startFrame - b.startFrame);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;
    if (cur.startFrame < prev.startFrame + prev.durationFrames) {
      issues.push({ level: "warning", path: "scenes", message: `scene "${cur.id}" overlaps "${prev.id}"` });
    }
  }

  if (project.edit && !project.sources.some((s) => s.id === project.edit!.sourceId)) {
    issues.push({ level: "error", path: "edit.sourceId", message: `unknown source "${project.edit.sourceId}"` });
  }

  return { project, issues };
}
