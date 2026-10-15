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
