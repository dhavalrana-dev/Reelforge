import { defaultTools, runOrThrow, type Tools } from "./exec";

export interface VideoStreamInfo {
  codec: string;
  width: number;
  height: number;
  /** Size after applying rotation metadata. */
  displayWidth: number;
  displayHeight: number;
  rotation: number;
  fps: number;
  frameCount: number | null;
  duration: number | null;
  variableFrameRate: boolean;
  pixelFormat: string | null;
}

export interface AudioStreamInfo {
  codec: string;
  channels: number;
  sampleRate: number;
  duration: number | null;
}

export interface MediaInfo {
  path: string;
  container: string;
  duration: number;
  sizeBytes: number | null;
  video: VideoStreamInfo | null;
  audio: AudioStreamInfo | null;
  orientation: "portrait" | "landscape" | "square" | null;
  warnings: string[];
}

// ffprobe's JSON is loosely shaped; parseProbe narrows it into MediaInfo.
type ProbeJson = { format?: any; streams?: any[] };

export function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split("/").map(Number);
  if (!num || !den) return 0;
  return num / den;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return v === undefined || Number.isNaN(n) ? null : n;
};

/** Pure conversion of `ffprobe -print_format json -show_format -show_streams` output. */
export function parseProbe(path: string, json: ProbeJson): MediaInfo {
  const streams = json.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === "audio");
  const warnings: string[] = [];

  let video: VideoStreamInfo | null = null;
  if (v) {
    const sideRotation = v.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation;
    const rotation = ((Number(sideRotation ?? v.tags?.rotate ?? 0) % 360) + 360) % 360;
    const swap = rotation === 90 || rotation === 270;
    const avg = parseRate(v.avg_frame_rate);
    const real = parseRate(v.r_frame_rate);
    const fps = avg || real;
    const variableFrameRate = avg > 0 && real > 0 && Math.abs(avg - real) / real > 0.01;
    video = {
      codec: v.codec_name,
      width: v.width,
      height: v.height,
      displayWidth: swap ? v.height : v.width,
      displayHeight: swap ? v.width : v.height,
      rotation,
      fps,
      frameCount: num(v.nb_frames),
      duration: num(v.duration),
      variableFrameRate,
      pixelFormat: v.pix_fmt ?? null,
    };
    if (variableFrameRate) {
      warnings.push(`possible variable frame rate (avg ${avg.toFixed(3)} vs nominal ${real.toFixed(3)} fps); output will be resampled to a constant rate`);
    }
    if (rotation) warnings.push(`rotation metadata ${rotation}°`);
  } else {
    warnings.push("no video stream");
  }

  const audio: AudioStreamInfo | null = a
    ? { codec: a.codec_name, channels: a.channels, sampleRate: Number(a.sample_rate), duration: num(a.duration) }
    : null;
  if (!audio) warnings.push("no audio stream");

  const orientation = video
    ? video.displayWidth === video.displayHeight
      ? "square"
      : video.displayWidth > video.displayHeight
        ? "landscape"
        : "portrait"
    : null;

  return {
    path,
    container: json.format?.format_name ?? "unknown",
    duration: num(json.format?.duration) ?? video?.duration ?? audio?.duration ?? 0,
    sizeBytes: num(json.format?.size),
    video,
    audio,
    orientation,
    warnings,
  };
}

export async function probe(path: string, tools: Tools = defaultTools): Promise<MediaInfo> {
  const { stdout } = await runOrThrow(tools.ffprobe, [
    "-v", "error",
    "-print_format", "json",
    "-show_format", "-show_streams",
    path,
  ]);
  return parseProbe(path, JSON.parse(stdout));
}
