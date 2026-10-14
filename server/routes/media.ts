/**
 * Uploaded videos: pulling the sound out so it can be transcribed, and burning
 * the finished subtitles back into the picture.
 *
 *   POST /api/media/extract-audio
 *        multipart `video` → 48kHz mono WAV of its sound. The picture's size
 *        (as displayed, after rotation) and length come back in X-Media-*
 *        headers, so one upload answers everything step 1 needs.
 *
 *   POST /api/render/subtitled?job=<id>
 *        multipart `video`, one `cue` PNG per subtitle, `cues` JSON
 *        [{file, start, end}], optional `overlay` PNG (the logo), optional
 *        `audio` (a cleaned-up replacement for the video's own sound), and
 *        width / height / fit → the same video in a 9:16 frame, subtitled.
 *   GET  /api/render/subtitled/progress?job=<id>  → { stage, fraction }
 *   POST /api/render/subtitled/cancel?job=<id>
 *
 * How the subtitles get in: every cue PNG is the same size (a band across the
 * frame), so they are strung together into ONE overlay stream with ffmpeg's
 * concat demuxer — each image held from its start to the next cue, with a
 * transparent image filling the gaps. The obvious alternative, one overlay
 * filter per cue gated with enable='between(t,…)', keeps every cue's decoded
 * image in memory for the whole render and opens one input per cue; a
 * ten-minute video has a couple of hundred cues. One stream costs the same at
 * five cues or five thousand.
 */

import type { Express, NextFunction, Request, Response } from "express";
import multer from "multer";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, type ChildProcess } from "child_process";
import { FFMPEG_MISSING, execFileAsync, ffmpeg, hasFfmpeg } from "../ffmpeg";

/* ------------------------------------------------------------------ */
/* Probing                                                              */
/* ------------------------------------------------------------------ */

export interface MediaInfo {
  /** As displayed: after the rotation phones store, and with square pixels. */
  width: number;
  height: number;
  durationSeconds: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

function parseRatio(value: unknown): number {
  const [a, b] = String(value ?? "").split(":").map(Number);
  return a > 0 && b > 0 ? a / b : 1;
}

/**
 * Display size from the coded size: a phone held upright usually records a
 * landscape frame plus "rotate 90°", and ffmpeg turns it upright on decode, so
 * the frame we actually get is the swapped one.
 */
function displaySize(width: number, height: number, sar: number, rotation: number) {
  const w = Math.round(width * sar);
  const quarterTurn = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  return quarterTurn ? { width: height, height: w } : { width: w, height };
}

async function probeWithFfprobe(file: string): Promise<MediaInfo> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    { maxBuffer: 1024 * 1024 * 8 }
  );
  const data = JSON.parse(stdout || "{}");
  const streams: any[] = Array.isArray(data.streams) ? data.streams : [];
  // Cover art in an audio file shows up as a one-frame "video" stream.
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === "audio");
  const duration =
    Number(data.format?.duration) || Number(video?.duration) || Number(audio?.duration) || 0;

  let size = { width: 0, height: 0 };
  if (video) {
    const matrix = (video.side_data_list ?? []).find((d: any) => typeof d?.rotation === "number");
    const rotation = Number(matrix?.rotation ?? video.tags?.rotate ?? 0) || 0;
    size = displaySize(Number(video.width) || 0, Number(video.height) || 0, parseRatio(video.sample_aspect_ratio), rotation);
  }
  return { ...size, durationSeconds: duration, hasVideo: Boolean(video), hasAudio: Boolean(audio) };
}

/**
 * The same facts read from `ffmpeg -i`'s banner, for installs that have
 * ffmpeg on the PATH but not ffprobe (a lone ffmpeg.exe copied into a folder
 * is common on Windows).
 */
