/**
 * Where each line starts and ends in the recording.
 *
 * The model hears the words well and the timing roughly: its timestamps are
 * predictions, often a few hundred milliseconds out and sometimes a second or
 * more. Cut the audio at those numbers and a line loses its first syllable or
 * picks up the start of the next one.
 *
 * The recording itself knows better. A teacher recording a lesson pauses
 * between sentences, and a pause is measurable. So the model's times are
 * treated as a hint of *which* pause each boundary belongs to, and the cut is
 * moved into that pause. When the model's times are unusable altogether, the
 * lines are laid over the speech by length instead, using the same aligner the
 * karaoke uses for words.
 *
 * Pure: no DOM, so it runs under the tests.
 */

import { alignWordsToAudio, type SpeechAnalysis, type SpeechSegment } from "../render/audioAlign";

export interface TimeRange {
  start: number;
  end: number;
}

/** A silence between two runs of speech. */
export interface Pause {
  start: number;
  end: number;
}

/** Silence kept before the first word of a line, so the onset is not clipped. */
export const LEAD_PAD = 0.12;
/** Silence kept after the last word; speech decays, so a little more. */
export const TAIL_PAD = 0.2;
/** Shortest silence that can separate two lines. */
export const MIN_LINE_GAP = 0.12;
/** Shortest a line may become. */
const MIN_LINE = 0.25;

/** Silences between runs of speech, in order. Leading and trailing silence excluded. */
export function pausesOf(analysis: SpeechAnalysis, minGap = MIN_LINE_GAP): Pause[] {
  const segs = analysis.segments;
  const pauses: Pause[] = [];
  for (let i = 0; i + 1 < segs.length; i++) {
    const gap = segs[i + 1].start - segs[i].end;
    if (gap >= minGap) pauses.push({ start: segs[i].end, end: segs[i + 1].start });
  }
  return pauses;
}

function segmentsIn(analysis: SpeechAnalysis, range: TimeRange): SpeechSegment[] {
  return analysis.segments.filter((s) => s.end > range.start && s.start < range.end);
}

/**
 * Pulls a line's edges in to its speech, leaving a little air either side.
 * A line with no speech inside it is left alone — the user may know better.
 */
export function tighten(range: TimeRange, analysis: SpeechAnalysis): TimeRange {
  const inside = segmentsIn(analysis, range);
  if (!inside.length) return { ...range };
  const start = Math.max(range.start, inside[0].start - LEAD_PAD);
  const end = Math.min(range.end, inside[inside.length - 1].end + TAIL_PAD);
  return end - start >= MIN_LINE ? { start, end } : { ...range };
}

/**
 * Runs of speech with the short gaps inside them closed — a word gap or a
 * comma, not a sentence break. Snapping the outer edges to these rather than
 * to single words keeps a model time that lands between two words of the same
 * sentence from cutting the sentence short.
 */
export function runsOf(analysis: SpeechAnalysis, maxGap = 0.3): SpeechSegment[] {
  const runs: SpeechSegment[] = [];
  for (const seg of analysis.segments) {
    const last = runs[runs.length - 1];
    if (last && seg.start - last.end < maxGap) last.end = seg.end;
    else runs.push({ start: seg.start, end: seg.end });
  }
  return runs;
}

/** Moves a start time back to the beginning of the run of speech it falls in, or forward to the next. */
function snapStart(t: number, analysis: SpeechAnalysis, window: number): number {
  const runs = runsOf(analysis);
  const within = runs.find((r) => t >= r.start && t < r.end);
  if (within) return Math.max(0, within.start - LEAD_PAD);
  const next = runs.find((r) => r.start >= t);
  if (next && next.start - t <= window) return Math.max(0, next.start - LEAD_PAD);
  return t;
}

