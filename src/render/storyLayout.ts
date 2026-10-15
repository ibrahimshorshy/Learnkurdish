/**
 * The arithmetic behind the story video, kept apart from the drawing so it can
 * be tested without a browser: which sentences make a paragraph, how a long
 * paragraph is cut into pages, the extra breath between paragraphs, and when
 * each page is on screen.
 *
 * Pure: imported by ./renderStory and the tests.
 */

import type { Timeline, TimelineEvent } from "./timeline";

/**
 * Groups consecutive lines that share a paragraph number. The numbers need not
 * be contiguous — a skipped line can leave a gap — only a change counts.
 */
export function paragraphGroups(paragraphOf: number[]): number[][] {
  const groups: number[][] = [];
  paragraphOf.forEach((paragraph, i) => {
    if (i === 0 || paragraph !== paragraphOf[i - 1]) groups.push([]);
    groups[groups.length - 1].push(i);
  });
  return groups;
}

/**
 * Cuts `count` sentences into pages of whole sentences.
 *
 * First the fewest pages that fit (greedy: each page takes sentences until the
 * next would not fit). Then, keeping that number of pages, the split that
 * makes the fullest page as empty as possible — so a long paragraph becomes
 * two even pages rather than a full one and a lone last sentence.
 *
 * `fits(a, b)` and `cost(a, b)` take inclusive sentence indices. A single
 * sentence is always a page, whether it fits or not: there is nowhere else to
 * put it.
 */
export function paginate(
  count: number,
  fits: (from: number, to: number) => boolean,
  cost: (from: number, to: number) => number
): [number, number][] {
  if (count <= 0) return [];
  const memoFits = new Map<number, boolean>();
  const memoCost = new Map<number, number>();
  const key = (a: number, b: number) => a * 100003 + b;
  const ok = (a: number, b: number) => {
    if (a === b) return true;
    const k = key(a, b);
    if (!memoFits.has(k)) memoFits.set(k, fits(a, b));
    return memoFits.get(k)!;
  };
  const price = (a: number, b: number) => {
    const k = key(a, b);
    if (!memoCost.has(k)) memoCost.set(k, cost(a, b));
    return memoCost.get(k)!;
  };

  const greedy: [number, number][] = [];
  for (let a = 0; a < count; ) {
    let b = a;
    while (b + 1 < count && ok(a, b + 1)) b++;
    greedy.push([a, b]);
    a = b + 1;
  }
  const pages = greedy.length;
  if (pages <= 1 || pages === count) return greedy;

  // best[p][j]: the smallest possible fullest page when the first j sentences
  // make p pages. from[p][j]: where the last of those pages starts.
  const best: number[][] = Array.from({ length: pages + 1 }, () => new Array(count + 1).fill(Infinity));
  const from: number[][] = Array.from({ length: pages + 1 }, () => new Array(count + 1).fill(-1));
  best[0][0] = 0;
  for (let p = 1; p <= pages; p++) {
    for (let j = p; j <= count; j++) {
      for (let i = p - 1; i < j; i++) {
        if (best[p - 1][i] === Infinity || !ok(i, j - 1)) continue;
        const worst = Math.max(best[p - 1][i], price(i, j - 1));
        // On a tie the later break wins: earlier pages take the extra
        // sentence, the way a book fills its pages.
        if (worst <= best[p][j]) {
          best[p][j] = worst;
          from[p][j] = i;
        }
      }
    }
  }
  if (best[pages][count] === Infinity) return greedy;

  const out: [number, number][] = [];
  let j = count;
  for (let p = pages; p >= 1; p--) {
    const i = from[p][j];
    out.unshift([i, j - 1]);
    j = i;
  }
  return out;
}

/**
 * Adds `pauseAfter[i]` seconds of silence between line i and line i + 1,
 * lengthening the gap that is already there or adding one where there is
 * none. Everything after it moves later; the shape stays what eventAt expects
 * (contiguous, in order).
 */
