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
}

export interface TranscriptLine {
  text: string;
  start: number;
  end: number;
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

export function normalizeTranscript(raw: RawTranscriptLine[], durationSeconds: number): NormalizedTranscript {
  const duration = Math.max(0, durationSeconds || 0);

  const parsed = (Array.isArray(raw) ? raw : [])
    .map((line) => ({
      text: cleanLineText(String(line?.text ?? "")),
      start: parseTimestamp(line?.start),
      end: parseTimestamp(line?.end),
    }))
    .filter((line) => line.text.length > 0);

  if (!parsed.length) return { lines: [], timesTrusted: true };

  // Times are only worth keeping if nearly all of them are readable, in order,
  // inside the recording and not piled up at zero.
  const readable = parsed.filter(
    (l) => l.start !== null && l.end !== null && (l.end as number) > (l.start as number)
  );
  const limit = duration > 0 ? duration * 1.05 + 0.5 : Infinity;
  const inside = readable.filter((l) => (l.end as number) <= limit);
  let ordered = true;
  for (let i = 1; i < readable.length; i++) {
    if ((readable[i].start as number) + 0.5 < (readable[i - 1].start as number)) ordered = false;
  }
  const allAtZero = readable.length > 1 && readable.every((l) => (l.start as number) < 0.01);

  const timesTrusted =
    duration > 0 &&
    readable.length === parsed.length &&
    inside.length === parsed.length &&
    ordered &&
    !allAtZero;

  if (!timesTrusted) {
    // Spread the lines evenly so the editor still has something to show; the
    // caller is expected to place them from the audio.
    const span = duration > 0 ? duration : parsed.length * 3;
    const step = span / parsed.length;
    return {
      lines: parsed.map((line, i) => ({
        text: line.text,
        start: i * step,
        end: (i + 1) * step,
      })),
      timesTrusted: false,
    };
  }

  const lines = parsed
    .map((line) => ({
      text: line.text,
      start: Math.min(line.start as number, duration),
      end: Math.min(line.end as number, duration),
    }))
    .sort((a, b) => a.start - b.start);

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
