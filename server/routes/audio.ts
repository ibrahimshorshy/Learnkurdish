/**
 * Audio clean-up: noise removal, tone and room presets, run through ffmpeg.
 *
 *   POST /api/audio/process   multipart: audio (16-bit PCM WAV, as the
 *                             browser encodes it), preset (config/audioPresets
 *                             id), room (1/0)
 *                             → WAV, 48kHz mono 16-bit, the same length
 *
 * Only WAV is taken, and ffmpeg is told so (-f wav). Left to guess the format
 * from the content, ffmpeg would follow a DASH manifest or a playlist to other
 * files on this computer and to URLs, and a few kilobytes of a compressed
 * format could decode to hours of audio. The header is checked here first, so
 * the length of the work is known before any of it starts.
 *
 * The line times index into this audio, so the one thing this must never do
 * is move the voice in time or change the length. Three safeguards:
 *
 *   1. Latency is measured, not assumed. The FFT denoiser hands the signal
 *      back late (25ms at 48kHz in ffmpeg 6) and keeps the length, which
 *      silently drops the last 25ms. Each chain is run once on a test signal,
 *      its delay found by cross-correlation, and every real run pads the end
 *      by that much before the chain and drops it from the front after.
 *      Measured rather than hard-coded because the denoiser has been rewritten
 *      between ffmpeg versions and people run whatever their package manager
 *      gave them.
 *   2. The output is pinned to the exact sample count of the input.
 *   3. The result is checked here before it is sent: wrong length is an error.
 *
 * Everything is processed as 32-bit float and only turned into 16-bit at the
 * very end, after a peak check, so an EQ boost cannot clip. The browser levels
 * the result again anyway.
 */

import type { Express, NextFunction, Request, Response } from "express";
import multer from "multer";
import fs from "fs";
import os from "os";
import path from "path";
import { FFMPEG_MISSING, ToolAborted, abortOnClose, ffmpeg, hasFfmpeg, isAborted } from "../ffmpeg";
import { errorResponse, withoutPaths } from "../security";
import { isAudioPresetId, presetGraph } from "../../src/config/audioPresets";
import type { AudioPresetId } from "../../src/types";

export const PROCESS_RATE = 48000;

/**
 * Longest recording that is cleaned up. Video projects can run long, so well
 * past three hours; beyond this the browser struggles with the recording
 * anyway, and the teacher can still use it as recorded (Raw).
 */
export const MAX_AUDIO_SECONDS = 4 * 60 * 60;

/**
 * A WAV's sizes are 32-bit, so no WAV is larger than this. The duration in the
 * header is the real limit; this only stops a body that is not a WAV at all
 * from filling the disk.
 */
const MAX_UPLOAD_BYTES = 0xffffffff + 8;

const audioUpload = multer({
  dest: os.tmpdir(),
  // One file and two short fields (preset, room) are all the app sends.
  limits: { files: 1, fileSize: MAX_UPLOAD_BYTES, fields: 8, fieldSize: 1024, parts: 10 },
});

/* ------------------------------------------------------------------ */
/* WAV in and out                                                       */
/* ------------------------------------------------------------------ */

export interface WavData {
  sampleRate: number;
  channels: number;
  /** First channel only; everything here is mono. */
  samples: Float32Array;
}

/** Reads a PCM 16-bit or float 32-bit WAV, walking the chunks (ffmpeg may add a LIST chunk). */
export function readWav(buffer: Buffer): WavData {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file.");
  }
  let offset = 12;
  let format = 0;
  let channels = 1;
  let sampleRate = 0;
  let bits = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    let size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = buffer.readUInt16LE(body);
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bits = buffer.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in its sub-format GUID.
      if (format === 0xfffe && size >= 26) format = buffer.readUInt16LE(body + 24);
    } else if (id === "data") {
      // A streamed WAV may say 0 or 0xFFFFFFFF; the rest of the file is the data.
      if (size === 0 || body + size > buffer.length) size = buffer.length - body;
      const frameBytes = (bits / 8) * channels;
      if (!frameBytes || !sampleRate) throw new Error("WAV has no usable format chunk.");
      const frames = Math.floor(size / frameBytes);
      const samples = new Float32Array(frames);
      if (format === 3 && bits === 32) {
        for (let i = 0; i < frames; i++) samples[i] = buffer.readFloatLE(body + i * frameBytes);
      } else if (format === 1 && bits === 16) {
        for (let i = 0; i < frames; i++) samples[i] = buffer.readInt16LE(body + i * frameBytes) / 32768;
      } else {
        throw new Error(`Unsupported WAV encoding (format ${format}, ${bits}-bit).`);
      }
      return { sampleRate, channels, samples };
    }
    offset = body + size + (size & 1);
  }
  throw new Error("WAV has no data chunk.");
}

