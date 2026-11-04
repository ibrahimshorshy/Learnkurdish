/**
 * Cleaning up the recording and the takes with the project's audio preset.
 *
 * The browser sends the audio it already decoded — as a plain WAV of the very
 * samples the waveform shows and the line times index into — rather than the
 * original file. Decoders disagree by a few tens of milliseconds about where an
 * MP3 or AAC file starts (encoder padding); sending the decoded samples means
 * the server cannot disagree with the browser about time zero.
 *
 * Each result is kept in memory by source and key as well as in the project,
 * so switching back to a preset tried a moment ago is instant, and the hook
 * still works when nobody is there to store the result in the project.
 */

import type { AudioFxSettings, Project, Take } from "../types";
import type { RecordingAudio } from "./useRecordingAudio";
import { loadRecordingAudio } from "./useRecordingAudio";
import { encodeWavMono } from "./audioTools";
import { needsProcessing, processedKey } from "../config/audioPresets";

export { processedKey, needsProcessing } from "../config/audioPresets";

export type AudioProcessingStatus =
  | { state: "idle" }
  | { state: "processing"; /** What is being cleaned now, e.g. "your recording", "take for line 3". */ label: string; remaining: number }
  | { state: "error"; message: string };

/** An error worth stopping the queue for: every other file would fail the same way. */
export class ProcessingError extends Error {
  constructor(
    message: string,
    readonly fatal: boolean
  ) {
    super(message);
  }
}

/** The settings key for the main recording, or null when nothing needs making. */
export function mainKey(project: Project): string | null {
  const rec = project.recording;
  if (!rec || !needsProcessing(project.audioFx)) return null;
  return processedKey(project.audioFx, { size: rec.blob.size, durationSeconds: rec.durationSeconds });
}

/** The settings key for a take, or null when nothing needs making. */
export function takeKey(fx: AudioFxSettings, take: Take): string | null {
  if (!needsProcessing(fx)) return null;
  return processedKey(fx, { size: take.blob.size, durationSeconds: take.durationSeconds });
}

/* ------------------------------------------------------------------ */
/* In-memory results                                                    */
/* ------------------------------------------------------------------ */

/** Results by source Blob, then by key. Only the last few per source: they are big. */
const made = new WeakMap<Blob, Map<string, Blob>>();
const KEEP_PER_SOURCE = 3;

export function rememberProcessed(source: Blob, key: string, result: Blob) {
  let byKey = made.get(source);
  if (!byKey) {
    byKey = new Map();
    made.set(source, byKey);
  }
  byKey.delete(key);
  byKey.set(key, result);
  while (byKey.size > KEEP_PER_SOURCE) byKey.delete(byKey.keys().next().value!);
}

export function recallProcessed(source: Blob, key: string): Blob | undefined {
  return made.get(source)?.get(key);
}

/* ------------------------------------------------------------------ */
/* The request                                                          */
/* ------------------------------------------------------------------ */

/**
 * Cleans one decoded recording on the server. Resolves to a 48kHz mono WAV of
 * exactly the same length, checked here by decoding it.
 */
export async function requestProcessed(
  audio: RecordingAudio,
  fx: Pick<AudioFxSettings, "preset" | "room">,
  signal?: AbortSignal
): Promise<Blob> {
  const wav = encodeWavMono(audio.mono, audio.buffer.sampleRate);
  const form = new FormData();
  form.append("audio", wav, "audio.wav");
  form.append("preset", fx.preset);
  form.append("room", fx.room ? "1" : "0");

  let res: Response;
  try {
    res = await fetch("/api/audio/process", { method: "POST", body: form, signal });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new ProcessingError("The app's server did not answer. Is it still running?", true);
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    const message = detail?.error || `Clean-up failed (HTTP ${res.status})`;
    // 503: no ffmpeg. 404: a server too old to have the route. Neither gets better by retrying the next file.
    throw new ProcessingError(message, res.status === 503 || res.status === 404);
  }
  const blob = new Blob([await res.arrayBuffer()], { type: "audio/wav" });

  // Belt and braces: the server checks the length too, but a cleaned file that
  // is longer or shorter would put every line out of step.
  const back = await loadRecordingAudio(blob);
  const drift = Math.abs(back.buffer.duration - audio.buffer.duration);
  if (drift > 0.02) {
    throw new ProcessingError(
      `The cleaned audio came back ${drift.toFixed(2)}s ${back.buffer.duration > audio.buffer.duration ? "longer" : "shorter"} than the original, so it was not used.`,
      false
    );
  }
  return blob;
}
