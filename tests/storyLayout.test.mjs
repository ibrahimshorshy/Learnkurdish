import {
  paragraphGroups,
  paginate,
  withPauses,
  lineSpans,
  pageWindows,
  pageAt,
  pageAlpha,
  sentenceState,
  wordsSpoken,
  wordDirections,
  placeLine,
} from "../src/render/storyLayout.ts";
import { firstStrongDirection, isRtlText } from "../src/render/textLayout.ts";
import { buildTimeline, eventAt } from "../src/render/timeline.ts";
import { check, near, done } from "./harness.mjs";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- paragraphs ---------- */

check("groups consecutive paragraph numbers", same(paragraphGroups([0, 0, 2, 2, 2, 5]), [[0, 1], [2, 3, 4], [5]]));
check("a return to an earlier number is a new group", same(paragraphGroups([0, 1, 0]), [[0], [1], [2]]));
check("no lines, no groups", paragraphGroups([]).length === 0);

/* ---------- pages ---------- */

// Sentences of these heights; a page holds up to 10.
const heights = [4, 4, 4, 4, 4];
const sum = (a, b) => heights.slice(a, b + 1).reduce((x, y) => x + y, 0);
const pages = paginate(heights.length, (a, b) => sum(a, b) <= 10, sum);
check("fewest pages", pages.length === 3, JSON.stringify(pages));
check("pages cover every sentence once, in order", same(pages.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i)), [0, 1, 2, 3, 4]));

const uneven = [3, 3, 3, 3, 3, 3, 3];
const sumU = (a, b) => uneven.slice(a, b + 1).reduce((x, y) => x + y, 0);
const balanced = paginate(uneven.length, (a, b) => sumU(a, b) <= 15, sumU);
check("balanced: 7 sentences into 2 pages of 4 and 3, not 5 and 2", same(balanced, [[0, 3], [4, 6]]), JSON.stringify(balanced));

check("everything fits: one page", same(paginate(3, () => true, () => 1), [[0, 2]]));
check("nothing fits together: one sentence per page", same(paginate(3, () => false, () => 1), [[0, 0], [1, 1], [2, 2]]));
check("one sentence", same(paginate(1, () => false, () => 99), [[0, 0]]));
check("no sentences", paginate(0, () => true, () => 1).length === 0);

const giant = [2, 30, 2, 2];
const sumG = (a, b) => giant.slice(a, b + 1).reduce((x, y) => x + y, 0);
const withGiant = paginate(giant.length, (a, b) => sumG(a, b) <= 10, sumG);
check("a sentence too big for any page gets its own", withGiant.some(([a, b]) => a === 1 && b === 1), JSON.stringify(withGiant));

let calls = 0;
paginate(12, (a, b) => (calls++, b - a < 3), (a, b) => b - a);
check("measurements are memoised", calls < 80, String(calls));

/* ---------- pauses ---------- */

const base = buildTimeline({
  clipDurations: [1, 1, 1],
  plays: 1,
  repeatGapMode: "off",
  repeatGapSeconds: 2,
  gapBetweenLines: 0.3,
  intro: false,
  outro: false,
});
const paused = withPauses(base, [0.7, 0, 0]);
check("total grows by the pauses", near(paused.total, base.total + 0.7, 1e-9));
const gap0 = paused.events.find((e) => e.type === "gap" && e.line === 0);
check("the existing gap is lengthened", near(gap0.end - gap0.start, 1.0, 1e-9));
const play1 = paused.events.find((e) => e.type === "play" && e.line === 1);
check("the next line starts later", near(play1.start, 2.0, 1e-9));
let contiguous = true;
for (let i = 1; i < paused.events.length; i++) if (!near(paused.events[i].start, paused.events[i - 1].end, 1e-9)) contiguous = false;
check("events stay contiguous", contiguous);
check("eventAt still works", eventAt(paused, 1.5).type === "gap" && eventAt(paused, 2.1).line === 1);

const noGaps = buildTimeline({ clipDurations: [1, 1], plays: 1, repeatGapMode: "off", repeatGapSeconds: 2, gapBetweenLines: 0, intro: false, outro: false });
const inserted = withPauses(noGaps, [0.5]);
check("a gap is added where there was none", inserted.events.some((e) => e.type === "gap" && e.line === 0 && near(e.end - e.start, 0.5, 1e-9)));
check("and the second line moves", near(inserted.events.find((e) => e.type === "play" && e.line === 1).start, 1.5, 1e-9));

