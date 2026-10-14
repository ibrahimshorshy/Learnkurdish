/**
 * Audio clean-up: noise removal, tone and room presets, run through ffmpeg.
 *
 *   POST /api/audio/process   multipart: audio (any file ffmpeg reads),
 *                             preset (config/audioPresets id), room (1/0)
 *                             → WAV, 48kHz mono 16-bit, the same length
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

import type { Express } from "express";
import multer from "multer";
import fs from "fs";
import os from "os";
import path from "path";
import { FFMPEG_MISSING, ffmpeg, hasFfmpeg } from "../ffmpeg";
import { isAudioPresetId, presetGraph } from "../../src/config/audioPresets";
import type { AudioPresetId } from "../../src/types";

export const PROCESS_RATE = 48000;

const audioUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 1024 * 1024 * 1024 } });

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

/** 16-bit PCM mono WAV. */
export function writeWav16(samples: Float32Array, sampleRate: number): Buffer {
  const dataSize = samples.length * 2;
  const out = Buffer.alloc(44 + dataSize);
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
/* Processing                                                           */
/* ------------------------------------------------------------------ */

/** The whole -af graph: the preset, with its delay taken out and the length pinned. */
export function timingSafeGraph(graph: string, latency: number, totalSamples: number): string {
  const parts = ["aformat=sample_fmts=fltp:channel_layouts=mono"];
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

export interface ProcessResult {
  wav: Buffer;
  samples: number;
  latency: number;
}

/**
 * Cleans one file: any audio ffmpeg can read in, 48kHz mono 16-bit WAV out,
 * sample for sample as long as the input.
 */
export async function processAudioFile(
  inputPath: string,
  preset: AudioPresetId,
  room: boolean,
  workDir: string
): Promise<ProcessResult> {
  // 1. Decode whatever came in to the working format, so the sample count is known.
  const stagePath = path.join(workDir, "stage.wav");
  await ffmpeg([
    "-nostdin",
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(PROCESS_RATE),
    "-c:a",
    "pcm_f32le",
    stagePath,
  ]);
  const stage = readWav(fs.readFileSync(stagePath));
  const total = stage.samples.length;
  if (!total) throw new Error("The audio is empty.");

  // 2. The preset, timing-safe.
  const graph = presetGraph(preset, room);
  let processed = stage.samples;
  let latency = 0;
  if (graph) {
    latency = await chainLatency(graph);
    const outPath = path.join(workDir, "out.wav");
    await ffmpeg([
      "-nostdin",
      "-y",
      "-i",
      stagePath,
      "-af",
      timingSafeGraph(graph, latency, total),
      "-ac",
      "1",
      "-ar",
      String(PROCESS_RATE),
      "-c:a",
      "pcm_f32le",
      outPath,
    ]);
    processed = readWav(fs.readFileSync(outPath)).samples;
  }

  // 3. Check, then keep the peaks inside 16-bit.
  if (processed.length !== total) {
    throw new Error(`Clean-up changed the length (${processed.length} samples instead of ${total}).`);
  }
  let peak = 0;
  for (let i = 0; i < processed.length; i++) {
    const a = Math.abs(processed[i]);
    if (a > peak) peak = a;
  }
  if (peak > 0.98) {
    const scale = 0.98 / peak;
    for (let i = 0; i < processed.length; i++) processed[i] *= scale;
  }
  return { wav: writeWav16(processed, PROCESS_RATE), samples: total, latency };
}

export function registerAudioRoutes(app: Express) {
  app.post("/api/audio/process", audioUpload.single("audio"), async (req, res): Promise<any> => {
    const uploaded = req.file?.path;
    let workDir: string | null = null;
    try {
      if (!uploaded) return res.status(400).json({ error: "No audio was sent." });
      if (!(await hasFfmpeg())) return res.status(503).json({ error: FFMPEG_MISSING });

      const preset = String(req.body?.preset || "clean");
      if (!isAudioPresetId(preset)) return res.status(400).json({ error: `Unknown clean-up preset “${preset}”.` });
      const room = ["1", "true", "on", "yes"].includes(String(req.body?.room || "").toLowerCase());

      workDir = fs.mkdtempSync(path.join(os.tmpdir(), "leen-ku-audio-"));
      const started = Date.now();
      const result = await processAudioFile(uploaded, preset, room, workDir);
      console.log(
        `Audio clean-up: ${preset}${room ? " + room" : ""}, ${(result.samples / PROCESS_RATE).toFixed(1)}s, ` +
          `latency ${result.latency} samples corrected, ${Date.now() - started}ms`
      );
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("X-Audio-Samples", String(result.samples));
      res.setHeader("X-Audio-Rate", String(PROCESS_RATE));
      return res.send(result.wav);
    } catch (err: any) {
      const detail = String(err?.stderr || err?.message || err)
        .trim()
        .split("\n")
        .slice(-4)
        .join("\n");
      console.error("Audio clean-up failed:", detail);
      return res.status(500).json({ error: `Could not clean up the audio. ${detail}`.trim() });
    } finally {
      if (uploaded) fs.rmSync(uploaded, { force: true });
      if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
}
