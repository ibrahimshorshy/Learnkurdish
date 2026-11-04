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
 *   level    — the recording's levelling gain, a soft limit, a short
 *              crossfade at every join and a fade at each end, so nothing
 *              clicks
 *
 * Playback in the editor and the video both go through here, so what you hear
 * while proofing is what the video gets.
 *
 * Video projects never cut or tighten: their audio has to stay in step with
 * the picture.
 *
 * Everything above `assemble` is pure (no AudioBuffer), so it runs under the
 * tests.
 */

import type { LessonLine, Project, TimeRange } from "../types";
import type { RecordingAudio } from "./useRecordingAudio";

export interface AudioSources {
  /** The main recording — cleaned up when a preset is on. */
  main: RecordingAudio | null;
  /** Re-recorded takes, by take id — cleaned up likewise. */
  takes: Map<string, RecordingAudio>;
}

/**
 * Two pieces are joined by overlapping them this long. A fade down and back up
 * at a join leaves a small hole, which is audible in the middle of a word
 * (where a cut often lands) and as a flutter in room tone; an equal-power
 * crossfade leaves neither.
 */
export const JOIN_CROSSFADE = 0.012;
/** Fade at the very start and end of a clip. */
export const EDGE_FADE = 0.015;

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

/** How much of [from, to] the cuts cover. `cuts` must be sorted and not overlap. */
function cutTimeIn(from: number, to: number, cuts: TimeRange[]): number {
  return cuts.reduce((sum, c) => sum + Math.max(0, Math.min(to, c.end) - Math.max(from, c.start)), 0);
}

/** The time `amount` seconds of kept sound after `from`, stepping over the cuts. */
function afterKept(from: number, amount: number, cuts: TimeRange[]): number {
  let t = from;
  let left = amount;
  for (const c of cuts) {
    if (c.end <= t) continue;
    if (c.start >= t + left) break;
    left -= Math.max(0, c.start - t);
    t = Math.max(t, c.end);
  }
  return t + left;
}

/** The time `amount` seconds of kept sound before `to`, stepping over the cuts. */
function beforeKept(to: number, amount: number, cuts: TimeRange[]): number {
  let t = to;
  let left = amount;
  for (let i = cuts.length - 1; i >= 0; i--) {
    const c = cuts[i];
    if (c.start >= t) continue;
    if (c.end <= t - left) break;
    left -= Math.max(0, t - c.end);
    t = Math.min(t, c.start);
  }
  return t - left;
}

/**
 * Like `pauseTrims` for the whole of [start, end], but measured as it will
 * sound once `cuts` are skipped. Cutting an "um" or a cough out of a pause
 * joins the silence before it to the silence after it, so the two are one
 * pause: it is measured without the cut, and trimmed so that what is left is
 * no longer than `maxPause`, half the limit next to each word. Without cuts
 * the line comes out exactly as `pauseTrims` makes it.
 */
export function pauseTrimsAcrossCuts(
  start: number,
  end: number,
  segments: { start: number; end: number }[],
  cuts: TimeRange[],
  maxPause: number
): TimeRange[] {
  const sorted = normalizeCuts(cuts).filter((c) => c.end > start && c.start < end);
  // Speech that was cut is not heard, so it does not end a pause.
  const speech = segments
    .filter((s) => s.end > start && s.start < end)
    .flatMap((s) => subtractRanges(s.start, s.end, sorted))
    .sort((a, b) => a.start - b.start);
  const keep = Math.max(0.1, maxPause) / 2;
  const trims: TimeRange[] = [];
  for (let i = 0; i + 1 < speech.length; i++) {
    const gapStart = Math.max(start, speech[i].end);
    const gapEnd = Math.min(end, speech[i + 1].start);
    // The nanosecond allowance only stops rounding error in the cut lengths
    // from trimming a pause that is exactly at the limit.
    if (gapEnd - gapStart - cutTimeIn(gapStart, gapEnd, sorted) - maxPause <= 1e-9) continue;
    const from = afterKept(gapStart, keep, sorted);
    const to = beforeKept(gapEnd, keep, sorted);
    if (to > from) trims.push({ start: from, end: to });
  }
  return trims;
}

/** The pieces of the source that make up this line, after cuts and tightening. */
export function linePieces(line: LessonLine, source: RecordingAudio, project: Project): TimeRange[] {
  const fromTake = Boolean(line.take);
  const start = fromTake ? line.take!.start : line.start;
  const end = fromTake ? line.take!.end : line.end;
  if (project.kind === "video") return [{ start, end }];

  // Cuts are marked on the main recording's timeline, so they mean nothing to a take.
  const cuts = fromTake ? [] : project.cuts;
  if (!project.audioFx.tightenPauses) return subtractRanges(start, end, cuts);
  // Pauses are measured across the cuts, so cutting a cough out of a pause
  // never leaves a longer pause than the limit. A take is tightened by its own
  // pauses: `source` is the take, with its own analysis.
  const trims = pauseTrimsAcrossCuts(start, end, source.analysis.segments, cuts, project.audioFx.maxPause);
  return subtractRanges(start, end, [...cuts, ...trims]);
}

/** How long two pieces overlap where they are joined. */
function joinOverlap(before: number, after: number): number {
  return Math.max(0, Math.min(JOIN_CROSSFADE, before / 2, after / 2));
}