const repeated = buildTimeline({ clipDurations: [1, 1], plays: 2, repeatGapMode: "fixed", repeatGapSeconds: 1, gapBetweenLines: 0.2, intro: false, outro: false });
const repeatedPaused = withPauses(repeated, [0.4]);
check("with repeats, the pause goes after the last turn", near(repeatedPaused.total, repeated.total + 0.4, 1e-9));
check("repeat plays of a line are not delayed", near(repeatedPaused.events.filter((e) => e.line === 0 && e.type === "play")[1].start, 2, 1e-9));
check("no pauses: unchanged", same(withPauses(base, [0, 0, 0]), base));

/* ---------- spans and windows ---------- */

const spans = lineSpans(paused, 3);
check("span of line 0", near(spans[0].start, 0, 1e-9) && near(spans[0].end, 1, 1e-9));
check("span of line 1 starts after the pause", near(spans[1].start, 2.0, 1e-9));
check("spans with repeats include the turns", near(lineSpans(repeated, 2)[0].end, 4, 1e-9));

const pageList = [
  { first: 0, last: 0 },
  { first: 1, last: 2 },
];
const windows = pageWindows(pageList, spans, 0.3, 0.25);
check("first page starts at 0 and fades in", windows[0].start === 0 && windows[0].fadeIn === 0.25);
check("handover halfway through the silence", near(windows[0].end, 1.5, 1e-9) && near(windows[1].start, 1.5, 1e-9));
check("fades fit the silence", windows[0].fadeOut === 0.3 && windows[1].fadeIn === 0.3);
check("last page never ends", windows[1].end === Infinity);
check("pageAt before the handover", pageAt(windows, 1.4) === 0);
check("pageAt after the handover", pageAt(windows, 1.6) === 1);
check("pageAt long after the end", pageAt(windows, 999) === 1);
check("fully visible mid-page", pageAlpha(windows[0], 0.6) === 1);
check("fading in at the start", near(pageAlpha(windows[0], 0.125), 0.5, 1e-9));
check("gone at the handover", pageAlpha(windows[0], 1.5) === 0 && pageAlpha(windows[1], 1.5) === 0);
check("half faded out", near(pageAlpha(windows[0], 1.35), 0.5, 1e-9));
check("the new page is in before the voice", pageAlpha(windows[1], spans[1].start) === 1);

const tight = pageWindows(pageList, [{ start: 0, end: 1 }, { start: 1.1, end: 2 }, { start: 2, end: 3 }], 0.3);
check("a short silence shortens the fades", near(tight[0].fadeOut, 0.05, 1e-9));
const none = pageWindows(pageList, [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }], 0.3);
check("no silence: a cut", none[0].fadeOut === 0 && pageAlpha(none[1], 1) === 1);
check("no pages", pageWindows([], [], 0.3).length === 0);

/* ---------- sentences and words ---------- */

check("sentence states", sentenceState(1, 2) === "past" && sentenceState(2, 2) === "current" && sentenceState(3, 2) === "future");
check("before anything is read, all future", sentenceState(0, -1) === "future");
check("words spoken", wordsSpoken([0, 0.5, 1], 0.6) === 2 && wordsSpoken([0, 0.5, 1], -1) === 0 && wordsSpoken([0, 0.5, 1], 5) === 3);
check("no timings", wordsSpoken(null, 1) === 0);

/* ---------- mixed directions ---------- */

check("first strong: Kurdish", firstStrongDirection("«چۆنی؟»") === "rtl");
check("first strong: English", firstStrongDirection("(Hello) سڵاو") === "ltr");
check("first strong: English with a Kurdish word later", firstStrongDirection("The word سڵاو means hello") === "ltr");
check("first strong: digits and punctuation have none", firstStrongDirection("1997 — ٣.٥!") === null && firstStrongDirection("") === null);
check("isRtlText is unchanged (any right-to-left letter)", isRtlText("The word سڵاو means hello") === true);

