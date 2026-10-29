import { defaultTools, run, type Tools } from "./exec";
import { findWorkerPython } from "./transcribe";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

async function version(cmd: string): Promise<string | null> {
  try {
    const r = await run(cmd, ["-hide_banner", "-version"]);
    return r.code === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

export async function runDoctor(tools: Tools = defaultTools): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "Node.js", status: major >= 20 ? "ok" : "fail", detail: `v${process.versions.node} (need >= 20)` });

  const ffmpeg = await version(tools.ffmpeg);
  const ffprobe = await version(tools.ffprobe);
  checks.push({ name: "FFmpeg", status: ffmpeg ? "ok" : "fail", detail: ffmpeg?.split("\n")[0] ?? `"${tools.ffmpeg}" not found on PATH` });
  checks.push({ name: "FFprobe", status: ffprobe ? "ok" : "fail", detail: ffprobe?.split("\n")[0] ?? `"${tools.ffprobe}" not found on PATH` });

  if (ffmpeg) {
    const gpl = ffmpeg.includes("--enable-gpl");
    const nonfree = ffmpeg.includes("--enable-nonfree");
    checks.push({
      name: "FFmpeg license",
      status: nonfree ? "fail" : gpl ? "warn" : "ok",
      detail: nonfree
        ? "built with --enable-nonfree: not redistributable"
        : gpl
          ? "GPL build: fine for local use, needs review before bundling in a commercial installer"
          : "LGPL build",
    });
    checks.push({
      name: "H.264 encoder",
      status: ffmpeg.includes("--enable-libx264") ? "ok" : "fail",
      detail: ffmpeg.includes("--enable-libx264") ? "libx264 available" : "libx264 missing; MP4 export will fail",
    });
    checks.push({
      name: "Caption renderer",
      status: ffmpeg.includes("--enable-libass") ? "ok" : "warn",
      detail: ffmpeg.includes("--enable-libass") ? "libass available" : "libass missing; --captions will fail",
    });
  }

  const python = findWorkerPython();
  const whisper = await run(python, ["-c", "import faster_whisper; print(faster_whisper.__version__)"]).catch(() => null);
  checks.push({
    name: "Transcription",
    status: whisper?.code === 0 ? "ok" : "warn",
    detail:
      whisper?.code === 0
        ? `faster-whisper ${whisper.stdout.trim()} (${python})`
        : "faster-whisper not found; install workers/transcribe/requirements.txt to enable captions",
  });
  return checks;
}