/** How long pieces last once joined with crossfades. */
export function piecesDuration(pieces: TimeRange[]): number {
  let total = 0;
  pieces.forEach((p, i) => {
    const d = Math.max(0, p.end - p.start);
    total += d;
    if (i > 0) total -= joinOverlap(Math.max(0, pieces[i - 1].end - pieces[i - 1].start), d);
  });
  return Math.max(0, total);
}

/** How long the line will be once built, without building it. */
export function lineDuration(line: LessonLine, sources: AudioSources, project: Project): number {
  const source = line.take ? sources.takes.get(line.take.id) : sources.main;
  if (!source) return Math.max(0, line.take ? line.take.end - line.take.start : line.end - line.start);
  return piecesDuration(linePieces(line, source, project));
}

/* ------------------------------------------------------------------ */
/* Cuts                                                                 */
/* ------------------------------------------------------------------ */

/** Cuts sorted, with any that overlap or touch merged into one. */
export function normalizeCuts(cuts: TimeRange[]): TimeRange[] {
  const sorted = cuts
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end - c.start > 0.005)
    .map((c) => ({ start: Math.max(0, c.start), end: c.end }))
    .sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const cut of sorted) {
    const last = out[out.length - 1];
    // Within 10ms counts as touching: two cuts that close would leave a sliver nobody can hear.
    if (last && cut.start <= last.end + 0.01) last.end = Math.max(last.end, cut.end);
    else out.push({ ...cut });
  }
  return out.map((c) => ({ start: round3(c.start), end: round3(c.end) }));
}

/** `cuts` with `range` removed too. */
export function addCut(cuts: TimeRange[], range: TimeRange): TimeRange[] {
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  return normalizeCuts([...cuts, { start, end }]);
}

/** `cuts` without the one that covers `time`. */
export function restoreCutAt(cuts: TimeRange[], time: number): TimeRange[] {
  return cuts.filter((c) => !(time >= c.start && time <= c.end));
}

/** The cut under `time`, if any. */
export function cutAt(cuts: TimeRange[], time: number): TimeRange | undefined {
  return cuts.find((c) => time >= c.start && time <= c.end);
}

/**
 * How much the cuts take out: in all, and from the lines that actually use the
 * main recording (a cut between lines, or under a line with its own take,
 * removes nothing you would hear).
 */
export function cutSummary(project: Pick<Project, "cuts" | "lines" | "kind">): {
  count: number;
  total: number;
  inLines: number;
} {
  const cuts = normalizeCuts(project.cuts);
  const total = cuts.reduce((sum, c) => sum + (c.end - c.start), 0);
  let inLines = 0;
  if (project.kind !== "video") {
    for (const line of project.lines) {
      if (line.take || line.skip) continue;
      for (const c of cuts) inLines += Math.max(0, Math.min(line.end, c.end) - Math.max(line.start, c.start));
    }
  }
  return { count: cuts.length, total, inLines };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/* ------------------------------------------------------------------ */
/* Building the clip                                                    */
/* ------------------------------------------------------------------ */

/**
 * Keeps peaks under full scale without squaring them off. Below the knee the
 * sample is untouched; above it, it bends smoothly towards 1. Continuous, so a
 * loud word is rounded off rather than crackling.
 */
export function softLimit(v: number): number {
  const knee = 0.8;
  const a = Math.abs(v);
  if (a <= knee) return v;
  const bent = knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee));
  return v < 0 ? -bent : bent;
}

/** Joins pieces of a buffer into one clip, levelled, crossfaded at every join, faded at both ends. */
export function assemble(buffer: AudioBuffer, pieces: TimeRange[], gain = 1): AudioBuffer {
  const rate = buffer.sampleRate;
  const spans = pieces
    .map((p) => ({
      from: Math.max(0, Math.floor(p.start * rate)),
      to: Math.min(buffer.length, Math.ceil(p.end * rate)),
    }))
    .filter((s) => s.to > s.from);
  const crossfade = Math.floor(JOIN_CROSSFADE * rate);
  const overlaps = spans.map((s, i) =>
    i === 0 ? 0 : Math.min(crossfade, Math.floor((spans[i - 1].to - spans[i - 1].from) / 2), Math.floor((s.to - s.from) / 2))
  );
  const length = Math.max(
    1,
    spans.reduce((sum, s, i) => sum + (s.to - s.from) - overlaps[i], 0)
  );
  const clip = new AudioBuffer({ length, numberOfChannels: buffer.numberOfChannels, sampleRate: rate });
  const edge = Math.min(Math.floor(EDGE_FADE * rate), Math.floor(length / 2));

  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const dst = clip.getChannelData(c);
    let offset = 0;
    spans.forEach((span, index) => {
      const n = span.to - span.from;
      const x = overlaps[index];
      // Start `x` samples early, over the end of the previous piece.
      offset -= x;
      for (let i = 0; i < n; i++) {
        const v = src[span.from + i] || 0;
        if (i < x) {
          // Equal power: the two pieces are unrelated sound, so their energies add.
          const phase = ((i + 0.5) / x) * (Math.PI / 2);
          dst[offset + i] = dst[offset + i] * Math.cos(phase) + v * Math.sin(phase);
        } else {
          dst[offset + i] = v;
        }
      }
      offset += n;
    });
    for (let i = 0; i < length; i++) {
      let v = softLimit(dst[i] * gain);
      if (edge > 0 && i < edge) v *= i / edge;
      else if (edge > 0 && i > length - 1 - edge) v *= (length - 1 - i) / edge;
      dst[i] = v;
    }
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
