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
 *
 * Colour: the output is always BT.709 SDR (see server/color.ts). An HDR phone
 * video is tone-mapped, and the cue and logo PNGs are converted with the
 * BT.709 matrix, so the subtitles keep the colours the preview shows.
 */

import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import multer from "multer";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { FFMPEG_MISSING, ToolAborted, ffmpeg, hasFfmpeg, isAborted, runTool } from "../ffmpeg";
import { BT709_OUTPUT, TAG_BT709, hasToneMapping, hdrToSdr, isHdr, toBt709, type ColourInfo } from "../color";
import {
  CUE_LIST_FORMATS,
  GB,
  MB,
  PNG_FORMATS,
  VIDEO_FORMATS,
  WAV_FORMATS,
  asyncRoute,
  fieldStorage,
  only,
  receive,
  videoExtension,
} from "../uploads";

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
  /** The picture's colour description; empty when the file does not say. */
  colour: ColourInfo;
  /** Frames per second, 0 when unknown. */
  frameRate: number;
}

export interface ProbeOptions {
  /** Stops the probe (the browser went away). */
  signal?: AbortSignal;
  /** Containers the file may be (see server/uploads.ts); videos by default. */
  formats?: string;
}

function parseRatio(value: unknown): number {
  const [a, b] = String(value ?? "").split(":").map(Number);
  return a > 0 && b > 0 ? a / b : 1;
}

function parseRate(value: unknown): number {
  const [a, b] = String(value ?? "").split("/").map(Number);
  const rate = b > 0 ? a / b : a;
  return Number.isFinite(rate) && rate > 0 && rate < 1000 ? rate : 0;
}

