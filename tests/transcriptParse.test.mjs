import { parseTimestamp, normalizeTranscript, cleanLineText } from "../src/utils/transcript.ts";
import { check, near, done } from "./harness.mjs";

check("number", parseTimestamp(3.25) === 3.25);
check("numeric string", parseTimestamp("3.25") === 3.25);
check("seconds suffix", parseTimestamp("3.5s") === 3.5);
check("mm:ss", parseTimestamp("01:05") === 65);
check("mm:ss.ff", near(parseTimestamp("00:12.50"), 12.5, 1e-9));
check("hh:mm:ss", parseTimestamp("01:00:02") === 3602);
check("comma decimal", parseTimestamp("4,5") === 4.5);
check("garbage is null", parseTimestamp("soon") === null);
check("negative is null", parseTimestamp(-1) === null);

check("strips numbering", cleanLineText("1. چۆنی؟") === "چۆنی؟");
check("strips bullets and quotes", cleanLineText("- «باشم»") === "باشم");
check("strips bidi marks", cleanLineText("‏سوپاس‎") === "سوپاس");

const good = normalizeTranscript(
  [
    { text: "چۆنی؟", start: 0.4, end: 1.2 },
    { text: "باشم، سوپاس", start: "00:01.90", end: "3.1" },
    { text: "  ", start: 3.5, end: 4 },
  ],
  5
);
check("good times are trusted", good.timesTrusted);
check("empty lines are dropped", good.lines.length === 2);
check("string times are read", near(good.lines[1].start, 1.9, 1e-9));

const overlapping = normalizeTranscript(
  [
    { text: "a", start: 0, end: 2 },
    { text: "b", start: 1.5, end: 3 },
  ],
  4
);
check("overlap resolved", overlapping.lines[1].start >= overlapping.lines[0].end);

const zero = normalizeTranscript(
  [
    { text: "a", start: 0, end: 0 },
    { text: "b", start: 0, end: 0 },
  ],
  6
);
check("all-zero times are not trusted", !zero.timesTrusted);
check("untrusted lines are spread evenly", near(zero.lines[1].start, 3, 1e-9));

const beyond = normalizeTranscript([{ text: "a", start: 2, end: 40 }], 10);
check("times past the end are not trusted", !beyond.timesTrusted);

const backwards = normalizeTranscript(
  [
    { text: "a", start: 5, end: 6 },
    { text: "b", start: 1, end: 2 },
  ],
  8
);
check("times running backwards are not trusted", !backwards.timesTrusted);

/* ---------- a known text (the aligned mode): keepText, keepOrder ---------- */

const written = [
  "ئازاد گوتی: «بەیانی دێم.»",
  "«چۆنی؟»",
  'He said "go."',
  "- بۆ کوێ دەچیت؟",
  "1. یەکەم شت.",
];
const kept = normalizeTranscript(
  written.map((text, i) => ({ text: `  ${text.replace(" ", "   ")} `, start: i * 2 + 0.2, end: i * 2 + 1.6 })),
  12,
  { keepText: true }
);
check(
  "keepText: quotes, dashes and list numbers stay as written",
  kept.lines.map((l) => l.text).join("|") === written.join("|"),
  JSON.stringify(kept.lines.map((l) => l.text))
);
check("keepText: whitespace is still tidied", !kept.lines.some((l) => /\s{2}|^\s|\s$/.test(l.text)));
const cleaned = normalizeTranscript([{ text: "«چۆنی؟»", start: 0, end: 1 }], 2);
check("without keepText the model's text is still cleaned", cleaned.lines[0].text === "چۆنی؟");

// Starts that cross a little (within the tolerance) — the reviewer's case.
const crossing = [
  { text: "یەک.", start: 1, end: 3, paragraphStart: true },
  { text: "دوو.", start: 5.3, end: 6, paragraphStart: true },
  { text: "سێ.", start: 5.0, end: 8 },
];
const sorted = normalizeTranscript(crossing, 10);
check("lines mode still sorts by time", sorted.lines.map((l) => l.text).join() === "یەک.,سێ.,دوو.");
const fixed = normalizeTranscript(crossing, 10, { keepOrder: true });
check("keepOrder: still trusted", fixed.timesTrusted);
check("keepOrder: the order of the text is kept", fixed.lines.map((l) => l.text).join() === "یەک.,دوو.,سێ.");
check("keepOrder: the paragraph start stays on its sentence", fixed.lines[1].paragraphStart === true && !fixed.lines[2].paragraphStart);
check(
  "keepOrder: lines in order and not overlapping",
  fixed.lines.every((l, i) => l.end > l.start && (i === 0 || l.start >= fixed.lines[i - 1].end - 1e-9)),
  JSON.stringify(fixed.lines)
);
check("keepOrder: the crossing start is moved up, not before", fixed.lines[2].start >= 5.3 - 1e-9);

const swallowed = normalizeTranscript(
  [
    { text: "a", start: 1, end: 3 },
    { text: "b", start: 5.3, end: 6 },
    { text: "c", start: 5.0, end: 5.2 },
  ],
  10,
  { keepOrder: true }
);
check("keepOrder: a line left with no time of its own makes the times untrusted", !swallowed.timesTrusted);
check("keepOrder: untrusted lines stay in text order", swallowed.lines.map((l) => l.text).join() === "a,b,c");

