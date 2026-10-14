/**
 * The shape of a lesson in time.
 *
 * Each line is your own voice, played one or more times. After every play the
 * video can leave a silence for the viewer to say the line back — their turn —
 * and that silence is, by default, as long as the line itself, because that is
 * how long it takes to say it.
 *
 *   intro → [ play · turn · play · turn ] → gap → [ next line ] … → outro
 *
 * Pure, so the tests can check it without a browser.
 */

export type RepeatGapMode = "off" | "auto" | "fixed";

export interface TimelineInput {
  /** Length of each line's clip, in seconds, in order. */
  clipDurations: number[];
  /** How many times each line is played, 1 to 3. */
  plays: number;
  repeatGapMode: RepeatGapMode;
  /** Used when the mode is "fixed". */
  repeatGapSeconds: number;
  /** Silence between one line and the next. */
  gapBetweenLines: number;
  intro: boolean;
  outro: boolean;
  introSeconds?: number;
  outroSeconds?: number;
}

export type TimelineEventType = "intro" | "play" | "turn" | "gap" | "outro";

export interface TimelineEvent {
  type: TimelineEventType;
  start: number;
  end: number;
  /** Index into the rendered lines. */
  line?: number;
  /** 0-based play number within the line. */
  play?: number;
}

export interface Timeline {
  events: TimelineEvent[];
  total: number;
}

/** Without a turn, plays of the same line still need a breath between them. */
const BREATH_BETWEEN_PLAYS = 0.6;

/** How long the viewer gets to repeat a line of this length. */
export function turnLength(clipSeconds: number, mode: RepeatGapMode, fixedSeconds: number): number {
  if (mode === "off") return 0;
  if (mode === "fixed") return Math.max(0.3, Math.min(10, fixedSeconds));
  return Math.max(1.2, Math.min(8, clipSeconds + 0.4));
}

export function buildTimeline(input: TimelineInput): Timeline {
  const plays = Math.max(1, Math.min(3, Math.round(input.plays) || 1));
  const introSeconds = input.introSeconds ?? 2.6;
  const outroSeconds = input.outroSeconds ?? 3.2;
  const between = Math.max(0, input.gapBetweenLines);
  const events: TimelineEvent[] = [];
  let t = 0;

  const push = (event: Omit<TimelineEvent, "start" | "end">, length: number) => {
    if (length <= 0) return;
    events.push({ ...event, start: t, end: t + length });
    t += length;
  };

  if (input.intro) push({ type: "intro" }, introSeconds);

  const count = input.clipDurations.length;
  for (let line = 0; line < count; line++) {
    const clip = Math.max(0.05, input.clipDurations[line] || 0);
    const turn = turnLength(clip, input.repeatGapMode, input.repeatGapSeconds);

    for (let play = 0; play < plays; play++) {
      push({ type: "play", line, play }, clip);
      if (turn > 0) push({ type: "turn", line, play }, turn);
      else if (play < plays - 1) push({ type: "turn", line, play }, BREATH_BETWEEN_PLAYS);
    }
    if (line < count - 1) push({ type: "gap", line }, between);
  }

  if (input.outro) push({ type: "outro" }, outroSeconds);
  else push({ type: "gap", line: Math.max(0, count - 1) }, 0.6);

  return { events, total: t };
}

/** The event under a moment in time; the last one past the end. */
export function eventAt(timeline: Timeline, t: number): TimelineEvent | undefined {
  const { events } = timeline;
  if (!events.length) return undefined;
  // Binary search: events are contiguous and ordered.
  let lo = 0;
  let hi = events.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (events[mid].start <= t) lo = mid;
    else hi = mid - 1;
  }
  return events[lo];
}