/** ffprobe says "unknown" where the file says nothing. */
function known(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : "";
  return text && text !== "unknown" && text !== "unspecified" ? text : undefined;
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

async function probeWithFfprobe(file: string, { signal, formats = VIDEO_FORMATS }: ProbeOptions): Promise<MediaInfo> {
  const { stdout } = await runTool(
    "ffprobe",
    ["-v", "error", ...only(formats), "-print_format", "json", "-show_format", "-show_streams", file],
    { signal, maxBuffer: 1024 * 1024 * 8 }
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
  return {
    ...size,
    durationSeconds: duration,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    colour: {
      matrix: known(video?.color_space),
      transfer: known(video?.color_transfer),
      primaries: known(video?.color_primaries),
      range: known(video?.color_range),
      pixelFormat: known(video?.pix_fmt),
    },
    frameRate: parseRate(video?.avg_frame_rate) || parseRate(video?.r_frame_rate),
  };
}

/**
 * The colour part of a banner's video line, e.g.
 * "yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67, progressive)" or "yuv420p(tv, bt709)".
 * ffmpeg writes one name when matrix, primaries and transfer agree.
 */
export function bannerColour(videoLine: string): ColourInfo {
  const match = videoLine.match(/\b((?:yuv|yuvj|nv|p0|gray|rgb|bgr|gbr)[a-z0-9]*)(?:\(([^)]*)\))?/);
  if (!match) return {};
  const colour: ColourInfo = { pixelFormat: match[1] };
  for (const item of (match[2] ?? "").split(",").map((s) => s.trim())) {
    if (item === "tv" || item === "pc") colour.range = item;
    else if (item.includes("/")) {
      const [matrix, primaries, transfer] = item.split("/");
      Object.assign(colour, { matrix: known(matrix), primaries: known(primaries), transfer: known(transfer) });
    } else if (/^(bt|smpte|fcc|arib)/.test(item)) {
      Object.assign(colour, { matrix: item, primaries: item, transfer: item });
    }
  }
  return colour;
}

/**
 * The same facts read from `ffmpeg -i`'s banner, for installs that have
 * ffmpeg on the PATH but not ffprobe (a lone ffmpeg.exe copied into a folder
 * is common on Windows).
 */
async function probeWithFfmpeg(file: string, { signal, formats = VIDEO_FORMATS }: ProbeOptions): Promise<MediaInfo> {
  let banner = "";
  try {
    // With no output file ffmpeg prints the input's description and exits 1.
    await ffmpeg([...only(formats), "-i", file], { signal, maxBuffer: 1024 * 1024 * 8 });
  } catch (err: any) {
    if (isAborted(err)) throw err;
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
  const fps = videoLine?.match(/([\d.]+) fps/);
  return {
    ...size,
    durationSeconds: duration,
    hasVideo: Boolean(videoLine),
    hasAudio: /Stream #.*Audio:/.test(banner),
    colour: videoLine ? bannerColour(videoLine.replace(/^.*?Video:/, "")) : {},
    frameRate: fps ? parseRate(fps[1]) : 0,
  };
}

/**
 * How long the picture runs, read off its last frame. For files whose
 * container leaves the length out — a browser's MediaRecorder WebM, written
 * as it records — where the probe says 0. Copying the stream to nowhere is
 * fast: nothing is decoded. 0 when it cannot tell.
 */
async function measurePicture(file: string, info: MediaInfo, { signal, formats = VIDEO_FORMATS }: ProbeOptions): Promise<number> {
  try {
    const { stdout } = await runTool(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-progress", "pipe:1", ...only(formats), "-i", file, "-map", "0:v:0", "-c", "copy", "-f", "null", "-"],
      { signal }
    );
    const times = [...stdout.matchAll(/^out_time_us=(\d+)/gm)];
    const lastFrameAt = times.length ? Number(times[times.length - 1][1]) / 1e6 : 0;
    // That is when the last frame starts; it is on screen for one more.
    return lastFrameAt > 0 ? lastFrameAt + 1 / (info.frameRate || 30) : 0;
  } catch (err) {
    if (isAborted(err)) throw err;
    return 0;
  }
}

/**
 * What a file holds. Never rejects for a file it cannot read (that comes
 * back as no video and no audio); rejects only when `signal` stopped it.
 */
export async function probeMedia(file: string, options: ProbeOptions = {}): Promise<MediaInfo> {
  let info: MediaInfo;
  try {
    info = await probeWithFfprobe(file, options);
  } catch (err) {
    if (isAborted(err)) throw err;
    info = await probeWithFfmpeg(file, options);
  }
  if (info.hasVideo && !(info.durationSeconds > 0)) {
    info.durationSeconds = await measurePicture(file, info, options);
  }
  return info;
}

/* ------------------------------------------------------------------ */
/* Uploads into a per-request folder                                    */
/* ------------------------------------------------------------------ */

interface WorkRequest extends Request {
  workDir?: string;
  /**
   * Fires when the browser hangs up or the render is cancelled. Every
   * ffmpeg and ffprobe run for the request is given it, so they all stop.
   */
  signal?: AbortSignal;
  stop?: () => void;
  /** The route's own work; the folder is removed only once it has finished. */
  pending?: Set<Promise<unknown>>;
  /** The browser hung up before the response was sent. */
  clientGone?: boolean;
  job?: RenderJob;
}

/**
 * Every upload for one request lands in its own temporary folder, which goes
 * as soon as the response is over — finished, failed or abandoned. When the
 * browser goes away mid-way, its ffmpeg runs are stopped and the folder is
 * removed only after the route has finished, which is after every process it
 * started has exited: Windows will not delete a file another process has
 * open, and on Linux the route would otherwise find its files gone half-way.
 */
function withWorkDir(req: WorkRequest, res: Response, next: NextFunction) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leen-media-"));
  const controller = new AbortController();
  const pending = new Set<Promise<unknown>>();
  req.workDir = dir;
  req.signal = controller.signal;
  req.stop = () => controller.abort();
  req.pending = pending;
  res.on("close", () => {
    if (!res.writableFinished) {
      req.clientGone = true;
      controller.abort();
    }
    void (async () => {
      while (pending.size) await Promise.allSettled([...pending]);
      // Retries cover Windows, where a killed process's handles take a moment to go.
      fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }, (err) => {
        if (err) console.warn(`Could not remove ${dir}:`, err.message);
      });
    })();
  });
  next();
}

/** A route that works in the request's folder: its work holds the folder, and its failures are answered. */
function workRoute(handler: (req: WorkRequest, res: Response) => Promise<unknown>): RequestHandler {
  return asyncRoute<WorkRequest>((req, res) => {
    const work = handler(req, res);
    req.pending?.add(work);
    const forget = () => req.pending?.delete(work);
    work.then(forget, forget);
    return work;
  });
}

/** Most subtitles one render takes: one a second for well over an hour. */
const MAX_CUES = 6000;

