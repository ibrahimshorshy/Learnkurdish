/**
 * Everything the browser does to the recording itself.
 *
 *   decode     — whatever the microphone or an uploaded file produced, into samples
 *   for the AI — 16kHz mono WAV: a format Gemini is documented to accept, and
 *                small (about 1.9MB a minute), which keeps the request inline
 *   for video  — one clip per line, cut out of the recording, levelled, with
 *                short fades so no cut clicks
 */

let sharedContext: AudioContext | null = null;

/** One AudioContext for the whole app; browsers cap how many may exist. */
export function audioContext(): AudioContext {
  if (!sharedContext) {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    sharedContext = new Ctor();
  }
  return sharedContext;
}

export async function decodeAudio(blob: Blob): Promise<AudioBuffer> {
  const bytes = await blob.arrayBuffer();
  try {
    return await audioContext().decodeAudioData(bytes.slice(0));
  } catch {
    throw new Error(
      "This file could not be read as audio. Try a WAV, MP3, M4A or WebM file — or record straight into the app."
    );
  }
}

/** Mixes every channel down to one. */
export function toMono(buffer: AudioBuffer): Float32Array {
  const out = new Float32Array(buffer.length);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) out[i] += data[i] / channels;
  }
  return out;
}

/** Resamples to a mono buffer at `rate` with the browser's own resampler. */
export async function resampleMono(buffer: AudioBuffer, rate: number): Promise<Float32Array> {
  const length = Math.max(1, Math.ceil(buffer.duration * rate));
  const offline = new OfflineAudioContext(1, length, rate);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

/** 16-bit PCM mono WAV. */
export function encodeWavMono(samples: Float32Array, sampleRate: number): Blob {
  const dataSize = samples.length * 2;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([out], { type: "audio/wav" });
}

/** The recording as the transcriber wants it. */
export async function wavForTranscription(buffer: AudioBuffer): Promise<Blob> {
  return encodeWavMono(await resampleMono(buffer, 16000), 16000);
}

/**
 * Gain that brings the recording's loud speech up to a consistent level.
 *
 * Measured on the 99.9th percentile of the absolute signal rather than the
 * single loudest sample, so one pop on the microphone does not hold the whole
 * recording down. Capped at +14dB so a near-silent recording is not turned
 * into amplified room noise.
 */
export function levellingGain(samples: Float32Array): number {
  if (!samples.length) return 1;
  const step = Math.max(1, Math.floor(samples.length / 200_000));
  const values: number[] = [];
  for (let i = 0; i < samples.length; i += step) values.push(Math.abs(samples[i]));
  values.sort((a, b) => a - b);
  const robustPeak = values[Math.min(values.length - 1, Math.floor(values.length * 0.999))] || 0;
  if (robustPeak < 1e-4) return 1;
  const target = 0.84; // about -1.5 dBFS
  return Math.min(5, Math.max(0.25, target / robustPeak));
}

/**
 * Cuts one line out of the recording as its own clip, levelled and faded.
 * Samples that would clip after the gain are soft-limited rather than squared
 * off.
 */
export function sliceClip(
  buffer: AudioBuffer,
  start: number,
  end: number,
  gain = 1,
  fadeSeconds = 0.015
): AudioBuffer {
  const rate = buffer.sampleRate;
  const from = Math.max(0, Math.floor(start * rate));
  const to = Math.min(buffer.length, Math.ceil(end * rate));
  const length = Math.max(1, to - from);
  const clip = new AudioBuffer({ length, numberOfChannels: buffer.numberOfChannels, sampleRate: rate });
  const fade = Math.min(Math.floor(fadeSeconds * rate), Math.floor(length / 2));

  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const dst = clip.getChannelData(c);
    for (let i = 0; i < length; i++) {
      let v = (src[from + i] || 0) * gain;
      if (v > 0.95 || v < -0.95) v = Math.tanh(v);
      if (i < fade) v *= i / fade;
      else if (i > length - 1 - fade) v *= (length - 1 - i) / fade;
      dst[i] = v;
    }
  }
  return clip;
}

/** Min/max per bucket, for drawing a waveform. */
export function waveformPeaks(samples: Float32Array, buckets: number): { min: Float32Array; max: Float32Array } {
  const count = Math.max(1, Math.floor(buckets));
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  const per = samples.length / count;
  for (let b = 0; b < count; b++) {
    const from = Math.floor(b * per);
    const to = Math.min(samples.length, Math.floor((b + 1) * per));
    let lo = 0;
    let hi = 0;
    const stride = Math.max(1, Math.floor((to - from) / 400));
    for (let i = from; i < to; i += stride) {
      const v = samples[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { min, max };
}

/* ------------------------------------------------------------------ */
/* Playback of a stretch of the recording                               */
/* ------------------------------------------------------------------ */

let playing: { source: AudioBufferSourceNode; onEnd?: () => void } | null = null;

export function stopPlayback() {
  if (!playing) return;
  const current = playing;
  playing = null;
  try {
    current.source.onended = null;
    current.source.stop();
  } catch {
    /* already stopped */
  }
  current.onEnd?.();
}

/** Plays [start, end) of a buffer. Stops whatever was playing first. */
export async function playRange(
  buffer: AudioBuffer,
  start: number,
  end: number,
  onEnd?: () => void,
  gain = 1
): Promise<void> {
  stopPlayback();
  const ctx = audioContext();
  if (ctx.state === "suspended") await ctx.resume();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const amp = ctx.createGain();
  amp.gain.value = gain;
  source.connect(amp).connect(ctx.destination);
  const entry = { source, onEnd };
  playing = entry;
  source.onended = () => {
    if (playing === entry) {
      playing = null;
      onEnd?.();
    }
  };
  source.start(0, Math.max(0, start), Math.max(0.01, end - start));
}

/** Seconds as m:ss.s */
export function formatTime(seconds: number, decimals = 1): string {
  const safe = Math.max(0, seconds || 0);
  const m = Math.floor(safe / 60);
  const s = safe - m * 60;
  const text = s.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, "0");
  return `${m}:${text}`;
}
