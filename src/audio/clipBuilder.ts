/**
 * One line's audio, exactly as it will sound in the video.
 *
 * A line's sound comes from one of two places: its slice of the main
 * recording, or a fresh take recorded for that line alone. Before it is used,
 * three things can happen to it:
 *
 *   cuts     — stretches of the main recording you removed (a cough, a false
 *              start) are skipped
 *   tighten  — silences inside the line longer than the limit are shortened
 *   level    — the recording's levelling gain, a soft limit, and short fades
 *              at every join so nothing clicks
 *
 * Playback in the editor and the video both go through here, so what you hear
 * while proofing is what the video gets.
 *
 * Video projects never cut or tighten: their audio has to stay in step with
 * the picture.
 */

import type { LessonLine, Project, TimeRange } from "../types";
import type { RecordingAudio } from "./useRecordingAudio";

export interface AudioSources {
  /** The main recording — cleaned up when a preset is on. */
  main: RecordingAudio | null;
  /** Re-recorded takes, by take id — cleaned up likewise. */
  takes: Map<string, RecordingAudio>;
}

/** [start, end) minus every range in `remove`, in order. */
export function subtractRanges(start: number, end: number, remove: TimeRange[]): TimeRange[] {
  let pieces: TimeRange[] = [{ start, end }];
  for (const cut of remove) {
    if (cut.end <= cut.start) continue;
    const next: TimeRange[] = [];
    for (const piece of pieces) {
      if (cut.end <= piece.start || cut.start >= piece.end) {
        next.push(piece);
        continue;
      }
      if (cut.start > piece.start) next.push({ start: piece.start, end: cut.start });
      if (cut.end < piece.end) next.push({ start: cut.end, end: piece.end });
    }
    pieces = next;
  }
  return pieces.filter((p) => p.end - p.start > 0.005);
}

/**
 * The silences to take out so no pause inside the line is longer than
 * `maxPause`. Half the allowed pause is kept either side of the gap, so the
 * rhythm of the sentence survives — only the dead air goes.
 */
export function pauseTrims(
  pieces: TimeRange[],
  segments: { start: number; end: number }[],
  maxPause: number
): TimeRange[] {
  const trims: TimeRange[] = [];
  const keep = Math.max(0.1, maxPause) / 2;
  for (const piece of pieces) {
    const inside = segments.filter((s) => s.end > piece.start && s.start < piece.end);
    for (let i = 0; i + 1 < inside.length; i++) {
      const gapStart = Math.max(piece.start, inside[i].end);
      const gapEnd = Math.min(piece.end, inside[i + 1].start);
      if (gapEnd - gapStart > maxPause) trims.push({ start: gapStart + keep, end: gapEnd - keep });
    }
  }
  return trims;
}

/** The pieces of the source that make up this line, after cuts and tightening. */
export function linePieces(line: LessonLine, source: RecordingAudio, project: Project): TimeRange[] {
  const fromTake = Boolean(line.take);
  const start = fromTake ? line.take!.start : line.start;
  const end = fromTake ? line.take!.end : line.end;
  const editable = project.kind !== "video";

  let pieces =
    editable && !fromTake ? subtractRanges(start, end, project.cuts) : [{ start, end }];
  if (editable && project.audioFx.tightenPauses) {
    const trims = pauseTrims(pieces, source.analysis.segments, project.audioFx.maxPause);
    pieces = pieces.flatMap((p) => subtractRanges(p.start, p.end, trims));
  }
  return pieces;
}

/** How long the line will be once built, without building it. */
export function lineDuration(line: LessonLine, sources: AudioSources, project: Project): number {
  const source = line.take ? sources.takes.get(line.take.id) : sources.main;
  if (!source) return Math.max(0, line.end - line.start);
  return linePieces(line, source, project).reduce((sum, p) => sum + (p.end - p.start), 0);
}

/** Joins pieces of a buffer into one clip, levelled, with a fade at every edge. */
export function assemble(buffer: AudioBuffer, pieces: TimeRange[], gain = 1): AudioBuffer {
  const rate = buffer.sampleRate;
  const spans = pieces
    .map((p) => ({
      from: Math.max(0, Math.floor(p.start * rate)),
      to: Math.min(buffer.length, Math.ceil(p.end * rate)),
    }))
    .filter((s) => s.to > s.from);
  const length = Math.max(1, spans.reduce((sum, s) => sum + (s.to - s.from), 0));
  const clip = new AudioBuffer({ length, numberOfChannels: buffer.numberOfChannels, sampleRate: rate });

  const outerFade = Math.floor(0.015 * rate);
  const joinFade = Math.floor(0.006 * rate);

  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const dst = clip.getChannelData(c);
    let offset = 0;
    spans.forEach((span, index) => {
      const n = span.to - span.from;
      const fadeIn = Math.min(index === 0 ? outerFade : joinFade, Math.floor(n / 2));
      const fadeOut = Math.min(index === spans.length - 1 ? outerFade : joinFade, Math.floor(n / 2));
      for (let i = 0; i < n; i++) {
        let v = (src[span.from + i] || 0) * gain;
        if (v > 0.95 || v < -0.95) v = Math.tanh(v);
        if (fadeIn > 0 && i < fadeIn) v *= i / fadeIn;
        else if (fadeOut > 0 && i > n - 1 - fadeOut) v *= (n - 1 - i) / fadeOut;
        dst[offset + i] = v;
      }
      offset += n;
    });
  }
  return clip;
}

/** The line's finished clip, or null when its audio is not loaded yet. */
export function buildLineClip(line: LessonLine, sources: AudioSources, project: Project): AudioBuffer | null {
  const source = line.take ? sources.takes.get(line.take.id) : sources.main;
  if (!source) return null;
  const pieces = linePieces(line, source, project);
  if (!pieces.length) return null;
  return assemble(source.buffer, pieces, source.gain);
}