const upload = multer({
  storage: fieldStorage((req) => (req as WorkRequest).workDir || os.tmpdir(), {
    // A long phone video in 4K is several GB.
    video: { maxBytes: 8 * GB, extension: videoExtension },
    // A band of mostly transparent pixels: tens of KB.
    cue: { maxBytes: 4 * MB, maxTotalBytes: 2 * GB, extension: () => ".png" },
    overlay: { maxBytes: 32 * MB, extension: () => ".png" },
    // A mono WAV: hours of it.
    audio: { maxBytes: 2 * GB, extension: () => ".wav" },
  }),
  limits: { fileSize: 8 * GB, files: MAX_CUES + 3, fields: 64, fieldSize: 4 * MB },
});

const requireFfmpeg = asyncRoute(async (_req: Request, res: Response, next: NextFunction) => {
  if (!(await hasFfmpeg())) {
    res.status(503).json({ error: FFMPEG_MISSING });
    return;
  }
  next();
});

/** The last lines of an ffmpeg error, which say what went wrong. */
function errorTail(err: unknown): string {
  const text = String((err as any)?.stderr || (err as Error)?.message || "");
  return text.trim().split("\n").slice(-3).join(" ");
}

/* ------------------------------------------------------------------ */
/* Render jobs, for progress and cancelling                             */
/* ------------------------------------------------------------------ */

