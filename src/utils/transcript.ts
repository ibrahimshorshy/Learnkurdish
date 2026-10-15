/**
 * Turning what the model says it heard into lines with trustworthy times.
 *
 * Asked for timestamps in seconds, a model returns them in whatever shape it
 * likes: 12.5, "12.5", "00:12.50", "0:12", "12.5s", sometimes "01:02:03". It
 * also returns lines out of order, overlapping, past the end of the recording,
 * or all at zero when it could not place them at all. None of that can reach
 * the editor as-is, so everything is read leniently here and then checked.
 *
 * Pure: imported by server.ts, the browser and the tests.
 */

/** Reads a timestamp in any of the shapes models produce. Null when unreadable. */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;

  const text = value.trim().replace(/s(ec(onds?)?)?$/i, "").replace(",", ".").trim();
  if (!text) return null;

  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);

  // [hh:]mm:ss[.fff]
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(text);
  if (match) {
    const hours = match[1] ? Number(match[1]) : 0;
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    if (seconds >= 60 && minutes > 0) return null;
    return hours * 3600 + minutes * 60 + seconds;
  }
  return null;
}

export interface RawTranscriptLine {
  text?: unknown;
  start?: unknown;
  end?: unknown;
  /** Dialogue: 0 or 1. */
  speaker?: unknown;
  /** Story: starts a new paragraph. */
  paragraphStart?: unknown;
}

export interface TranscriptLine {
  text: string;
  start: number;
  end: number;
  speaker?: number;
  paragraphStart?: boolean;
}

/** Keeps the optional per-line fields a mode may set, dropping anything malformed. */
function extras(line: RawTranscriptLine | undefined): Pick<TranscriptLine, "speaker" | "paragraphStart"> {
  const out: Pick<TranscriptLine, "speaker" | "paragraphStart"> = {};
  const speaker = Number(line?.speaker);
  if (line?.speaker !== undefined && line?.speaker !== null && (speaker === 0 || speaker === 1)) out.speaker = speaker;
  if (line?.paragraphStart === true) out.paragraphStart = true;
  return out;
}

export interface NormalizedTranscript {
  lines: TranscriptLine[];
  /**
   * False when the model's times were not usable — missing, all zero, or
   * running backwards. The lines are still returned, spread evenly, and the
   * caller should place them from the audio itself instead.
   */
  timesTrusted: boolean;
}

/** Collapses whitespace and strips the decorations models like to add. */
export function cleanLineText(text: string): string {
  return text
    .replace(/[​‎‏‪-‮⁦-⁩]/g, "")
    .replace(/^\s*(?:\d+[.)]\s+|[-•·*]\s+)/, "")
    .replace(/^["«“]+|["»”]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How a mode's lines are tidied. Both are for a known text (the aligned
 * mode): the words and their order come from the script the teacher wrote,
 * not from the model, so neither may be changed here.
 */
export interface NormalizeOptions {
  /**
   * Keep each line's text as written; only runs of whitespace are tidied.
   * cleanLineText would strip a quote, a dash or a list number the teacher
   * wrote on purpose («چۆنی؟», "- بۆ کوێ؟", "1. ...").
   */
  keepText?: boolean;
  /**
   * Keep the lines in the order given rather than sorting them by time. A
   * start a little before the previous line's (within the tolerance the times
   * are trusted to anyway) is moved up to it. A line left with almost no time
   * the line before does not already cover (one timed wholly inside it) means
   * the times are not usable.
   */
  keepOrder?: boolean;
}

/** How far a start may run before the previous line's and the times still be trusted. */
const ORDER_TOLERANCE = 0.5;
/** keepOrder: a line moved up to its neighbour must keep at least this much time past the end of it. */
const MIN_OWN_TIME = 0.15;

/** Collapses whitespace only: the text is known and kept as written. */
function tidySpaces(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function normalizeTranscript(
  raw: RawTranscriptLine[],
  durationSeconds: number,
  options: NormalizeOptions = {}
): NormalizedTranscript {
  const duration = Math.max(0, durationSeconds || 0);
  const tidy = options.keepText ? tidySpaces : cleanLineText;

  const parsed = (Array.isArray(raw) ? raw : [])
    .map((line) => ({
      text: tidy(String(line?.text ?? "")),
      start: parseTimestamp(line?.start),
      end: parseTimestamp(line?.end),
      ...extras(line),
    }))
    .filter((line) => line.text.length > 0);

  if (!parsed.length) return { lines: [], timesTrusted: true };

  // Spread the lines evenly so the editor still has something to show; the
  // caller is expected to place them from the audio.
  const untrusted = (): NormalizedTranscript => {
    const span = duration > 0 ? duration : parsed.length * 3;
    const step = span / parsed.length;
    return {
      lines: parsed.map((line, i) => ({
        ...line,
        start: i * step,
        end: (i + 1) * step,
      })),
      timesTrusted: false,
    };
  };

  // Times are only worth keeping if nearly all of them are readable, in order,
  // inside the recording and not piled up at zero.
  const readable = parsed.filter(
    (l) => l.start !== null && l.end !== null && (l.end as number) > (l.start as number)
  );
  const limit = duration > 0 ? duration * 1.05 + 0.5 : Infinity;
  const inside = readable.filter((l) => (l.end as number) <= limit);
  let ordered = true;
  if (options.keepOrder) {
    // The order is fixed, so every start must keep up with all the ones
    // before it, not only with its neighbour.
    let latest = -Infinity;
    for (const l of readable) {
      if ((l.start as number) + ORDER_TOLERANCE < latest) ordered = false;
      latest = Math.max(latest, l.start as number);
    }
  } else {
    for (let i = 1; i < readable.length; i++) {
      if ((readable[i].start as number) + ORDER_TOLERANCE < (readable[i - 1].start as number)) ordered = false;
    }
  }
  const allAtZero = readable.length > 1 && readable.every((l) => (l.start as number) < 0.01);

  const timesTrusted =
    duration > 0 &&
    readable.length === parsed.length &&
    inside.length === parsed.length &&
    ordered &&
    !allAtZero;

  if (!timesTrusted) return untrusted();

  const lines = parsed.map((line) => ({
    ...line,
    start: Math.min(line.start as number, duration),
    end: Math.min(line.end as number, duration),
  }));

  if (options.keepOrder) {
    // The text says which line comes first; a start slightly before the
    // previous one is the model being imprecise, so it is moved up to it and
    // the overlap pass below shares out the time. Sorting instead would put
    // a later sentence before an earlier one, and a paragraph start with it.
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1];
      const cur = lines[i];
      const crossed = cur.start < prev.start;
      if (crossed) cur.start = prev.start;
      // A line's own time is what the line before does not already cover. One
      // the model put wholly inside the line before has none, which the text
      // order rules out, and the overlap pass could only leave it a sliver
      // that still overlaps. A line moved up needs a little more than none.
      const own = cur.end - Math.max(cur.start, prev.end);
      if (crossed ? own < MIN_OWN_TIME : own <= 0) return untrusted();
    }
  } else {
    lines.sort((a, b) => a.start - b.start);
  }

  // Overlap: give the boundary to the midpoint of the overlap.
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const cur = lines[i];
    if (cur.start < prev.end) {
      const mid = (cur.start + prev.end) / 2;
      prev.end = Math.max(prev.start + 0.05, mid);
      cur.start = Math.min(cur.end - 0.05, Math.max(mid, prev.end));
    }
  }

  return { lines, timesTrusted: true };
}
