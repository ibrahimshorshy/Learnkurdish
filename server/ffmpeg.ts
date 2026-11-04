/** ffmpeg: whether it is installed, and running it. */

import { execFile, spawn } from "child_process";
import { promisify } from "util";
import type { Response } from "express";

export const execFileAsync = promisify(execFile);

let ffmpegAvailable = false;

export async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegAvailable) return true;
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    ffmpegAvailable = true;
  } catch {
    // Not cached when missing, so installing it does not need a restart.
    return false;
  }
  return true;
}

export const FFMPEG_MISSING =
  "This needs ffmpeg. Install it (Windows: winget install Gyan.FFmpeg, macOS: brew install ffmpeg, Linux: sudo apt install ffmpeg) and restart the app.";

export interface ToolOptions {
  /** Kills the process when aborted. The promise still settles only once it has exited. */
  signal?: AbortSignal;
  /** Most bytes kept of stdout and of stderr; the oldest output is dropped beyond it. */
  maxBuffer?: number;
}

/** Thrown when a tool was stopped through its signal. */
export class ToolAborted extends Error {
  readonly aborted = true;
  constructor(tool: string) {
    super(`${tool} was stopped.`);
    this.name = "ToolAborted";
  }
}

export function isAborted(err: unknown): boolean {
  return Boolean((err as { aborted?: boolean })?.aborted) || (err as Error)?.name === "AbortError";
}

/**
 * Runs a command-line tool and collects its output.
 *
 * Unlike execFile with a signal, an abort settles the promise only after the
 * process has exited: a caller that removes its work folder in a `finally`
 * then never deletes files the process still has open (on Windows that rm
 * would fail and leave the files behind for good).
 *
 * Rejects like execFile does: an Error whose message carries stderr, with
 * `code`, `stdout` and `stderr` on it.
 */
export function runTool(
  command: string,
  args: string[],
  { signal, maxBuffer = 1024 * 1024 * 32 }: ToolOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ToolAborted(command));
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const keep = (text: string, chunk: Buffer) => {
      const next = text + chunk.toString("utf8");
      return next.length > maxBuffer ? next.slice(next.length - maxBuffer) : next;
    };
    child.stdout.on("data", (chunk: Buffer) => (stdout = keep(stdout, chunk)));
    child.stderr.on("data", (chunk: Buffer) => (stderr = keep(stderr, chunk)));

    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => signal?.removeEventListener("abort", onAbort);

    child.on("error", (err) => {
      done();
      reject(err);
    });
    child.on("close", (code, killedBy) => {
      done();
      if (signal?.aborted) return reject(new ToolAborted(command));
      if (code === 0) return resolve({ stdout, stderr });
      const error = Object.assign(
        new Error(`Command failed: ${command} ${args.join(" ")}\n${stderr}`),
        { code, signal: killedBy, stdout, stderr }
      );
      reject(error);
    });
  });
}

/** Runs ffmpeg with the given arguments; rejects with its error output. */
export function ffmpeg(args: string[], options: ToolOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return runTool("ffmpeg", ["-hide_banner", ...args], options);
}

/**
 * A signal that fires when the browser goes away before the response has been
 * sent (a cancel, a closed tab, leaving the step), so the work for it stops.
 */
export function abortOnClose(res: Response): AbortSignal {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}