interface RenderJob {
  stage: "uploading" | "preparing" | "encoding" | "done" | "failed";
  fraction: number;
  cancelled?: boolean;
  /** Stops the request's ffmpeg runs. */
  stop?: () => void;
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
 * How far the closing blank runs past the last cue: a day. The subtitle
 * overlay stops with the video (shortest=1, see subtitleGraph), so the cue
 * stream must outlast any video, including one whose length ffprobe could not
 * read. It costs nothing — the blank is still a single image.
 */
export const CUE_TAIL_SECONDS = 24 * 60 * 60;

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
  // The blank runs on long past the end (see CUE_TAIL_SECONDS); the concat
  // demuxer also needs the last file named twice to honour its duration.
  add(blank, Math.max(0, total - cursor) + CUE_TAIL_SECONDS);
  lines.push(`file '${blank}'`, "option framerate 1000");
  return lines.join("\n") + "\n";
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export interface FrameSource {
  width: number;
  height: number;
  colour?: ColourInfo;
}

/**
 * The source scaled into the W×H frame: fitted on a blurred copy of itself, or
 * cropped to fill. The scaling also converts the picture to BT.709, and an
 * HDR source is tone-mapped first (with zscale when `toneMapping`, see
 * server/color.ts) — after shrinking it to about the frame's size, since
 * tone-mapping a 4K picture in floating point would cost more than the encode.
 */
export function frameFilter(
  fit: "blur" | "crop",
  source: FrameSource,
  W: number,
  H: number,
  options: { toneMapping?: boolean } = {}
): string {
  const steps: string[] = [];
  let input = "[0:v]";
  let convert = toBt709(source.colour, source.width && source.height ? source : undefined);
  if (isHdr(source.colour)) {
    const chain: string[] = [];
    // Only ever down: the smallest size that still covers the frame.
    const shrink = source.width && source.height ? Math.min(1, Math.max(W / source.width, H / source.height)) : 1;
    if (shrink < 1) chain.push(`scale=${even(source.width * shrink)}:${even(source.height * shrink)}`);
    chain.push(hdrToSdr(source.colour, Boolean(options.toneMapping)));
    steps.push(`[0:v]${chain.join(",")}[sdr]`);
    input = "[sdr]";
    convert = toBt709({ matrix: "bt709", range: "tv" });
  }

  const cover = `scale=${W}:${H}:${convert}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
  const sourceRatio = source.width && source.height ? source.width / source.height : 0;
  // Already (near enough) 9:16 — nothing to blur behind. An unknown shape
  // still gets the blur graph, which is right for any shape.
  if (fit === "crop" || (sourceRatio && Math.abs(sourceRatio - W / H) / (W / H) < 0.01)) {
    steps.push(`${input}${cover},${TAG_BT709}[base]`);
    return steps.join(";");
  }
  // The background is blurred at a twelfth of the size and scaled back up:
  // the same look as a large blur at full size, for a fraction of the work.
  const bw = even(W / 12);
  const bh = even(H / 12);
  steps.push(
    `${input}split=2[bgin][fgin]`,
    `[bgin]scale=${bw}:${bh}:${convert}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=6:2,lutyuv=y=val*0.5,scale=${W}:${H},setsar=1[bg]`,
    `[fgin]scale=${W}:${H}:${convert}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,${TAG_BT709}[base]`
  );
  return steps.join(";");
}

/**
 * A PNG input made ready to lay over the picture: converted to YUV with the
 * BT.709 matrix. Left to itself, overlay converts it with BT.601, and a green
 * subtitle box (0,254,0) would come out (0,213,0).
 */
const pngToBt709 = "scale=out_color_matrix=bt709:out_range=tv,format=yuva420p";

/**
 * The whole picture: the framed source, then the subtitle stream (input 1)
 * and the logo (the next input), each placed at its pixel position. The
 * result is labelled [vout].
 *
 * shortest=1 on the subtitle overlay is what keeps the video its own length.
 * Without it, once the source's last frame has gone through, overlay goes on
 * making frames — the last picture again — each time the cue stream delivers
 * an image, so the blank that follows the final cue becomes one extra frame.
 * When the source's first frame is a few milliseconds after zero (common in
 * WebM and phone files), that extra frame survives -t and replaces the real
 * last frame, without its subtitle. The logo overlay must NOT have it: its
 * input is a single still that ends at once, and would end the video with it.
 */
export function subtitleGraph(options: {
  fit: "blur" | "crop";
  source: FrameSource;
  width: number;
  height: number;
  /** Where the cue band goes, or null with no cues. */
  cues: { x: number; y: number } | null;
  /** Where the logo goes, or null with none. */
  overlay: { x: number; y: number } | null;
  /** zscale is available for HDR sources. */
  toneMapping?: boolean;
}): string {
  const graph = [
    frameFilter(options.fit, options.source, options.width, options.height, { toneMapping: options.toneMapping }),
  ];
  let last = "base";
  let input = 1;
  if (options.cues) {
    graph.push(`[${input}:v]${pngToBt709}[cueimg]`);
    graph.push(`[${last}][cueimg]overlay=${options.cues.x}:${options.cues.y}:eof_action=repeat:shortest=1[subs]`);
    last = "subs";
    input++;
  }
  if (options.overlay) {
    // A single still: overlay repeats its one frame for the whole video.
    graph.push(`[${input}:v]${pngToBt709}[logoimg]`);
    graph.push(`[${last}][logoimg]overlay=${options.overlay.x}:${options.overlay.y}:eof_action=repeat[logo]`);
    last = "logo";
  }
  graph.push(`[${last}]format=yuv420p[vout]`);
  return graph.join(";");
}

function intParam(value: unknown, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from a PNG's header, without decoding it; null when it is not a PNG. */
export function pngSize(file: string): { width: number; height: number } | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const head = Buffer.alloc(24);
    if (fs.readSync(fd, head, 0, 24, 0) < 24) return null;
    if (!head.subarray(0, 8).equals(PNG_SIGNATURE) || head.toString("latin1", 12, 16) !== "IHDR") return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Runs ffmpeg with -progress, reporting the fraction of `duration` done.
 * Like runTool, an abort kills it and the promise settles only once it has
 * exited, rejecting with ToolAborted.
 */
function runWithProgress(
  args: string[],
  duration: number,
  signal: AbortSignal | undefined,
  onFraction: (fraction: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ToolAborted("ffmpeg"));
    const child = spawn("ffmpeg", ["-hide_banner", "-nostats", "-progress", "pipe:1", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
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
    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code, killedBy) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(new ToolAborted("ffmpeg"));
      if (code === 0) resolve();
      else reject(new Error(killedBy ? `ffmpeg was stopped (${killedBy})` : stderr.trim() || `ffmpeg exited with ${code}`));
    });
  });
}

/* ------------------------------------------------------------------ */

export function registerMediaRoutes(app: Express) {
  app.post(
    "/api/media/extract-audio",
    requireFfmpeg,
    withWorkDir,
    receive(upload.single("video")),
    workRoute(async (req, res): Promise<any> => {
      const input = req.file?.path;
      if (!input) return res.status(400).json({ error: "No video was uploaded." });
      const signal = req.signal;
      const output = path.join(req.workDir!, "audio.wav");

      let info: MediaInfo;
      try {
        info = await probeMedia(input, { signal });
        if (req.clientGone) return;
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

        await ffmpeg(
          [
            ...only(VIDEO_FORMATS),
            "-i", input,
            "-map", "0:a:0",
            "-vn", "-sn", "-dn",
            // Pads (or trims) the start so sample 0 of the WAV is time 0 of the
            // video, and fills any hole in the sound with silence. Without it, a
            // sound track that starts a little after the picture would put every
            // subtitle that much early. The subtitled render plays the sound
            // through the same filter, so the two stay in step.
            "-af", "aresample=async=1:first_pts=0",
            "-ac", "1",
            "-ar", "48000",
            "-c:a", "pcm_s16le",
            "-loglevel", "error",
            "-y", output,
          ],
          { signal }
        );
      } catch (err: any) {
        // A cancel: nobody is waiting for an answer.
        if (req.clientGone || isAborted(err)) return;
        console.error("Audio extraction failed:", err?.stderr || err);
        return res.status(500).json({ error: "Could not pull the sound out of this video. Is the file complete?" });
      }
      if (req.clientGone) return;

      res.setHeader("X-Media-Width", String(info.width));
      res.setHeader("X-Media-Height", String(info.height));
      res.setHeader("X-Media-Duration", info.durationSeconds.toFixed(3));
      res.setHeader("Content-Type", "audio/wav");
      return res.sendFile(output, (err) => {
        if (!err || req.clientGone) return;
        console.error("Sending the extracted sound failed:", err.message);
        if (!res.headersSent) res.status(500).json({ error: "Could not send the sound back." });
      });
    })
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
      job.stop?.();
    }
    res.json({ ok: true });
  });

  app.post(
    "/api/render/subtitled",
    requireFfmpeg,
    withWorkDir,
    // Registered before the upload, so a cancel that arrives mid-upload counts.
    (req: WorkRequest, _res: Response, next: NextFunction) => {
      req.job = { stage: "uploading", fraction: 0, touchedAt: Date.now(), stop: req.stop };
      jobs.set(jobId(req) || `s${Date.now().toString(36)}`, req.job);
      next();
    },
    receive(
      upload.fields([
        { name: "video", maxCount: 1 },
        { name: "cue", maxCount: MAX_CUES },
        { name: "overlay", maxCount: 1 },
        { name: "audio", maxCount: 1 },
      ]),
      (req) => {
        const job = (req as WorkRequest).job;
        if (job) job.stage = "failed";
      }
    ),
    workRoute(async (req, res): Promise<any> => {
      const job = req.job!;
      job.stage = "preparing";
      job.touchedAt = Date.now();
      const signal = req.signal;
      const stopped = () => Boolean(job.cancelled || req.clientGone || signal?.aborted);
      const fail = (status: number, error: string) => {
        job.stage = "failed";
        // The browser may already have gone (cancelled); nobody to tell.
        if (req.clientGone || res.headersSent) return;
        return res.status(status).json({ error });
      };
      const cancelled = () => fail(499, "The render was cancelled.");

      // Everything from here runs in one try: a failure anywhere is an answer
      // to this request, never an exception loose in the server.
      try {
        if (stopped()) return cancelled();
        const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
        const video = files.video?.[0];
        if (!video) return fail(400, "No video was uploaded.");

        const W = even(intParam(req.body?.width, 1080));
        const H = even(intParam(req.body?.height, Math.round((W * 16) / 9)));
        if (W < 240 || W > 4096 || H < 240 || H > 4096) return fail(400, `Unsupported output size ${W}x${H}.`);
        const fit = req.body?.fit === "crop" ? "crop" : "blur";

        const info = await probeMedia(video.path, { signal });
        if (stopped()) return cancelled();
        if (!info.hasVideo) return fail(400, "The uploaded file has no picture, or is not a video this app can read.");
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
        const inputs: string[] = [...only(VIDEO_FORMATS), "-i", video.path];
        let cuePlace: { x: number; y: number } | null = null;
        let logoPlace: { x: number; y: number } | null = null;

        if (cues.length) {
          // The concat demuxer needs every image in the stream to be one size,
          // and the blank for the gaps is made at that size. Checked here so a
          // bad image is a clear answer rather than an ffmpeg failure (a 0×0
          // header) or an enormous allocation.
          const sizes = cues.map((c) => pngSize(path.join(dir, c.file)));
          const size = sizes[0];
          if (!size || sizes.some((s) => !s || s.width !== size.width || s.height !== size.height)) {
            return fail(400, "The subtitle images must be PNG files, all the same size.");
          }
          if (size.width < 2 || size.height < 2 || size.width > W || size.height > H) {
            return fail(400, `The subtitle images (${size.width}x${size.height}) do not fit the ${W}x${H} frame.`);
          }
          const blank = "blank.png";
          await ffmpeg(
            [
              "-f", "lavfi", "-i", `color=c=black@0.0:s=${size.width}x${size.height},format=rgba`,
              "-frames:v", "1", "-loglevel", "error", "-y", path.join(dir, blank),
            ],
            { signal }
          );
          if (stopped()) return cancelled();
          const listPath = path.join(dir, "cues.ffconcat");
          fs.writeFileSync(listPath, concatList(cues, blank, duration || cues[cues.length - 1].end));
          // -safe 0 only so the list may use `option`; every name in it is ours,
          // and the format list holds whatever it names to PNG.
          inputs.push("-f", "concat", "-safe", "0", ...only(CUE_LIST_FORMATS), "-i", listPath);
          cuePlace = { x: even(intParam(req.body?.cueX, 0)), y: even(intParam(req.body?.cueY, 0)) };
        }

        const overlay = files.overlay?.[0];
        if (overlay) {
          const size = pngSize(overlay.path);
          if (!size || size.width < 1 || size.height < 1 || size.width > W || size.height > H) {
            return fail(400, "The logo image must be a PNG that fits the frame.");
          }
          inputs.push(...only(PNG_FORMATS), "-i", overlay.path);
          logoPlace = { x: even(intParam(req.body?.overlayX, 0)), y: even(intParam(req.body?.overlayY, 0)) };
        }
        const toneMapping = isHdr(info.colour) && (await hasToneMapping());
        let graph = subtitleGraph({ fit, source: info, width: W, height: H, cues: cuePlace, overlay: logoPlace, toneMapping });

        const audio = files.audio?.[0];
        let audioMap: string[];
        if (audio) {
          // Inputs so far: the video, then the cue stream and the logo when present.
          const index = 1 + (cuePlace ? 1 : 0) + (logoPlace ? 1 : 0);
          audioMap = ["-map", `${index}:a:0`];
          inputs.push(...only(WAV_FORMATS), "-i", audio.path);
        } else if (info.hasAudio) {
          // The video's own sound, through the filter extract-audio used for
          // the WAV the subtitles were timed on: a late start is padded and a
          // hole filled with silence, so the sound stays where the subtitles
          // (and, after a title card is joined on, the picture) expect it.
          graph += ";[0:a:0]aresample=async=1:first_pts=0[aout]";
          audioMap = ["-map", "[aout]"];
        } else {
          // Optional: a video without sound still renders.
          audioMap = [];
        }

        const output = path.join(dir, "subtitled.mp4");
        const args = [
          ...inputs,
          "-filter_complex", graph,
          "-map", "[vout]",
          ...audioMap,
          "-c:v", "libx264",
          "-preset", "veryfast",
          "-crf", "20",
          "-pix_fmt", "yuv420p",
          ...BT709_OUTPUT,
          ...(audioMap.length ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"] : []),
          // The source decides the length; a replacement track a few samples
          // longer must not add a frozen frame at the end.
          ...(duration > 0 ? ["-t", duration.toFixed(3)] : ["-shortest"]),
          "-movflags", "+faststart",
          "-loglevel", "error",
          "-y", output,
        ];

        if (stopped()) return cancelled();
        const started = Date.now();
        job.stage = "encoding";
        job.touchedAt = Date.now();
        await runWithProgress(args, duration, signal, (fraction) => {
          job.fraction = fraction;
          job.touchedAt = Date.now();
        });
        if (stopped()) return cancelled();
        job.stage = "done";
        job.fraction = 1;
        console.log(`Subtitled ${duration.toFixed(1)}s video with ${cues.length} cues in ${Date.now() - started}ms`);
        return res.download(output, "subtitled.mp4", (err) => {
          if (!err || req.clientGone) return;
          console.error("Sending the subtitled video failed:", err.message);
          if (!res.headersSent) res.status(500).json({ error: "Could not send the finished video." });
        });
      } catch (err: any) {
        if (stopped() || isAborted(err)) return cancelled();
        console.error("Subtitled render failed:", err?.message || err);
        return fail(500, "ffmpeg could not make the subtitled video. " + errorTail(err));
      }
    })
  );
}