/** Moves an end time out to the end of the run of speech it falls in, or back to the last one. */
function snapEnd(t: number, analysis: SpeechAnalysis, window: number): number {
  const runs = runsOf(analysis);
  const within = runs.find((r) => t > r.start && t <= r.end);
  if (within) return Math.min(analysis.duration, within.end + TAIL_PAD);
  const prev = [...runs].reverse().find((r) => r.end <= t);
  if (prev && t - prev.end <= window) return Math.min(analysis.duration, prev.end + TAIL_PAD);
  return Math.min(analysis.duration, t);
}

/**
 * How far clear of both of the model's edges speech must lie for it to count
 * as left out on purpose rather than as an edge the model misjudged. The
 * model's times are often a few hundred milliseconds out, so this is more
 * than that.
 */
export const LEFT_OUT_MARGIN = 0.6;

/**
 * How long the silence on each side of that speech must be. A first or last
 * word set off by a comma looks just like a false start to the model's times;
 * a pause this long is a break between sentences, not a comma.
 */
export const LEFT_OUT_PAUSE = 0.6;

/**
 * The speech the model left out between two lines, as the first and last
 * index into `runs`, or null if there is none. The transcription prompts tell
 * the model to leave out a false start, a remark or a cough (and, in a
 * dialogue, a speaker's name read out before a line), so speech there belongs
 * to neither line.
 *
 * Only speech clearly apart from both lines counts: wholly inside the gap,
 * clear of both of the model's edges, and with a long pause either side. A
 * word dropped from a lesson clip is worse than a stumble left in one, so
 * anything less certain is left to the lines: a run in the gap set off from
 * its line only by a short pause stays with that line, and with nothing
 * certain at all the shared-pause logic keeps everything.
 */
function speechLeftOut(
  runs: SpeechSegment[],
  gapStart: number,
  gapEnd: number,
  floor: number
): { first: number; last: number } | null {
  const from = Math.max(floor, gapStart + LEFT_OUT_MARGIN);
  const to = gapEnd - LEFT_OUT_MARGIN;
  let first = -1;
  let last = -1;
  // The runs inside the gap are consecutive, so everything from `first` to
  // `last` is inside it too.
  runs.forEach((r, k) => {
    if (r.start < from || r.end > to) return;
    const before = k > 0 ? r.start - runs[k - 1].end : Infinity;
    const after = k + 1 < runs.length ? runs[k + 1].start - r.end : Infinity;
    if (first < 0 && before >= LEFT_OUT_PAUSE) first = k;
    if (first >= 0 && after >= LEFT_OUT_PAUSE) last = k;
  });
  return first >= 0 && last >= first ? { first, last } : null;
}

/**
 * Moves every boundary between two lines into the pause the model most
 * plausibly meant, then trims each line to its speech.
 *
 * For each boundary the candidates are the pauses within `window` seconds of
 * where the model put it, and the choice favours a pause that is both close
 * and long — a sentence break is usually the longest silence nearby. A pause
 * can only be used once, and boundaries only move forward, so lines cannot
 * cross.
 *
 * Where the model's gap between two lines holds speech it clearly left out (a
 * stumble, "sorry, again", a word to someone in the room; see speechLeftOut),
 * the two lines do not share a pause: each edge snaps to its own line's
 * speech, and the left-out part stays out of both clips instead of playing
 * while one of them is on screen.
 */
