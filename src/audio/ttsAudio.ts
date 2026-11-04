/**
 * Card sound: turning what the speech model sends, or what you record or
 * upload, into a clip that is safe to put in a video.
 *
 * Decoding honestly. A speech payload is often headerless 16-bit PCM
 * ("audio/L16;codec=pcm;rate=24000") and sometimes a WAV — and a newer model
 * appends a provenance manifest after the audio. Treating a WAV as raw PCM
 * decodes its header into a burst of noise; the wrong rate plays the card at
 * the wrong speed. So the mime type and the header decide, never an assumption.
 *
 * Trimming the ends. A speech clip routinely arrives with a short, quiet burst
 * after the words, and a recording has the second or two around pressing the
 * button. Neither belongs on a card, whose length is the length of its sound.
 *
 * Ported from Reels Creator's audioClean, working on plain samples so the
 * logic can be tested outside a browser.
 */

import { analyzeSpeech, type SpeechSegment } from "../render/audioAlign";
import { decodeAudio, encodeWavMono, toMono } from "./audioTools";

/** What the speech models return when they do not say otherwise. */
export const DEFAULT_TTS_SAMPLE_RATE = 24000;

/** Reads the rate out of a mime type like `audio/L16;codec=pcm;rate=24000`. */
export function sampleRateFromMime(mimeType?: string | null): number | undefined {
  const match = /rate=(\d+)/i.exec(String(mimeType || ""));
  if (!match) return undefined;
  const rate = Number(match[1]);
  return Number.isFinite(rate) && rate >= 8000 && rate <= 192000 ? rate : undefined;
}

/**
 * Strips a RIFF/WAVE header if the payload has one, and reports what it
 * declares. Walks the chunks rather than assuming the data starts at byte 44:
 * a file with a LIST chunk puts it elsewhere, and one with a manifest after
 * the audio must stop where the data chunk says it ends.
 */
export function unwrapWav(raw: ArrayBuffer): { pcm: ArrayBuffer; sampleRate?: number; channels?: number; bits?: number } {
  const bytes = new Uint8Array(raw);
  if (bytes.length < 44) return { pcm: raw };
  const tag = (offset: number) =>
    String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return { pcm: raw };

  const view = new DataView(raw);
  let sampleRate: number | undefined;
  let channels: number | undefined;
  let bits: number | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= bytes.length) {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === "data") {
      const end = Math.min(bytes.length, body + size);
      return { pcm: raw.slice(body, end), sampleRate, channels, bits };
    }
    // Chunks are word aligned.
    offset = body + size + (size % 2);
  }
  return { pcm: raw, sampleRate, channels, bits };
}

/** Signed 16-bit little-endian PCM to floats, mixed down to mono. */
export function pcm16ToMono(pcm: ArrayBuffer, channels = 1): Float32Array {
  const evenLength = pcm.byteLength - (pcm.byteLength % 2);
  const ints = new Int16Array(pcm.slice(0, evenLength));
  const ch = Math.max(1, Math.floor(channels));
  const frames = Math.floor(ints.length / ch);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < ch; c++) sum += ints[f * ch + c];
    out[f] = sum / ch / 32768;
  }
  return out;
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Whether a payload is PCM or WAV, which can be read here without the browser's decoder. */
export function isPcmPayload(mimeType?: string | null, raw?: ArrayBuffer): boolean {
  const mime = String(mimeType || "").toLowerCase();
  if (!mime || /l16|pcm|wav|wave/.test(mime)) return true;
  // A WAV under some other label still announces itself.
  if (raw && raw.byteLength >= 12) {
    const b = new Uint8Array(raw, 0, 12);
    if (String.fromCharCode(b[0], b[1], b[2], b[3]) === "RIFF") return true;
  }
  return false;
}

/** A PCM or WAV speech payload as mono samples at the rate it really is. */
export function decodePcmPayload(raw: ArrayBuffer, mimeType?: string | null): { samples: Float32Array; sampleRate: number } {
  const { pcm, sampleRate: declared, channels, bits } = unwrapWav(raw);
  if (bits && bits !== 16) throw new Error(`The voice came back as ${bits}-bit audio, which this app cannot read.`);
  const sampleRate = declared || sampleRateFromMime(mimeType) || DEFAULT_TTS_SAMPLE_RATE;
  return { samples: pcm16ToMono(pcm, channels || 1), sampleRate };
}

/* ------------------------------------------------------------------ */
/* Trimming                                                             */
/* ------------------------------------------------------------------ */

/** A run this short, this quiet, and this far from the speech is not speech. */
const ARTIFACT_MAX_SECONDS = 0.22;
const ARTIFACT_MAX_LEVEL_DB = -12;
const ARTIFACT_MIN_GAP = 0.12;

/** Raised-cosine fade at each end: long enough to kill a click, short enough to hear nothing. */
const FADE_SECONDS = 0.008;

/**
 * Drops runs at either end that look like an artifact rather than a word.
 * Short and quiet and cut off from everything else — each alone describes a
 * real word; all three together describe the burst of noise.
 */
function dropEdgeArtifacts(segments: SpeechSegment[]): SpeechSegment[] {
  let kept = segments.slice();
  const isArtifact = (segment: SpeechSegment, neighbour: SpeechSegment | undefined, atEnd: boolean) => {
    if (!neighbour) return false;
    const gap = atEnd ? segment.start - neighbour.end : neighbour.start - segment.end;
    return (
      segment.end - segment.start <= ARTIFACT_MAX_SECONDS &&
      (segment.peakDb ?? 0) <= ARTIFACT_MAX_LEVEL_DB &&
      gap >= ARTIFACT_MIN_GAP
    );
  };
  while (kept.length > 1 && isArtifact(kept[kept.length - 1], kept[kept.length - 2], true)) kept = kept.slice(0, -1);
  while (kept.length > 1 && isArtifact(kept[0], kept[1], false)) kept = kept.slice(1);
  return kept;
}

