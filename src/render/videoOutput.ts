/**
 * Playing and exporting any prepared video — lesson, dialogue or story.
 *
 *   drawStill     — a single frame, for the look picker
 *   startPreview  — plays in the page in real time, with sound
 *   renderVideo   — draws every frame as fast as the machine allows, ships them
 *                   to the server in batches, and lets ffmpeg mux them against
 *                   an offline mixdown of the voice clips (as in Reels Creator)
 */

import { mixdown, encodeWav } from "./audioMixdown";
import { createFrameEncoder } from "./frameEncoderPool";
import { audioContext } from "../audio/audioTools";
import { FPS } from "./frameKit";
import type { PreparedLesson } from "./renderLesson";

/* ------------------------------------------------------------------ */
/* Still frame and live preview                                          */
/* ------------------------------------------------------------------ */

/** Paints one frame onto a canvas, sizing the canvas to the lesson. */
export function drawStill(prepared: PreparedLesson, canvas: HTMLCanvasElement, at: number) {
  canvas.width = prepared.width;
  canvas.height = prepared.height;
  const ctx = canvas.getContext("2d");
  if (ctx) prepared.draw(ctx, at, 0.35);
}

/** A moment worth showing as a thumbnail: halfway through the first play. */
export function stillMoment(prepared: PreparedLesson): number {
  const play = prepared.timeline.events.find((e) => e.type === "play");
  return play ? play.start + (play.end - play.start) * 0.6 : 0;
}

export interface PreviewHandle {
  stop: () => void;
  done: Promise<void>;
}