export function snapLinesToPauses(
  lines: TimeRange[],
  analysis: SpeechAnalysis,
  options: { window?: number } = {}
): TimeRange[] {
  const window = options.window ?? 1.5;
  const n = lines.length;
  if (!n) return [];
  if (!analysis.segments.length || analysis.duration <= 0) return lines.map((l) => ({ ...l }));

  const out = lines.map((l) => ({ start: l.start, end: l.end }));
  const pauses = pausesOf(analysis);
  const runs = runsOf(analysis);

  let floor = 0;
  for (let i = 0; i + 1 < n; i++) {
    const leftOut = speechLeftOut(runs, out[i].end, out[i + 1].start, floor);
    if (leftOut) {
      // Speech between a model edge and what was left out is that line's own
      // (the edge was a little out), so the clip reaches to it. The long
      // pauses either side keep the padded edges out of the left-out speech.
      const before = leftOut.first > 0 ? runs[leftOut.first - 1].end : -Infinity;
      const after = leftOut.last + 1 < runs.length ? runs[leftOut.last + 1].start : Infinity;
      const end = Math.max(floor, snapEnd(Math.max(out[i].end, before), analysis, window));
      const start = Math.max(end, snapStart(Math.min(out[i + 1].start, after), analysis, window));
      out[i].end = end;
      out[i + 1].start = start;
      floor = start;
      continue;
    }

    const ideal = (out[i].end + out[i + 1].start) / 2;
    // Never reach past the far end of the following line.
    const ceiling = i + 2 < n ? out[i + 2].start : analysis.duration;

    let best: Pause | null = null;
    let bestScore = Infinity;
    for (const p of pauses) {
      if (p.start < floor || p.end > ceiling + window) continue;
      const distance = ideal < p.start ? p.start - ideal : ideal > p.end ? ideal - p.end : 0;
      if (distance > window) continue;
      const length = p.end - p.start;
      const score = distance - 0.8 * Math.min(length, 1.5);
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }

    if (best) {
      const length = best.end - best.start;
      out[i].end = best.start + Math.min(TAIL_PAD, length / 2);
      out[i + 1].start = best.end - Math.min(LEAD_PAD, length / 2);
      floor = best.end;
    } else {
      const cut = Math.max(floor, ideal);
      out[i].end = cut;
      out[i + 1].start = cut;
      floor = cut;
    }
  }

  out[0].start = snapStart(out[0].start, analysis, window);
  out[n - 1].end = snapEnd(out[n - 1].end, analysis, window);

  return finish(out.map((r) => tighten(r, analysis)), analysis.duration);
}

/**
 * Places lines with no usable times at all: each line is weighed by its length
 * and fitted over the runs of speech, preferring to break at long pauses. The
 * same dynamic programme that times karaoke words, one level up.
 */
export function placeLinesByLength(texts: string[], analysis: SpeechAnalysis): TimeRange[] {
  const n = texts.length;
  if (!n) return [];
  const segs = analysis.segments;
  if (!segs.length) {
    const step = (analysis.duration || n * 3) / n;
    return texts.map((_, i) => ({ start: i * step, end: (i + 1) * step }));
  }

  // Each line is one "word" to the aligner; its weight comes from its letters.
  const starts = alignWordsToAudio(
    texts.map((t) => t.replace(/\s+/g, "")),
    analysis
  );

  const ranges: TimeRange[] = [];
  for (let i = 0; i < n; i++) {
    const startAt = starts[i];
    const nextAt = i + 1 < n ? starts[i + 1] : analysis.duration;
    const own = segs.filter((s) => s.start >= startAt - 1e-6 && s.start < nextAt - 1e-6);
    const end = own.length ? own[own.length - 1].end : nextAt;
    ranges.push({ start: Math.max(0, startAt - LEAD_PAD), end: Math.min(analysis.duration, end + TAIL_PAD) });
  }
  return finish(ranges, analysis.duration);
}

/** Keeps ranges in order, inside the recording, non-overlapping and not vanishingly short. */
export function finish(ranges: TimeRange[], duration: number): TimeRange[] {
  const out = ranges.map((r) => ({
    start: Math.max(0, Math.min(r.start, duration)),
    end: Math.max(0, Math.min(r.end, duration)),
  }));
  for (let i = 0; i < out.length; i++) {
    if (i > 0 && out[i].start < out[i - 1].end) {
      const mid = (out[i].start + out[i - 1].end) / 2;
      out[i - 1].end = mid;
      out[i].start = mid;
    }
    if (out[i].end - out[i].start < MIN_LINE) {
      out[i].end = Math.min(duration, out[i].start + MIN_LINE);
    }
  }
  return out.map((r) => ({ start: round(r.start), end: round(r.end) }));
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