/** The 44-byte header of a 16-bit PCM mono WAV of `samples` samples. */
function wav16Header(samples: number, sampleRate: number): Buffer {
  const dataSize = samples * 2;
  const out = Buffer.alloc(44);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataSize, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataSize, 40);
  return out;
}

/** 16-bit PCM mono WAV. */
export function writeWav16(samples: Float32Array, sampleRate: number): Buffer {
  const out = Buffer.alloc(44 + samples.length * 2);
  wav16Header(samples.length, sampleRate).copy(out, 0);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return out;
}

/** 32-bit float mono WAV, for the calibration signal. */
function writeWavFloat(samples: Float32Array, sampleRate: number): Buffer {
  const dataSize = samples.length * 4;
  const out = Buffer.alloc(44 + dataSize);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataSize, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(3, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 4, 28);
  out.writeUInt16LE(4, 32);
  out.writeUInt16LE(32, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) out.writeFloatLE(samples[i], 44 + i * 4);
  return out;
}

/* ------------------------------------------------------------------ */
/* Measuring a chain's delay                                            */
/* ------------------------------------------------------------------ */

const CALIBRATION_SECONDS = 1.2;
/** Where the voice-like bursts sit in the calibration signal. */
const CALIBRATION_BURSTS = [0.2, 0.47, 0.71];
/** Longest delay looked for. Far beyond anything a sane chain should add. */
const MAX_LATENCY = Math.round(0.25 * PROCESS_RATE);

/**
 * A signal the denoiser treats like a voice: a little steady noise to learn,
 * and three short harmonic bursts with soft edges.
 */
function calibrationSignal(): Float32Array {
  const rate = PROCESS_RATE;
  const out = new Float32Array(Math.round(CALIBRATION_SECONDS * rate));
  let seed = 11;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (seed / 0x7fffffff - 0.5) * 0.006;
  }
  const length = Math.round(0.08 * rate);
  CALIBRATION_BURSTS.forEach((at, b) => {
    const from = Math.round(at * rate);
    const f0 = 140 + b * 35;
    for (let k = 0; k < length && from + k < out.length; k++) {
      const env = Math.sin((Math.PI * k) / length) ** 2;
      let v = 0;
      for (let h = 1; h <= 12; h++) v += Math.sin((2 * Math.PI * f0 * h * k) / rate) / h;
      out[from + k] += 0.35 * env * v;
    }
  });
  return out;
}

/**
 * The lag, in samples, at which `output` best matches `input`, looked for
 * around the bursts only. Coarse first on 1ms frames, then sample-exact.
 */
export function measureLag(input: Float32Array, output: Float32Array, maxLag = MAX_LATENCY): number {
  const rate = PROCESS_RATE;
  const half = Math.round(0.06 * rate);
  const windows = CALIBRATION_BURSTS.map((t) => {
    const centre = Math.round((t + 0.04) * rate);
    return { from: Math.max(0, centre - half), to: Math.min(input.length, centre + half) };
  });
  const score = (lag: number, stride: number) => {
    let sum = 0;
    for (const w of windows) {
      for (let i = w.from; i < w.to; i += stride) {
        const j = i + lag;
        if (j >= 0 && j < output.length) sum += input[i] * output[j];
      }
    }
    return sum;
  };
  let best = 0;
  let bestScore = -Infinity;
  const coarse = Math.round(rate / 1000);
  for (let lag = -coarse * 4; lag <= maxLag; lag += coarse) {
    const s = score(lag, 4);
    if (s > bestScore) {
      bestScore = s;
      best = lag;
    }
  }
  const centre = best;
  bestScore = -Infinity;
  for (let lag = centre - coarse * 2; lag <= centre + coarse * 2; lag++) {
    const s = score(lag, 1);
    if (s > bestScore) {
      bestScore = s;
      best = lag;
    }
  }
  return best;
}

