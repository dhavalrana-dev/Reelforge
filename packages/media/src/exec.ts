import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Tools {
  ffmpeg: string;
  ffprobe: string;
}

export const defaultTools: Tools = {
  ffmpeg: process.env.REELFORGE_FFMPEG ?? "ffmpeg",
  ffprobe: process.env.REELFORGE_FFPROBE ?? "ffprobe",
};

/** Runs a command without a shell. Never rejects on a non-zero exit; rejects only if it can't start. */
export interface RunOptions {
  cwd?: string;
  /** Extra environment variables, merged over the current environment. */
  env?: Record<string, string>;
  /** Called with each chunk of stderr as it arrives (progress output). */
  onStderr?: (chunk: string) => void;
}

export function run(cmd: string, args: string[], { cwd, env, onStderr }: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, cwd, env: env && { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
      onStderr?.(d);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Runs a command while streaming `input` chunks to its stdin, waiting on
 * back-pressure so producers never run unboundedly ahead of the consumer.
 */
export function runWithInput(cmd: string, args: string[], input: AsyncIterable<Buffer>, { cwd, env }: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, cwd, env: env && { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    let feedError: Error | undefined;
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    // EPIPE here means the process exited early; its exit code and stderr explain why.
    child.stdin.on("error", () => undefined);
    child.on("error", reject);
    child.on("close", (code) => {
      if (feedError) reject(feedError);
      else resolve({ code: code ?? -1, stdout, stderr });
    });

    (async () => {
      try {
        for await (const chunk of input) {
          if (child.stdin.destroyed) break;
          if (!child.stdin.write(chunk)) {
            await new Promise<void>((r) => {
              const done = () => {
                child.stdin.off("drain", done);
                child.stdin.off("close", done);
                r();
              };
              child.stdin.once("drain", done);
              child.stdin.once("close", done);
            });
          }
        }
      } catch (e) {
        feedError = e as Error;
        child.kill();
      } finally {
        child.stdin.end();
      }
    })();
  });
}

/**
 * Streams `input` through a command and yields its stdout as it arrives.
 * Throws after the last chunk if the command fails.
 */
export async function* pipeThrough(cmd: string, args: string[], input: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const child = spawn(cmd, args, { windowsHide: true });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  child.stdin.on("error", () => undefined);
  const exited = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });

  let feedError: Error | undefined;
  const feeding = (async () => {
    try {
      for await (const chunk of input) {
        if (child.stdin.destroyed) break;
        if (!child.stdin.write(chunk)) {
          await new Promise<void>((r) => {
            const done = () => {
              child.stdin.off("drain", done);
              child.stdin.off("close", done);
              r();
            };
            child.stdin.once("drain", done);
            child.stdin.once("close", done);
          });
        }
      }
    } catch (e) {
      feedError = e as Error;
      child.kill();
    } finally {
      child.stdin.end();
    }
  })();

  try {
    for await (const chunk of child.stdout) yield chunk as Buffer;
  } finally {
    if (child.exitCode === null) child.kill();
  }
  await feeding;
  const code = await exited;
  if (feedError) throw feedError;
  if (code !== 0) throw new Error(`${cmd} exited with code ${code}\n${stderr.trim().split("\n").slice(-8).join("\n")}`);
}

export async function runOrThrow(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult> {
  const result = await run(cmd, args, opts);
  if (result.code !== 0) {
    const tail = result.stderr.trim().split("\n").slice(-8).join("\n");
    throw new Error(`${cmd} exited with code ${result.code}\n${tail}`);
  }
  return result;
}
