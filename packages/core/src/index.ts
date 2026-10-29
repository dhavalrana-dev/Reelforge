export * from "./timeline";
export * from "./captions";
export * from "./animation";
export * from "./schema";
export * from "./transcript";

export const OUTPUT_FORMATS = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
} as const;

export type OutputFormat = keyof typeof OUTPUT_FORMATS;
