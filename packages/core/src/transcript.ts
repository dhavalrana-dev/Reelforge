import { z } from "zod";

export const TranscriptWordSchema = z.object({
  text: z.string().min(1),
  start: z.number().min(0),
  end: z.number().min(0),
  probability: z.number().min(0).max(1).optional(),
});

export const TranscriptSchema = z.object({
  schemaVersion: z.literal("1.0"),
  source: z.string(),
  model: z.string(),
  language: z.string(),
  duration: z.number().min(0),
  segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
  words: z.array(TranscriptWordSchema),
});

export type Transcript = z.infer<typeof TranscriptSchema>;
export type TranscriptWord = z.infer<typeof TranscriptWordSchema>;