export interface TrimOptions {
  /** Kept in front of the first word, in seconds. */
  head: number;
  /** Kept after the last word, in seconds. */
  tail: number;
  /**
   * If the speech found is less than this share of the clip, the analysis is
   * taken to be wrong — a whisper, music — and nothing is trimmed.
   */
  minKeepFraction: number;
}

/** A speech model's clip: clean, so tight margins and a strict sanity check. */
export const TTS_TRIM: TrimOptions = { head: 0.04, tail: 0.09, minKeepFraction: 0.25 };

/** Your own recording: room noise and a button press at each end, so roomier margins. */
export const RECORDING_TRIM: TrimOptions = { head: 0.12, tail: 0.25, minKeepFraction: 0.06 };

export interface TrimResult {
  samples: Float32Array;
  trimmedHead: number;
  trimmedTail: number;
}

/**
 * Trims the non-speech ends off a clip and fades what is left. Returns the
 * clip unchanged (but faded) when there is nothing confident to do.
 */
export function trimToSpeech(samples: Float32Array, sampleRate: number, options: TrimOptions = TTS_TRIM): TrimResult {
  const fadeOnly = (): TrimResult => ({ samples: fadeEdges(samples.slice(), sampleRate), trimmedHead: 0, trimmedTail: 0 });
  const duration = samples.length / sampleRate;
  if (samples.length < 2 || duration < 0.08) return fadeOnly();

  const segments = dropEdgeArtifacts(analyzeSpeech(samples, sampleRate).segments);
  if (!segments.length) return fadeOnly();

  const from = Math.max(0, segments[0].start - options.head);
  const to = Math.min(duration, segments[segments.length - 1].end + options.tail);
  if (to - from < 0.05 || to - from < duration * options.minKeepFraction) return fadeOnly();

  const start = Math.floor(from * sampleRate);
  const end = Math.min(samples.length, Math.ceil(to * sampleRate));
  return {
    samples: fadeEdges(samples.slice(start, end), sampleRate),
    trimmedHead: start / sampleRate,
    trimmedTail: duration - end / sampleRate,
  };
}

/** Raised-cosine ramps at both ends, in place. No corner at either end of the ramp, so the fade cannot click. */
export function fadeEdges(samples: Float32Array, sampleRate: number): Float32Array {
  const fade = Math.min(Math.floor(FADE_SECONDS * sampleRate), Math.floor(samples.length / 2));
  for (let i = 0; i < fade; i++) {
    const gain = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    samples[i] *= gain;
    samples[samples.length - 1 - i] *= gain;
  }
  return samples;
}

/* ------------------------------------------------------------------ */
/* Clips                                                                */
/* ------------------------------------------------------------------ */

export interface CardSound {
  /** Mono 16-bit WAV. */
  blob: Blob;
  durationSeconds: number;
}

function toCardSound(samples: Float32Array, sampleRate: number, trim: TrimOptions): CardSound {
  const trimmed = trimToSpeech(samples, sampleRate, trim).samples;
  return { blob: encodeWavMono(trimmed, sampleRate), durationSeconds: trimmed.length / sampleRate };
}

/** A speech model's payload (base64) as a trimmed WAV. */
export async function ttsPayloadToSound(base64Audio: string, mimeType?: string | null): Promise<CardSound> {
  const raw = base64ToArrayBuffer(base64Audio);
  if (isPcmPayload(mimeType, raw)) {
    const { samples, sampleRate } = decodePcmPayload(raw, mimeType);
    if (samples.length < sampleRate * 0.1) throw new Error("The voice came back empty. Try again.");
    return toCardSound(samples, sampleRate, TTS_TRIM);
  }
  // Something else (MP3, Ogg): let the browser decode it.
  const buffer = await decodeAudio(new Blob([raw], { type: String(mimeType) }));
  return toCardSound(toMono(buffer), buffer.sampleRate, TTS_TRIM);
}

/** A recording or an uploaded file as a trimmed mono WAV. Throws a readable error if it is not audio. */
export async function audioFileToSound(blob: Blob): Promise<CardSound> {
  const buffer = await decodeAudio(blob);
  if (buffer.duration < 0.2) throw new Error("That clip is too short to use.");
  return toCardSound(toMono(buffer), buffer.sampleRate, RECORDING_TRIM);
}

/* ------------------------------------------------------------------ */
/* The server call                                                      */
/* ------------------------------------------------------------------ */

export interface TtsResult extends CardSound {
  model: string;
}

/** Reads `text` aloud with an AI voice. The words are sent and nothing else. */
export async function requestTts(params: {
  text: string;
  voiceName: string;
  apiKey: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<TtsResult> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: params.signal,
    body: JSON.stringify({
      text: params.text,
      voiceName: params.voiceName,
      model: params.model,
      userApiKey: params.apiKey.trim() || undefined,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `The AI voice failed (HTTP ${res.status}).`);
  if (!data?.base64Audio) throw new Error("The AI voice returned no audio.");
  const sound = await ttsPayloadToSound(data.base64Audio, data.mimeType);
  return { ...sound, model: String(data.model || "") };
}
