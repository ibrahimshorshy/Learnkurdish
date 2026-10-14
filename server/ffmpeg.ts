/** ffmpeg: whether it is installed, and running it. */

import { execFile } from "child_process";
import { promisify } from "util";

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

/** Runs ffmpeg with the given arguments; rejects with its error output. */
export function ffmpeg(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("ffmpeg", ["-hide_banner", ...args], { maxBuffer: 1024 * 1024 * 32 });
}
