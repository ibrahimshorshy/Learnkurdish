/**
 * Re-recorded takes: a fresh recording of one line that replaces that line's
 * slice of the main recording.
 *
 * A take is recorded with the mouse in hand, so it starts with the click of
 * the record button and a moment of silence, and ends with the same in
 * reverse. Only the speech is the line, so the take is trimmed to where the
 * voice is, with a little air either side. The whole recording is kept, so the
 * trim can be nudged afterwards.
 */

import type { Take, TimeRange } from "../types";
import type { SpeechAnalysis } from "../render/audioAlign";
import { loadRecordingAudio } from "./useRecordingAudio";
import { newId } from "../utils/projectStore";

/** Air kept before the first word, so its onset is not clipped. */
export const TAKE_LEAD = 0.15;
/** Air kept after the last word; speech decays, so a little more. */
export const TAKE_TAIL = 0.25;
/** A take shorter than this is a slip of the button, not a line. */
export const MIN_TAKE = 0.3;

/**
 * A blip at the very start or end this short, this far from the speech, is
 * the button click or the chair, not a word. A one-syllable word is longer.
 */
const BLIP = 0.09;
const BLIP_ISOLATION = 0.3;

/**
 * The part of a take that is the line: from just before the first word to
 * just after the last. With no speech found, the whole take.
 */
export function speechRange(
  analysis: SpeechAnalysis,
  duration: number,
  pads: { lead: number; tail: number } = { lead: TAKE_LEAD, tail: TAKE_TAIL }
): TimeRange {
  let segments = analysis.segments.filter((s) => s.end > s.start);
  // analyzeSpeech returns one segment spanning everything when it cannot tell
  // speech from silence; that is no information, so keep the whole take.
  if (!segments.length || (segments.length === 1 && segments[0].start <= 0 && segments[0].end >= duration - 0.011)) {
    return { start: 0, end: duration };
  }
  // Drop isolated blips at either end.
  while (segments.length > 1) {
    const [first, second] = segments;
    if (first.end - first.start < BLIP && second.start - first.end > BLIP_ISOLATION) segments = segments.slice(1);
    else break;
  }
  while (segments.length > 1) {
    const last = segments[segments.length - 1];
    const before = segments[segments.length - 2];
    if (last.end - last.start < BLIP && last.start - before.end > BLIP_ISOLATION) segments = segments.slice(0, -1);
    else break;
  }
  const start = Math.max(0, segments[0].start - pads.lead);
  const end = Math.min(duration, segments[segments.length - 1].end + pads.tail);
  return end - start >= MIN_TAKE ? { start: round3(start), end: round3(end) } : { start: 0, end: duration };
}

/** A take from a recorded or uploaded file: decoded, checked, trimmed to the speech. */
export async function takeFromBlob(blob: Blob, mimeType?: string): Promise<Take> {
  // The same cache the line player reads, so the take plays at once afterwards.
  const audio = await loadRecordingAudio(blob);
  const duration = audio.buffer.duration;
  if (duration < MIN_TAKE) throw new Error("That take is too short to use. Record the whole line.");
  const range = speechRange(audio.analysis, duration);
  return {
    id: newId("t"),
    blob,
    mimeType: mimeType || blob.type || "audio/webm",
    durationSeconds: duration,
    start: range.start,
    end: range.end,
  };
}

/** Moves one edge of a take's trim by `delta` seconds, within the take and never shorter than a sliver. */
export function nudgeTake(take: Take, edge: "start" | "end", delta: number): Pick<Take, "start" | "end"> {
  const MIN = 0.15;
  if (edge === "start") {
    return { start: round3(Math.max(0, Math.min(take.end - MIN, take.start + delta))), end: take.end };
  }
  return { start: take.start, end: round3(Math.min(take.durationSeconds, Math.max(take.start + MIN, take.end + delta))) };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
