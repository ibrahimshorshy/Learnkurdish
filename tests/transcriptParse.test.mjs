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

check("no lines is fine", normalizeTranscript([], 3).lines.length === 0);
check("non-array is fine", normalizeTranscript(null, 3).lines.length === 0);

done("transcript parsing");