// A crossing line the model put wholly inside the line before: once moved up,
// all of its time is the previous line's, so it has none of its own.
const contained = normalizeTranscript(
  [
    { text: "a", start: 1, end: 3, paragraphStart: true },
    { text: "b", start: 5.3, end: 8, paragraphStart: true },
    { text: "c", start: 5.0, end: 6 },
  ],
  10,
  { keepOrder: true }
);
check("keepOrder: a crossing line inside the one before makes the times untrusted", !contained.timesTrusted, JSON.stringify(contained.lines));
check(
  "keepOrder: untrusted, the text order and paragraph starts are kept",
  contained.lines.map((l) => l.text).join() === "a,b,c" && contained.lines[1].paragraphStart === true && !contained.lines[2].paragraphStart
);

// The model running a little past the end of the recording (within the
// allowed 5% + 0.5 s): the last two lines both end after it. Clamped to the
// end they would look like one inside the other, but the model's own times
// are in order, so they are trusted and only clamped.
const pastEnd = normalizeTranscript(
  [
    { text: "a", start: 1, end: 20 },
    { text: "b", start: 20.6, end: 27.6 },
    { text: "c", start: 28.3, end: 30.8 },
    { text: "d", start: 30.2, end: 31.5 },
  ],
  30.5,
  { keepOrder: true }
);
check("keepOrder: lines running past the end are still trusted", pastEnd.timesTrusted, JSON.stringify(pastEnd.lines));
check(
  "keepOrder: past the end, clamped into the recording, in order, not overlapping",
  pastEnd.lines.every((l, i) => l.end <= 30.5 && l.end > l.start && (i === 0 || l.start >= pastEnd.lines[i - 1].end - 1e-9)),
  JSON.stringify(pastEnd.lines)
);
check(
  "keepOrder: past the end, the same as without keepOrder",
  JSON.stringify(pastEnd.lines) === JSON.stringify(normalizeTranscript([
    { text: "a", start: 1, end: 20 },
    { text: "b", start: 20.6, end: 27.6 },
    { text: "c", start: 28.3, end: 30.8 },
    { text: "d", start: 30.2, end: 31.5 },
  ], 30.5).lines)
);
const barelyPast = normalizeTranscript(
  [
    { text: "a", start: 1, end: 3 },
    { text: "b", start: 5.3, end: 8 },
    { text: "c", start: 5.0, end: 8.1 },
  ],
  10,
  { keepOrder: true }
);
check("keepOrder: a crossing line ending just after the one before is untrusted", !barelyPast.timesTrusted, JSON.stringify(barelyPast.lines));
const wellPast = normalizeTranscript(
  [
    { text: "a", start: 1, end: 3 },
    { text: "b", start: 5.3, end: 6 },
    { text: "c", start: 5.0, end: 6.5 },
  ],
  10,
  { keepOrder: true }
);
// Starts in order, but the line ends inside the one before: the text says it
// comes after, so the times contradict it.
const nested = normalizeTranscript(
  [
    { text: "a", start: 1, end: 3 },
    { text: "b", start: 5.0, end: 8 },
    { text: "c", start: 5.3, end: 6 },
  ],
  10,
  { keepOrder: true }
);
check("keepOrder: a line ending inside the one before makes the times untrusted", !nested.timesTrusted, JSON.stringify(nested.lines));
check(
  "lines mode is unchanged for a line ending inside the one before",
  normalizeTranscript(
    [
      { text: "a", start: 1, end: 3 },
      { text: "b", start: 5.0, end: 8 },
      { text: "c", start: 5.3, end: 6 },
    ],
    10
  ).timesTrusted
);
const tailOverlap = normalizeTranscript(
  [
    { text: "a", start: 1, end: 3 },
    { text: "b", start: 2.8, end: 5 },
  ],
  10,
  { keepOrder: true }
);
check(
  "keepOrder: an ordinary overlap at the edge is still shared out",
  tailOverlap.timesTrusted && near(tailOverlap.lines[0].end, 2.9, 1e-9) && near(tailOverlap.lines[1].start, 2.9, 1e-9),
  JSON.stringify(tailOverlap.lines)
);
check(
  "keepOrder: a crossing line with time of its own after the one before is kept",
  wellPast.timesTrusted && wellPast.lines.every((l, i) => l.end - l.start >= 0.15 && (i === 0 || l.start >= wellPast.lines[i - 1].end - 1e-9)),
  JSON.stringify(wellPast.lines)
);

const creeping = normalizeTranscript(
  [
    { text: "a", start: 10, end: 11 },
    { text: "b", start: 9.7, end: 12 },
    { text: "c", start: 9.4, end: 13 },
  ],
  20,
  { keepOrder: true }
);
check("keepOrder: a start well before an earlier line's is not trusted", !creeping.timesTrusted);
check(
  "keepOrder: ordered times are left alone",
  JSON.stringify(normalizeTranscript(good.lines, 5, { keepOrder: true }).lines) === JSON.stringify(normalizeTranscript(good.lines, 5).lines)
);

check("no lines is fine", normalizeTranscript([], 3).lines.length === 0);
check("non-array is fine", normalizeTranscript(null, 3).lines.length === 0);

done("transcript parsing");