const latencyCache = new Map<string, Promise<number>>();

/**
 * How many samples late `graph` returns the signal at 48kHz. Measured once per
 * chain per server run.
 */
export function chainLatency(graph: string): Promise<number> {
  if (!graph) return Promise.resolve(0);
  let pending = latencyCache.get(graph);
  if (!pending) {
    pending = (async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leen-ku-cal-"));
      try {
        const input = calibrationSignal();
        const inPath = path.join(dir, "in.wav");
        const outPath = path.join(dir, "out.wav");
        fs.writeFileSync(inPath, writeWavFloat(input, PROCESS_RATE));
        await ffmpeg([
          "-nostdin",
          "-y",
          "-f",
          "wav",
          "-i",
          inPath,
          "-af",
          `aformat=sample_fmts=fltp:channel_layouts=mono,${graph}`,
          "-ac",
          "1",
          "-ar",
          String(PROCESS_RATE),
          "-c:a",
          "pcm_f32le",
          outPath,
        ]);
        const output = readWav(fs.readFileSync(outPath)).samples;
        // Small negative readings are the phase of the EQ, not a real advance.
        return Math.max(0, measureLag(input, output));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    })();
    pending.catch(() => latencyCache.delete(graph));
    latencyCache.set(graph, pending);
  }
  return pending;
}

/* ------------------------------------------------------------------ */
/* The upload                                                           */
/* ------------------------------------------------------------------ */

/** A refusal of the upload itself, with the status to answer it with. */
export class AudioInputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "AudioInputError";
  }
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  /** Sample frames in the data, counted the way ffmpeg will read them. */
  frames: number;
  seconds: number;
}