async function probeWithFfmpeg(file: string): Promise<MediaInfo> {
  let banner = "";
  try {
    // With no output file ffmpeg prints the input's description and exits 1.
    await execFileAsync("ffmpeg", ["-hide_banner", "-i", file], { maxBuffer: 1024 * 1024 * 8 });
  } catch (err: any) {
    banner = String(err?.stderr || "");
  }
  const time = banner.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = time ? Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]) : 0;
  const videoLine = banner
    .split("\n")
    .find((line) => /Stream #.*Video:/.test(line) && !/attached pic/.test(line));
  let size = { width: 0, height: 0 };
  if (videoLine) {
    const dims = videoLine.match(/\b(\d{2,5})x(\d{2,5})\b/);
    const sar = videoLine.match(/\[SAR (\d+):(\d+)/);
    const rotation = banner.match(/rotation of (-?\d+(?:\.\d+)?) degrees/) ?? banner.match(/rotate\s*:\s*(-?\d+)/);
    if (dims) {
      size = displaySize(
        Number(dims[1]),
        Number(dims[2]),
        sar ? parseRatio(`${sar[1]}:${sar[2]}`) : 1,
        rotation ? Number(rotation[1]) : 0
      );
    }
  }
  return {
    ...size,
    durationSeconds: duration,
    hasVideo: Boolean(videoLine),
    hasAudio: /Stream #.*Audio:/.test(banner),
  };
}

export async function probeMedia(file: string): Promise<MediaInfo> {
  try {
    return await probeWithFfprobe(file);
  } catch {
    return probeWithFfmpeg(file);
  }
}

/* ------------------------------------------------------------------ */
/* Uploads into a per-request folder                                    */
/* ------------------------------------------------------------------ */

interface WorkRequest extends Request {
  workDir?: string;
  child?: ChildProcess;
  /** The browser hung up before the response was sent. */
  clientGone?: boolean;
  job?: RenderJob;
}

/**
 * Every upload for one request lands in its own temporary folder, which goes
 * as soon as the response is over — finished, failed or abandoned. If ffmpeg
 * is still running (the browser cancelled), it is stopped first; Windows will
 * not delete a file another process has open.
 */
function withWorkDir(req: WorkRequest, res: Response, next: NextFunction) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leen-media-"));
  req.workDir = dir;
  res.on("close", () => {
    if (!res.writableFinished) req.clientGone = true;
    const remove = () => fs.rm(dir, { recursive: true, force: true }, () => {});
    const child = req.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.once("close", remove);
      child.kill("SIGKILL");
    } else {
      remove();
    }
  });
  next();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => cb(null, (req as WorkRequest).workDir || os.tmpdir()),
    filename: (req, file, cb) => {
      const r = req as WorkRequest & { uploadCount?: number };
      r.uploadCount = (r.uploadCount ?? 0) + 1;
      const ext = path.extname(file.originalname || "").toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 8);
      cb(null, `${file.fieldname}-${r.uploadCount}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 * 1024, files: 10000 },
});

async function requireFfmpeg(_req: Request, res: Response, next: NextFunction) {
  if (!(await hasFfmpeg())) {
    res.status(503).json({ error: FFMPEG_MISSING });
    return;
  }
  next();
}

/* ------------------------------------------------------------------ */
/* Render jobs, for progress and cancelling                             */
/* ------------------------------------------------------------------ */

interface RenderJob {
  stage: "uploading" | "preparing" | "encoding" | "done" | "failed";
  fraction: number;
  child?: ChildProcess;
  cancelled?: boolean;
  touchedAt: number;
}

const jobs = new Map<string, RenderJob>();

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) if (now - job.touchedAt > 30 * 60 * 1000) jobs.delete(id);
}, 5 * 60 * 1000).unref();

function jobId(req: Request): string {
  return String(req.query.job ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}

/* ------------------------------------------------------------------ */
/* The subtitled render                                                 */
/* ------------------------------------------------------------------ */

export interface CueSpec {
  file: string;
  start: number;
  end: number;
}

/**
 * Sorted, inside the video, never overlapping, never empty. Overlap would
 * otherwise be resolved by whichever image the concat stream reached last.
 */
export function tidyCues(cues: CueSpec[], duration: number): CueSpec[] {
  const limit = duration > 0 ? duration : Infinity;
  const sorted = cues
    .filter((c) => c && typeof c.file === "string" && Number.isFinite(c.start) && Number.isFinite(c.end))
    .map((c) => ({ file: c.file, start: Math.max(0, c.start), end: Math.min(limit, c.end) }))
    .sort((a, b) => a.start - b.start);
  const out: CueSpec[] = [];
  sorted.forEach((cue, i) => {
    const next = sorted[i + 1];
    const end = next ? Math.min(cue.end, next.start) : cue.end;
    if (end - cue.start >= 0.01) out.push({ ...cue, end });
  });
  return out;
}

/**
 * The concat list that holds each cue on screen for its span and a blank in
 * between. Durations are written to the millisecond, and each image is read at
 * 1000 "fps" so its timestamp keeps that precision — at the image default of
 * 25fps every switch would be rounded to 40ms and the previous subtitle would
 * flash for a frame at the start of the next one.
 */
export function concatList(cues: CueSpec[], blank: string, total: number): string {
  const lines = ["ffconcat version 1.0"];
  const add = (file: string, seconds: number) => {
    if (seconds < 0.001) return;
    lines.push(`file '${file}'`, "option framerate 1000", `duration ${seconds.toFixed(3)}`);
  };
  let cursor = 0;
  for (const cue of cues) {
    add(blank, cue.start - cursor);
    add(cue.file, cue.end - cue.start);
    cursor = cue.end;
  }
  // Run the blank past the end so the overlay never runs out early; the
  // concat demuxer also needs the last file named twice to honour its duration.
  add(blank, Math.max(1, total - cursor + 1));
  lines.push(`file '${blank}'`, "option framerate 1000");
  return lines.join("\n") + "\n";
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** The source scaled into the W×H frame: fitted on a blurred copy of itself, or cropped to fill. */
export function frameFilter(
  fit: "blur" | "crop",
  source: { width: number; height: number },
  W: number,
  H: number
): string {
  const cover = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
  const sourceRatio = source.width && source.height ? source.width / source.height : 0;
  // Already (near enough) 9:16 — nothing to blur behind. An unknown shape
  // still gets the blur graph, which is right for any shape.
  if (fit === "crop" || (sourceRatio && Math.abs(sourceRatio - W / H) / (W / H) < 0.01)) {
    return `[0:v]${cover}[base]`;
  }
  // The background is blurred at a twelfth of the size and scaled back up:
  // the same look as a large blur at full size, for a fraction of the work.
  const bw = even(W / 12);
  const bh = even(H / 12);
  return [
    `[0:v]split=2[bgin][fgin]`,
    `[bgin]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=6:2,lutyuv=y=val*0.5,scale=${W}:${H},setsar=1[bg]`,
    `[fgin]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2[base]`,
  ].join(";");
}

function intParam(value: unknown, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

/** Width and height from a PNG's header, without decoding it. */
export function pngSize(file: string): { width: number; height: number } | null {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(24);
    fs.readSync(fd, head, 0, 24, 0);
    if (head.toString("latin1", 12, 16) !== "IHDR") return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

/** Runs ffmpeg with -progress, reporting the fraction of `duration` done. */
function runWithProgress(
  req: WorkRequest,
  job: RenderJob,
  args: string[],
  duration: number,
  onFraction: (fraction: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-nostats", "-progress", "pipe:1", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    req.child = child;
    job.child = child;
    let stderr = "";
    let pending = "";
    child.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        // out_time_us is microseconds; out_time_ms is too, despite its name.
        const match = line.match(/^out_time_(?:us|ms)=(\d+)/);
        if (match && duration > 0) onFraction(Math.min(1, Number(match[1]) / 1e6 / duration));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(signal ? `ffmpeg was stopped (${signal})` : stderr.trim() || `ffmpeg exited with ${code}`));
    });
  });
}

/* ------------------------------------------------------------------ */

export function registerMediaRoutes(app: Express) {
  app.post(
    "/api/media/extract-audio",
    requireFfmpeg,
    withWorkDir,
    upload.single("video"),
    async (req: WorkRequest, res: Response): Promise<any> => {
      const input = req.file?.path;
      if (!input) return res.status(400).json({ error: "No video was uploaded." });

      const info = await probeMedia(input);
      if (!info.hasVideo && !info.hasAudio) {
        return res.status(400).json({ error: "This file could not be read as a video. Try an MP4, MOV, WebM or MKV file." });
      }
      if (!info.hasVideo) {
        return res.status(400).json({
          error: "This file has sound but no picture. Upload a video here — for an audio recording, use the Lesson tab.",
        });
      }
      if (!info.hasAudio) {
        return res.status(422).json({
          error:
            "This video has no sound track, so there is nothing to transcribe. Check it was recorded with the microphone on.",
        });
      }

      const output = path.join(req.workDir!, "audio.wav");
      try {
        await ffmpeg([
          "-i", input,
          "-map", "0:a:0",
          "-vn", "-sn", "-dn",
          // Pads (or trims) the start so sample 0 of the WAV is time 0 of the
          // video. Without it, a sound track that starts a little after the
          // picture would put every subtitle that much early.
          "-af", "aresample=async=1:first_pts=0",
          "-ac", "1",
          "-ar", "48000",
          "-c:a", "pcm_s16le",
          "-loglevel", "error",
          "-y", output,
        ]);
      } catch (err: any) {
        console.error("Audio extraction failed:", err?.stderr || err);
        return res.status(500).json({ error: "Could not pull the sound out of this video. Is the file complete?" });
      }

      res.setHeader("X-Media-Width", String(info.width));
      res.setHeader("X-Media-Height", String(info.height));
      res.setHeader("X-Media-Duration", info.durationSeconds.toFixed(3));
      res.setHeader("Content-Type", "audio/wav");
      return res.sendFile(output);
    }
  );

  app.get("/api/render/subtitled/progress", (req, res) => {
    const job = jobs.get(jobId(req));
    if (!job) return res.json({ stage: "waiting", fraction: 0 });
    return res.json({ stage: job.stage, fraction: job.fraction });
  });

  app.post("/api/render/subtitled/cancel", (req, res) => {
    const job = jobs.get(jobId(req));
    if (job) {
      job.cancelled = true;
      job.child?.kill("SIGKILL");
    }
    res.json({ ok: true });
  });

  app.post(
    "/api/render/subtitled",
    requireFfmpeg,
    withWorkDir,
    // Registered before the upload, so a cancel that arrives mid-upload counts.
    (req: WorkRequest, _res: Response, next: NextFunction) => {
      req.job = { stage: "uploading", fraction: 0, touchedAt: Date.now() };
      jobs.set(jobId(req) || `s${Date.now().toString(36)}`, req.job);
      next();
    },
    upload.fields([
      { name: "video", maxCount: 1 },
      { name: "cue", maxCount: 10000 },
      { name: "overlay", maxCount: 1 },
      { name: "audio", maxCount: 1 },
    ]),
    async (req: WorkRequest, res: Response): Promise<any> => {
      const job = req.job!;
      job.stage = "preparing";
      const fail = (status: number, error: string) => {
        job.stage = "failed";
        // The browser may already have gone (cancelled); nobody to tell.
        if (req.clientGone) return;
        return res.status(status).json({ error });
      };

      if (job.cancelled) return fail(499, "The render was cancelled.");
      const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
      const video = files.video?.[0];
      if (!video) return fail(400, "No video was uploaded.");

      const W = even(intParam(req.body?.width, 1080));
      const H = even(intParam(req.body?.height, Math.round((W * 16) / 9)));
      if (W < 240 || W > 4096 || H < 240 || H > 4096) return fail(400, `Unsupported output size ${W}x${H}.`);
      const fit = req.body?.fit === "crop" ? "crop" : "blur";

      const info = await probeMedia(video.path);
      if (!info.hasVideo) return fail(400, "The uploaded file has no picture.");
      const duration = info.durationSeconds;

      // Cue images by the name the browser gave them.
      const byName = new Map((files.cue ?? []).map((f) => [f.originalname, f.path]));
      let specs: CueSpec[] = [];
      try {
        const parsed = JSON.parse(String(req.body?.cues || "[]"));
        specs = (Array.isArray(parsed) ? parsed : []).map((c: any) => ({
          file: String(c?.file ?? ""),
          start: Number(c?.start),
          end: Number(c?.end),
        }));
      } catch {
        return fail(400, "The subtitle timings could not be read.");
      }
      const missing = specs.find((c) => !byName.has(c.file));
      if (missing) return fail(400, `Subtitle image "${missing.file}" was not uploaded.`);
      const cues = tidyCues(
        specs.map((c) => ({ ...c, file: path.basename(byName.get(c.file)!) })),
        duration
      );

      const dir = req.workDir!;
      const inputs: string[] = ["-i", video.path];
      const graph: string[] = [frameFilter(fit, info, W, H)];
      let last = "base";
      let nextInput = 1;

      if (cues.length) {
        // A transparent image the size of the cue images, for the gaps; the
        // concat demuxer needs every image in the stream to be one size.
        const blank = "blank.png";
        const size = pngSize(path.join(dir, cues[0].file));
        if (!size) return fail(400, "The subtitle images must be PNG files.");
        await ffmpeg([
          "-f", "lavfi", "-i", `color=c=black@0.0:s=${size.width}x${size.height},format=rgba`,
          "-frames:v", "1", "-loglevel", "error", "-y", path.join(dir, blank),
        ]);
        const listPath = path.join(dir, "cues.ffconcat");
        fs.writeFileSync(listPath, concatList(cues, blank, duration || cues[cues.length - 1].end));
        // -safe 0 only so the list may use `option`; every name in it is ours.
        inputs.push("-f", "concat", "-safe", "0", "-i", listPath);
        const x = even(intParam(req.body?.cueX, 0));
        const y = even(intParam(req.body?.cueY, 0));
        graph.push(`[${last}][${nextInput}:v]overlay=${x}:${y}:eof_action=repeat[subs]`);
        last = "subs";
        nextInput++;
      }

      const overlay = files.overlay?.[0];
      if (overlay) {
        inputs.push("-i", overlay.path);
        const x = even(intParam(req.body?.overlayX, 0));
        const y = even(intParam(req.body?.overlayY, 0));
        // A single still: overlay repeats its one frame for the whole video.
        graph.push(`[${last}][${nextInput}:v]overlay=${x}:${y}:eof_action=repeat[logo]`);
        last = "logo";
        nextInput++;
      }
      graph.push(`[${last}]format=yuv420p[vout]`);

      const audio = files.audio?.[0];
      let audioMap: string[];
      if (audio) {
        inputs.push("-i", audio.path);
        audioMap = ["-map", `${nextInput}:a:0`];
        nextInput++;
      } else {
        // Optional: a video without sound still renders.
        audioMap = info.hasAudio ? ["-map", "0:a:0"] : [];
      }

      const output = path.join(dir, "subtitled.mp4");
      const args = [
        ...inputs,
        "-filter_complex", graph.join(";"),
        "-map", "[vout]",
        ...audioMap,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        ...(audioMap.length ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"] : []),
        // The source decides the length; a replacement track a few samples
        // longer must not add a frozen frame at the end.
        ...(duration > 0 ? ["-t", duration.toFixed(3)] : ["-shortest"]),
        "-movflags", "+faststart",
        "-loglevel", "error",
        "-y", output,
      ];

      if (job.cancelled) return fail(499, "The render was cancelled.");
      const started = Date.now();
      job.stage = "encoding";
      try {
        await runWithProgress(req, job, args, duration, (fraction) => {
          job.fraction = fraction;
          job.touchedAt = Date.now();
        });
      } catch (err: any) {
        if (job.cancelled || req.clientGone) return fail(499, "The render was cancelled.");
        console.error("Subtitled render failed:", err?.message || err);
        return fail(500, "ffmpeg could not make the subtitled video. " + String(err?.message || "").split("\n").slice(-3).join(" "));
      } finally {
        job.child = undefined;
      }
      job.stage = "done";
      job.fraction = 1;
      console.log(`Subtitled ${duration.toFixed(1)}s video with ${cues.length} cues in ${Date.now() - started}ms`);
      return res.download(output, "subtitled.mp4");
    }
  );
}