/** Plays the lesson in the page, with sound, from `from` seconds. */
export function startPreview(
  prepared: PreparedLesson,
  canvas: HTMLCanvasElement,
  onTime?: (t: number) => void,
  from = 0
): PreviewHandle {
  const ctx = audioContext();
  canvas.width = prepared.width;
  canvas.height = prepared.height;
  const g = canvas.getContext("2d")!;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.7;
  analyser.connect(ctx.destination);
  const bins = new Uint8Array(analyser.fftSize);

  const sources: AudioBufferSourceNode[] = [];
  let running = true;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => (resolveDone = r));

  const begin = async () => {
    if (ctx.state === "suspended") await ctx.resume();
    const base = ctx.currentTime + 0.08;
    for (const clip of prepared.clips) {
      const clipEnd = clip.at + clip.buffer.duration;
      if (clipEnd <= from) continue;
      const source = ctx.createBufferSource();
      source.buffer = clip.buffer;
      source.connect(analyser);
      const offset = Math.max(0, from - clip.at);
      source.start(base + Math.max(0, clip.at - from), offset);
      sources.push(source);
    }

    const frame = () => {
      if (!running) return;
      const t = from + Math.max(0, ctx.currentTime - base);
      analyser.getByteTimeDomainData(bins);
      let sum = 0;
      for (let i = 0; i < bins.length; i++) {
        const v = (bins[i] - 128) / 128;
        sum += v * v;
      }
      const level = Math.min(1, Math.sqrt(sum / bins.length) * 3.2);
      prepared.draw(g, t, level);
      onTime?.(t);
      if (t >= prepared.timeline.total) {
        stop();
        return;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };

  const stop = () => {
    if (!running) return;
    running = false;
    for (const s of sources) {
      try {
        s.stop();
      } catch {
        /* never started */
      }
    }
    analyser.disconnect();
    resolveDone();
  };

  void begin();
  return { stop, done };
}

/* ------------------------------------------------------------------ */
/* The MP4                                                              */
/* ------------------------------------------------------------------ */

/** Frames per upload: small enough to bound memory, large enough to be cheap. */
const FRAME_BATCH = 45;
/**
 * Intermediate JPEG quality. ffmpeg re-encodes to H.264 at CRF 20, so these
 * only need to be visually lossless going in; 0.85 is about half the bytes and
 * time of 0.92 with no visible difference afterwards (measured in Reels Creator).
 */
const FRAME_QUALITY = 0.85;

export interface RenderResult {
  blob: Blob;
  durationSeconds: number;
  /** Frames produced per second of wall-clock time. */
  speed: number;
}

export async function renderVideo(
  prepared: PreparedLesson,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal
): Promise<RenderResult> {
  const { width, height, timeline, clips, draw } = prepared;
  const started = performance.now();
  // A short tail so the last frame is not cut on the final syllable.
  const duration = timeline.total + 0.4;

  // Mix first: cheap, and a failure here should not waste a render.
  const mixed = await mixdown(clips, duration);
  const wav = encodeWav(mixed);

  const totalFrames = Math.max(1, Math.ceil(duration * FPS));
  const channel = mixed.getChannelData(0);
  const perFrame = Math.floor(mixed.sampleRate / FPS);
  const levels = new Float32Array(totalFrames);
  for (let f = 0; f < totalFrames; f++) {
    const from = f * perFrame;
    const to = Math.min(channel.length, from + perFrame);
    let sum = 0;
    for (let i = from; i < to; i += 8) sum += channel[i] * channel[i];
    levels[f] = Math.min(1, Math.sqrt(sum / Math.max(1, Math.ceil((to - from) / 8))) * 3.2);
  }

  // A detached, CPU-backed canvas: reading every frame back off a page canvas
  // costs twice as much (measured in Reels Creator).
  const surface = document.createElement("canvas");
  surface.width = width;
  surface.height = height;
  const ctx = surface.getContext("2d", { alpha: false, willReadFrequently: true }) as CanvasRenderingContext2D;

  const startRes = await fetch("/api/render/start", { method: "POST" });
  if (!startRes.ok) {
    const detail = await startRes.json().catch(() => ({}));
    throw new Error(detail.error || "Could not start a render on the server.");
  }
  const { sessionId } = await startRes.json();
  const encoder = createFrameEncoder(FRAME_QUALITY);

  try {
    let batch: Blob[] = [];
    let batchStart = 0;
    const inFlight: Promise<void>[] = [];

    const send = (frames: Blob[], startIndex: number) => {
      const form = new FormData();
      form.append("sessionId", sessionId);
      form.append("startIndex", String(startIndex));
      frames.forEach((blob, i) => form.append("frames", blob, `f${startIndex + i}.jpg`));
      return fetch("/api/render/frames", { method: "POST", body: form }).then(async (res) => {
        if (!res.ok) {
          const detail = await res.json().catch(() => ({}));
          throw new Error(detail.error || "Uploading frames failed.");
        }
      });
    };

    const flush = async () => {
      if (!batch.length) return;
      const pending = send(batch, batchStart);
      batchStart += batch.length;
      batch = [];
      inFlight.push(pending);
      pending.catch(() => {});
      if (inFlight.length >= 2) await inFlight.shift();
    };

    // Budget a fixed amount of bitmap memory in flight — the measured optimum
    // in Reels Creator was 3 to 4 frames.
    const maxAhead = Math.max(3, Math.min(4, Math.floor(48_000_000 / (width * height * 4))));
    const encoding: Array<Promise<{ index: number; blob: Blob }>> = [];
    const finished: Blob[] = [];
    let next = 0;

    const collectOne = async () => {
      const settled = await Promise.race(encoding.map((p, i) => p.then((v) => ({ v, i }))));
      encoding.splice(settled.i, 1);
      finished[settled.v.index] = settled.v.blob;
    };

    while (next < totalFrames || encoding.length) {
      if (signal?.aborted) throw new DOMException("The render was cancelled.", "AbortError");
      while (next < totalFrames && encoding.length < maxAhead) {
        const index = next++;
        draw(ctx, index / FPS, levels[index]);
        const bitmap = await createImageBitmap(surface);
        encoding.push(encoder.encode(index, bitmap).then((blob) => ({ index, blob })));
      }
      if (encoding.length) await collectOne();
      while (finished[batchStart + batch.length]) {
        batch.push(finished[batchStart + batch.length]);
        delete finished[batchStart + batch.length - 1];
        if (batch.length >= FRAME_BATCH) await flush();
      }
      onProgress?.((Math.min(next, totalFrames) / totalFrames) * 0.92);
    }

    await flush();
    await Promise.all(inFlight);

    const finish = new FormData();
    finish.append("sessionId", sessionId);
    finish.append("audio", wav, "audio.wav");
    finish.append("fps", String(FPS));
    const muxed = await fetch("/api/render/finish", { method: "POST", body: finish });
    if (!muxed.ok) {
      const detail = await muxed.json().catch(() => ({}));
      throw new Error(detail.error || "Assembling the MP4 failed on the server.");
    }
    const blob = await muxed.blob();
    onProgress?.(1);

    const wall = (performance.now() - started) / 1000;
    return { blob, durationSeconds: timeline.total, speed: totalFrames / FPS / Math.max(0.001, wall) };
  } catch (err) {
    void fetch("/api/render/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {});
    throw err;
  } finally {
    encoder.destroy();
  }
}