function hoursAndMinutes(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m} minutes`;
}

/**
 * Checks the uploaded WAV's header without loading the file: 16-bit PCM, mono
 * or stereo, a real sample rate, and no longer than MAX_AUDIO_SECONDS. What
 * passes is exactly what the browser sends; anything else never reaches ffmpeg.
 */
export async function inspectWav(filePath: string): Promise<WavInfo> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const fileSize = (await handle.stat()).size;
    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    };

    const riff = await read(0, 12);
    if (riff.length < 12 || riff.toString("ascii", 0, 4) !== "RIFF" || riff.toString("ascii", 8, 12) !== "WAVE") {
      throw new AudioInputError("Clean-up takes the WAV audio the app sends, and this file is not one.", 415);
    }

    let fmt: { format: number; channels: number; sampleRate: number; blockAlign: number; bits: number } | null = null;
    let offset = 12;
    // The app writes fmt and then data; a few other chunks before them are fine.
    for (let chunk = 0; chunk < 32 && offset + 8 <= fileSize; chunk++) {
      const header = await read(offset, 8);
      const id = header.toString("ascii", 0, 4);
      const size = header.readUInt32LE(4);
      const body = offset + 8;
      if (id === "fmt ") {
        const f = await read(body, Math.min(size, 40));
        if (size < 16 || f.length < 16) throw new AudioInputError("The WAV's format chunk is damaged.", 415);
        let format = f.readUInt16LE(0);
        // WAVE_FORMAT_EXTENSIBLE keeps the real format in its sub-format GUID.
        if (format === 0xfffe && f.length >= 26) format = f.readUInt16LE(24);
        fmt = {
          format,
          channels: f.readUInt16LE(2),
          sampleRate: f.readUInt32LE(4),
          blockAlign: f.readUInt16LE(12),
          bits: f.readUInt16LE(14),
        };
      } else if (id === "data") {
        if (!fmt) throw new AudioInputError("The WAV has no format chunk before its audio.", 415);
        const { format, channels, sampleRate, blockAlign, bits } = fmt;
        if (
          format !== 1 ||
          bits !== 16 ||
          channels < 1 ||
          channels > 2 ||
          blockAlign !== channels * 2 ||
          sampleRate < 8000 ||
          sampleRate > 192000
        ) {
          throw new AudioInputError(
            `Clean-up takes 16-bit PCM WAV (mono or stereo, 8–192kHz). This one is format ${format}, ` +
              `${bits}-bit, ${channels} channel(s) at ${sampleRate}Hz.`,
            415
          );
        }
        // Counted as ffmpeg reads it: a streamed WAV says 0 or 0xFFFFFFFF and
        // the rest of the file is audio; a cut-off one has only what is there.
        const available = Math.max(0, fileSize - body);
        const bytes = size === 0 || size === 0xffffffff ? available : Math.min(size, available);
        const frames = Math.floor(bytes / blockAlign);
        if (!frames) throw new AudioInputError("The audio is empty.");
        const seconds = frames / sampleRate;
        if (seconds > MAX_AUDIO_SECONDS) {
          throw new AudioInputError(
            `This recording is ${hoursAndMinutes(seconds)} long. Clean-up works on up to ${hoursAndMinutes(MAX_AUDIO_SECONDS)}; ` +
              `choose Raw to use it as recorded.`,
            413
          );
        }
        return { sampleRate, channels, frames, seconds };
      }
      offset = body + size + (size & 1);
    }
    throw new AudioInputError("The WAV has no audio in it.", 415);
  } finally {
    await handle.close();
  }
}

/* ------------------------------------------------------------------ */
/* Processing                                                           */
/* ------------------------------------------------------------------ */

/**
 * The whole -af graph: into the working format, the preset with its delay
 * taken out, and the length pinned.
 */
export function timingSafeGraph(graph: string, latency: number, totalSamples: number): string {
  // 48kHz mono float first, in one resampler (the same one -ar would add), so
  // every sample count after it is at 48kHz.
  const parts = [`aresample=${PROCESS_RATE}`, `aformat=sample_fmts=fltp:sample_rates=${PROCESS_RATE}:channel_layouts=mono`];
  if (graph) {
    if (latency > 0) {
      // Room at the end for the samples the chain holds back, then drop the
      // same number from the front: the voice lands where it was.
      parts.push(`apad=pad_len=${latency}`, graph, `atrim=start_sample=${latency}`, "asetpts=PTS-STARTPTS");
    } else {
      parts.push(graph);
    }
  }
  parts.push(`apad=whole_len=${totalSamples}`, `atrim=end_sample=${totalSamples}`);
  return parts.join(",");
}

export interface CleanedAudio {
  /** Raw 32-bit float, 48kHz mono, exactly `samples` long. */
  floatPath: string;
  samples: number;
  latency: number;
  /** Applied on the way to 16-bit: below 1 only when the loudest sample would clip. */
  scale: number;
}

export interface ProcessResult {
  wav: Buffer;
  samples: number;
  latency: number;
}

function stopIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new ToolAborted("Audio clean-up");
}

/** 4MB: a million samples per read, so no stage of a long recording is ever whole in memory. */
const BLOCK_BYTES = 4 * 1024 * 1024;

/** A raw float file, a block at a time. Each block is only valid until the next is asked for. */
async function* floatBlocks(floatPath: string, signal?: AbortSignal): AsyncGenerator<DataView> {
  const handle = await fs.promises.open(floatPath, "r");
  try {
    const buffer = Buffer.alloc(BLOCK_BYTES);
    let position = 0;
    for (;;) {
      stopIfAborted(signal);
      let filled = 0;
      while (filled < BLOCK_BYTES) {
        const { bytesRead } = await handle.read(buffer, filled, BLOCK_BYTES - filled, position + filled);
        if (!bytesRead) break;
        filled += bytesRead;
      }
      position += filled;
      const whole = filled - (filled % 4);
      if (whole) yield new DataView(buffer.buffer, buffer.byteOffset, whole);
      if (filled < BLOCK_BYTES) return;
    }
  } finally {
    await handle.close();
  }
}

/**
 * Cleans one recording that inspectWav has passed, in a single ffmpeg pass
 * straight from the upload, into a raw float file of exactly the right
 * length. Stops (rejecting with ToolAborted) as soon as `signal` fires.
 */
export async function cleanAudio(
  inputPath: string,
  info: WavInfo,
  preset: AudioPresetId,
  room: boolean,
  workDir: string,
  signal?: AbortSignal
): Promise<CleanedAudio> {
  // The length the result must have: the recording's own, at 48kHz.
  const total = Math.round((info.frames * PROCESS_RATE) / info.sampleRate);
  const graph = presetGraph(preset, room);
  const latency = graph ? await chainLatency(graph) : 0;
  stopIfAborted(signal);

  const floatPath = path.join(workDir, "out.f32");
  await ffmpeg(
    [
      "-nostdin",
      "-y",
      // WAV and plain PCM only, whatever the bytes look like (see the top of this file).
      "-f",
      "wav",
      "-c:a",
      "pcm_s16le",
      // inspectWav has already refused anything longer; this is a second fence.
      "-t",
      String(MAX_AUDIO_SECONDS + 1),
      "-i",
      inputPath,
      "-map",
      "0:a:0",
      "-af",
      timingSafeGraph(graph, latency, total),
      "-ac",
      "1",
      "-ar",
      String(PROCESS_RATE),
      // Float out, so nothing clips before the peak check below.
      "-c:a",
      "pcm_f32le",
      "-f",
      "f32le",
      floatPath,
    ],
    { signal }
  );

  // Checked here, before anything is sent: wrong length is an error.
  const bytes = (await fs.promises.stat(floatPath)).size;
  if (bytes !== total * 4) {
    throw new Error(`Clean-up changed the length (${Math.floor(bytes / 4)} samples instead of ${total}).`);
  }

  let peak = 0;
  for await (const block of floatBlocks(floatPath, signal)) {
    for (let i = 0; i < block.byteLength; i += 4) {
      const a = Math.abs(block.getFloat32(i, true));
      if (a > peak) peak = a;
    }
  }
  stopIfAborted(signal);
  // Keep the peaks inside 16-bit.
  return { floatPath, samples: total, latency, scale: peak > 0.98 ? 0.98 / peak : 1 };
}

/** The cleaned audio as a 16-bit WAV, header first, then a block at a time. */
export async function* wav16Chunks(cleaned: CleanedAudio, signal?: AbortSignal): AsyncGenerator<Buffer> {
  yield wav16Header(cleaned.samples, PROCESS_RATE);
  for await (const block of floatBlocks(cleaned.floatPath, signal)) {
    const count = block.byteLength / 4;
    const out = Buffer.allocUnsafe(count * 2);
    const view = new DataView(out.buffer, out.byteOffset, out.length);
    for (let i = 0; i < count; i++) {
      const s = Math.max(-1, Math.min(1, block.getFloat32(i * 4, true) * cleaned.scale));
      view.setInt16(i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
    }
    yield out;
  }
}

/**
 * Cleans one WAV file into a WAV in memory: 48kHz mono 16-bit, sample for
 * sample as long as the input. For the tests and short audio; the route
 * streams the same chunks instead of holding them.
 */
export async function processAudioFile(
  inputPath: string,
  preset: AudioPresetId,
  room: boolean,
  workDir: string,
  signal?: AbortSignal
): Promise<ProcessResult> {
  const info = await inspectWav(inputPath);
  const cleaned = await cleanAudio(inputPath, info, preset, room, workDir, signal);
  const parts: Buffer[] = [];
  for await (const chunk of wav16Chunks(cleaned, signal)) parts.push(chunk);
  return { wav: Buffer.concat(parts), samples: cleaned.samples, latency: cleaned.latency };
}

/* ------------------------------------------------------------------ */
/* The route                                                            */
/* ------------------------------------------------------------------ */

/** The upload, with its limits answered here as JSON the app can show. */
function receiveAudio(req: Request, res: Response, next: NextFunction) {
  audioUpload.single("audio")(req, res, (err?: any) => {
    if (!err) return next();
    if (res.headersSent || res.destroyed) return;
    const { status, error } = errorResponse(err);
    return res
      .status(status)
      .json({ error: err?.code === "LIMIT_FILE_SIZE" ? "The recording is too large to clean up." : error });
  });
}

/**
 * Fires when the app stops waiting for this request. abortOnClose only hears
 * a hang-up from now on, and the route starts only once the upload is saved:
 * a long recording takes seconds to write to disk, and the app may have
 * dropped the request meanwhile (a preset clicked straight after another).
 * That client has already gone, so its work never starts.
 */
export function cancelSignal(req: Request, res: Response): AbortSignal {
  if (res.destroyed || req.socket?.destroyed) return AbortSignal.abort();
  return abortOnClose(res);
}

/** Resolves once `res` can take more, or the request has gone. */
function drained(res: Response, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // A closed connection never drains: waiting for it would hold the handler,
    // and the work folder with it, for good.
    if (signal.aborted || res.destroyed) return resolve();
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
    signal.addEventListener("abort", done);
  });
}

export function registerAudioRoutes(app: Express) {
  app.post("/api/audio/process", receiveAudio, async (req, res): Promise<any> => {
    const uploaded = req.file?.path;
    // The app drops its request when the preset changes; the work for it stops with it.
    const signal = cancelSignal(req, res);
    let workDir: string | null = null;
    try {
      if (!uploaded) return res.status(400).json({ error: "No audio was sent." });
      if (!(await hasFfmpeg())) return res.status(503).json({ error: FFMPEG_MISSING });

      const preset = String(req.body?.preset || "clean");
      if (!isAudioPresetId(preset)) return res.status(400).json({ error: `Unknown clean-up preset “${preset.slice(0, 40)}”.` });
      const room = ["1", "true", "on", "yes"].includes(String(req.body?.room || "").toLowerCase());

      const info = await inspectWav(uploaded);
      stopIfAborted(signal);
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), "leen-ku-audio-"));
      const started = Date.now();
      const cleaned = await cleanAudio(uploaded, info, preset, room, workDir, signal);
      console.log(
        `Audio clean-up: ${preset}${room ? " + room" : ""}, ${(cleaned.samples / PROCESS_RATE).toFixed(1)}s, ` +
          `latency ${cleaned.latency} samples corrected, ${Date.now() - started}ms`
      );

      const length = 44 + cleaned.samples * 2;
      res.status(200);
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Content-Length", String(length));
      res.setHeader("X-Audio-Samples", String(cleaned.samples));
      res.setHeader("X-Audio-Rate", String(PROCESS_RATE));
      // Streamed: a long recording is never whole in memory here.
      let sent = 0;
      for await (const chunk of wav16Chunks(cleaned, signal)) {
        sent += chunk.length;
        if (sent >= length) {
          // The last of it. The client may hang up as soon as it has all it
          // was promised, so nothing after this waits on the connection: that
          // close is not a cancel.
          res.end(chunk);
          break;
        }
        if (!res.write(chunk)) await drained(res, signal);
        if (signal.aborted || res.destroyed) break;
      }
      if (sent < length) {
        stopIfAborted(signal);
        if (res.destroyed) throw new ToolAborted("Audio clean-up");
        throw new Error(`The cleaned audio came out short (${sent} of ${length} bytes).`);
      }
    } catch (err: any) {
      if (signal.aborted || isAborted(err)) {
        // Nothing more is sent: nobody is listening.
        console.log("Audio clean-up stopped: the app no longer wanted it.");
        return;
      }
      if (res.headersSent) {
        // Half sent: all that can be done is cut it off, and the app will see a short file.
        console.error("Audio clean-up failed while sending:", err?.message || err);
        res.destroy();
        return;
      }
      if (err instanceof AudioInputError) {
        console.warn(`Audio clean-up refused: ${err.message}`);
        return res.status(err.status).json({ error: err.message });
      }
      const detail = String(err?.stderr || err?.message || err)
        .trim()
        .split("\n")
        .slice(-4)
        .join("\n");
      console.error("Audio clean-up failed:", detail);
      if (/Invalid data found|could not find codec|does not contain any stream|Output file .* does not contain/i.test(detail)) {
        return res.status(400).json({ error: "This file could not be read as audio, so it was not cleaned up." });
      }
      // ffmpeg's own words, minus the temporary file paths that mean nothing to anyone.
      return res.status(500).json({ error: `Could not clean up the audio. ${withoutPaths(detail)}`.trim() });
    } finally {
      if (uploaded) fs.rmSync(uploaded, { force: true });
      if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
}