const dirsOf = (text, base, groups) => wordDirections(text.split(" "), base, groups).join(",");
check("directions: a Latin name in Kurdish", dirsOf("کتێبی J. K. Rowling خوێندەوە.", "rtl") === "rtl,ltr,ltr,ltr,rtl");
check("directions: a number after a Latin word goes with it", dirsOf("لە New York 1997 دەژیا.", "rtl") === "rtl,ltr,ltr,ltr,rtl");
check("directions: a number between Kurdish words stays Kurdish", dirsOf("ساڵی 1997 Rowling هات.", "rtl") === "rtl,rtl,ltr,rtl");
check("directions: Arabic-Indic digits after Latin stay with the Kurdish", dirsOf("Rowling ١٩٩٧ هات.", "rtl") === "ltr,rtl,rtl");
check("directions: a dash between two Latin words joins them", dirsOf("لە New — York", "rtl") === "rtl,ltr,ltr,ltr");
check("directions: a Kurdish phrase in English", dirsOf("He said «ئێوە چۆنن» today.", "ltr") === "ltr,ltr,rtl,rtl,ltr");
check("directions: a number after Kurdish in English goes with it", dirsOf("He said ئێوە 5 today", "ltr") === "ltr,ltr,rtl,rtl,ltr");
check(
  "directions: sentences do not lean on each other",
  wordDirections(["Rowling", "—", "Harry"], "rtl", [0, 1, 1]).join() === "ltr,rtl,ltr"
);

// placeLine with a pretend font: every character 10 wide, a space 5.
const measureChars = (t) => [...t].length * 10;
function laidOut(words, base, groups) {
  const dirs = wordDirections(words, base, groups);
  let offset = 0;
  const boxes = words.map((text, i) => {
    const width = measureChars(text);
    const box = base === "rtl"
      ? { left: 1000 - offset - width, right: 1000 - offset }
      : { left: offset, right: offset + width };
    offset += width + 5;
    return { text, ...box, dir: dirs[i], group: groups?.[i] ?? 0 };
  });
  return { boxes, pieces: placeLine(boxes, base, measureChars) };
}
const visual = (pieces) => [...pieces].sort((a, b) => a.left - b.left).map((p) => p.text).join(" ");

const rowling = laidOut(["کتێبی", "J.", "K.", "Rowling،", "خوێندەوە."], "rtl");
check(
  "a Latin run in Kurdish reads in its own order",
  visual(rowling.pieces) === "خوێندەوە. ، J. K. Rowling کتێبی",
  visual(rowling.pieces)
);
check(
  "the run's words are drawn left to right, its trailing comma right to left",
  rowling.pieces.filter((p) => p.dir === "ltr").map((p) => p.text).join() === "J.,K.,Rowling" &&
    rowling.pieces.find((p) => p.text === "،").dir === "rtl"
);
check("the comma keeps its word's colour", rowling.pieces.find((p) => p.text === "،").word === 3);
check(
  "the run keeps exactly the room its words had",
  (() => {
    const run = rowling.pieces.filter((p) => p.word >= 1 && p.word <= 3);
    const left = Math.min(...run.map((p) => p.left));
    const right = Math.max(...run.map((p) => p.right));
    return Math.abs(left - rowling.boxes[3].left) < 1e-9 && Math.abs(right - rowling.boxes[1].right) < 1e-9;
  })()
);
check(
  "pieces never overlap",
  [...rowling.pieces].sort((a, b) => a.left - b.left).every((p, i, all) => i === 0 || p.left >= all[i - 1].right - 1e-9)
);
check(
  "every word is still there, in reading order of the sentence",
  rowling.pieces.map((p) => p.word).sort().join() === "0,1,2,3,3,4"
);

const brackets = laidOut(["لە", "(New", "York)", "دەژی."], "rtl");
check("brackets go to the run's outer ends", visual(brackets.pieces) === "دەژی. ) New York ( لە", visual(brackets.pieces));

const english = laidOut(["He", "said", "«ئێوە", "چۆنن»", "today."], "ltr");
check("a Kurdish phrase in English reads right to left", visual(english.pieces) === "He said « چۆنن ئێوە » today.", visual(english.pieces));
check("its words are drawn right to left", english.pieces.filter((p) => p.dir === "rtl").map((p) => p.text).join() === "چۆنن,ئێوە");

const plain = laidOut(["ئەو", "لە", "Facebook", "کار", "دەکات."], "rtl");
check(
  "one foreign word, or none: every word stays exactly where it was",
  plain.pieces.length === plain.boxes.length &&
    plain.pieces.every((p, i) => p.word === i && p.left === plain.boxes[i].left && p.right === plain.boxes[i].right && p.dir === "rtl")
);

const twoSentences = laidOut(["Rowling.", "Harry", "Potter"], "rtl", [0, 1, 1]);
check(
  "a run never crosses into the next sentence",
  visual(twoSentences.pieces) === "Harry Potter Rowling.",
  visual(twoSentences.pieces)
);

done("story layout");