export function withPauses(base: Timeline, pauseAfter: number[]): Timeline {
  const events: TimelineEvent[] = [];
  let shift = 0;
  for (const e of base.events) {
    const line = e.line ?? -1;
    if (e.type === "play" && e.play === 0 && line > 0) {
      const extra = Math.max(0, pauseAfter[line - 1] || 0);
      if (extra > 0) {
        const prev = events[events.length - 1];
        if (prev && prev.type === "gap" && prev.line === line - 1) {
          prev.end += extra;
        } else {
          const at = e.start + shift;
          events.push({ type: "gap", line: line - 1, start: at, end: at + extra });
        }
        shift += extra;
      }
    }
    events.push({ ...e, start: e.start + shift, end: e.end + shift });
  }
  return { events, total: base.total + shift };
}

/** When a line's own sound starts, and when the last of it ends (its turn included, the gap after not). */
export function lineSpans(timeline: Timeline, count: number): { start: number; end: number }[] {
  const spans = Array.from({ length: count }, () => ({ start: Infinity, end: -Infinity }));
  for (const e of timeline.events) {
    if (e.line === undefined || e.line < 0 || e.line >= count) continue;
    if (e.type !== "play" && e.type !== "turn") continue;
    spans[e.line].start = Math.min(spans[e.line].start, e.start);
    spans[e.line].end = Math.max(spans[e.line].end, e.end);
  }
  return spans.map((s) => (Number.isFinite(s.start) ? s : { start: 0, end: 0 }));
}

export interface PageWindow {
  /** When the page takes the screen, and when it gives it up. */
  start: number;
  end: number;
  /** Seconds it takes to fade in after `start`, and out before `end`. */
  fadeIn: number;
  fadeOut: number;
}

/**
 * When each page is on screen. A page hands over to the next halfway through
 * the silence between its last sentence and the next page's first, fading out
 * in the first half of that silence and the new page in during the second —
 * so a page never changes while the voice is still reading from it.
 */
export function pageWindows(
  pages: { first: number; last: number }[],
  spans: { start: number; end: number }[],
  fade: number,
  firstFade = fade
): PageWindow[] {
  const windows: PageWindow[] = pages.map(() => ({ start: 0, end: Infinity, fadeIn: 0, fadeOut: 0 }));
  if (!pages.length) return windows;
  windows[0].fadeIn = Math.max(0, firstFade);
  for (let p = 0; p + 1 < pages.length; p++) {
    const silenceStart = spans[pages[p].last]?.end ?? 0;
    const silenceEnd = Math.max(silenceStart, spans[pages[p + 1].first]?.start ?? silenceStart);
    const handover = (silenceStart + silenceEnd) / 2;
    const f = Math.max(0, Math.min(fade, (silenceEnd - silenceStart) / 2));
    windows[p].end = handover;
    windows[p].fadeOut = f;
    windows[p + 1].start = handover;
    windows[p + 1].fadeIn = f;
  }
  return windows;
}

/** The page on screen at `t`. */
export function pageAt(windows: PageWindow[], t: number): number {
  for (let p = 0; p < windows.length; p++) if (t < windows[p].end) return p;
  return Math.max(0, windows.length - 1);
}

/** How visible a page is at `t`, 0..1, before easing. */
export function pageAlpha(window: PageWindow, t: number): number {
  const fadeIn = window.fadeIn > 0 ? (t - window.start) / window.fadeIn : 1;
  const fadeOut = window.fadeOut > 0 && Number.isFinite(window.end) ? (window.end - t) / window.fadeOut : 1;
  return Math.max(0, Math.min(1, fadeIn, fadeOut));
}

export type SentenceState = "past" | "current" | "future";

/** A sentence relative to the line being read (-1 before the first). */
export function sentenceState(sentence: number, current: number): SentenceState {
  if (sentence < current) return "past";
  if (sentence === current) return "current";
  return "future";
}

/** Karaoke: how many words have started by `local` seconds into the clip. */
export function wordsSpoken(starts: number[] | null | undefined, local: number): number {
  if (!starts) return 0;
  let count = 0;
  while (count < starts.length && starts[count] <= local) count++;
  return count;
}
