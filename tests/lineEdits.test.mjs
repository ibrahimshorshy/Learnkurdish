/**
 * Editing the line list: split, merge and delete, with re-recorded takes and
 * story paragraphs, and the video fingerprint that notices those edits. Pure —
 * the audio is fake RecordingAudio objects carrying only an analysis, and a
 * small AudioBuffer stand-in for the clips videoLinesFrom builds.
 */
import { splitLine, mergeLines, mergeDropsTakes, removeLine, paragraphNumbers, videoLinesFrom, fingerprint } from "../src/lessonActions.ts";
import { linePieces, lineDuration } from "../src/audio/clipBuilder.ts";
import { createProject } from "../src/utils/projectStore.ts";
import { check, near, done } from "./harness.mjs";

// Node has no Web Audio; the clip builder only needs a buffer of samples.
globalThis.AudioBuffer ??= class {
  constructor({ length, numberOfChannels, sampleRate }) {
    this.length = length;
    this.numberOfChannels = numberOfChannels;
    this.sampleRate = sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  getChannelData(c) {
    return this.channels[c];
  }
};

const RATE = 1000;
/** A fake source: an analysis, and silent samples long enough for any clip. */
const source = (segments, duration = 20) => ({
  analysis: { duration, segments },
  gain: 1,
  buffer: new AudioBuffer({ length: duration * RATE, numberOfChannels: 1, sampleRate: RATE }),
  mono: null,
});

function project(kind = "lesson", patch = {}) {
  const p = createProject(kind, ["ar", "en"]);
  return { ...p, ...patch, audioFx: { ...p.audioFx, tightenPauses: false, ...(patch.audioFx ?? {}) } };
}

const line = (id, kurdish, start, end, extra = {}) => ({
  id,
  kurdish,
  start,
  end,
  transliteration: "",
  translations: { en: "x" },
  ...extra,
});

const blob = { size: 1234, type: "audio/webm" };
const processed = { key: "k", blob: { size: 999 } };
const take = { id: "tTAKE", blob, mimeType: "audio/webm", durationSeconds: 4, start: 0.3, end: 3.6, processed };

/* ---------------- split ---------------- */

{
  // "سڵاو چۆنی باشی": the caret after the first word.
  const L = line("l1", "سڵاو چۆنی باشی", 10, 14, { take });
  const takeAudio = source([{ start: 0.35, end: 1.2 }, { start: 1.5, end: 3.4 }], 4);
  const parts = splitLine(L, 4, null, takeAudio);
  check("split: a line with a take splits", Boolean(parts));
  const [a, b] = parts;
  check("split: the first half keeps the take's id, the second gets its own", a.take.id === "tTAKE" && b.take.id !== "tTAKE" && b.take.id);
  check("split: both halves share the recording and its cleaned-up version", a.take.blob === blob && b.take.blob === blob && a.take.processed === processed && b.take.processed === processed);
  check("split: the take is divided at the pause in the take itself", near(a.take.end, 1.35, 1e-9) && near(b.take.start, 1.35, 1e-9), `${a.take.end} ${b.take.start}`);
  check("split: the take's outer edges stay", a.take.start === 0.3 && b.take.end === 3.6);

  const p = project();
  const sources = { main: source([]), takes: new Map([[a.take.id, takeAudio], [b.take.id, takeAudio]]) };
  const pa = linePieces(a, takeAudio, p);
  const pb = linePieces(b, takeAudio, p);
  check("split: the halves play different parts of the take, not the whole of it twice", pa[0].end <= pb[0].start, JSON.stringify([pa, pb]));
  check(
    "split: together the halves last as long as the take did",
    near(lineDuration(a, sources, p) + lineDuration(b, sources, p), take.end - take.start, 1e-9)
  );

  const prop = splitLine(L, 4, null, null);
  const share = 4 / (4 + 9);
  check("split: with the take's audio not loaded, the take is divided in proportion", near(prop[0].take.end, 0.3 + 3.3 * share, 1e-9) && near(prop[1].take.start, prop[0].take.end, 1e-9));
  check("split: the main recording's times are still divided too", near(prop[0].end, 10 + 4 * share, 1e-9) && prop[1].start === prop[0].end && prop[1].end === 14);
  check("split: the original line is not changed", L.take.end === 3.6 && L.kurdish === "سڵاو چۆنی باشی");

  const noTake = splitLine(line("l2", "یەک دوو", 0, 2), 3, null);
  check("split: a line without a take gives halves without one", noTake && !("take" in noTake[0]) && !("take" in noTake[1]));
  check("split: translations are cleared on both halves", Object.keys(noTake[0].translations).length === 0 && Object.keys(noTake[1].translations).length === 0);
}

{
  const story = line("s1", "یەک دوو سێ", 0, 3, { paragraphStart: true });
  const [a, b] = splitLine(story, 3, null);
  check("split: only the first half starts the paragraph", a.paragraphStart === true && !b.paragraphStart);

  const said = line("d1", "یەک دوو", 0, 2, { speaker: 1 });
  const [x, y] = splitLine(said, 3, null);
  check("split: a dialogue speaker says both halves", x.speaker === 1 && y.speaker === 1);
}

/* ---------------- merge ---------------- */

{
  const A = line("a", "یەک", 0, 1);
  const B = line("b", "دوو", 1.2, 2);
  const At = { ...A, take };
  const Bt = { ...B, take: { ...take, id: "tB" } };
  check("merge: lines without takes lose nothing", !mergeDropsTakes(A, B));
  check("merge: either line with a take means the take would go", mergeDropsTakes(At, B) && mergeDropsTakes(A, Bt) && mergeDropsTakes(At, Bt));

  const first = mergeLines(At, B);
  check("merge: the first line's take is not kept for both lines' words", !first.take, first.take?.id);
  const second = mergeLines(A, Bt);
  check("merge: the second line's take is not silently half-kept either", !second.take);
  check("merge: the merged line spans both in the main recording", first.start === 0 && first.end === 2 && first.kurdish === "یەک دوو");
  const p = project();
  const sources = { main: source([]), takes: new Map([["tTAKE", source([], 4)]]) };
  check("merge: the merged line plays both lines' part of the main recording", near(lineDuration(first, sources, p), 2, 1e-9));
}

/* ---------------- delete ---------------- */

{
  const lines = [
    line("a", "یەک", 0, 1, { paragraphStart: true }),
    line("b", "دوو", 1, 2),
    line("c", "سێ", 2, 3, { paragraphStart: true }),
    line("d", "چوار", 3, 4),
    line("e", "پێنج", 4, 5, { paragraphStart: true }),
  ];
  const without = removeLine(lines, 2);
  check("delete: the paragraph's first sentence goes, the mark moves to the next", without.map((l) => l.id).join("") === "abde" && without[2].paragraphStart === true);
  check("delete: the paragraphs stay apart", paragraphNumbers(without).join(",") === "0,0,1,2", paragraphNumbers(without).join(","));
  check("delete: the list given is not changed", lines.length === 5 && !lines[3].paragraphStart);
  const plain = removeLine(lines, 1);
  check("delete: an ordinary sentence moves no marks", plain.map((l) => (l.paragraphStart ? 1 : 0)).join("") === "1101");
  check("delete: a one-sentence paragraph merges nothing", removeLine(lines, 3).map((l) => (l.paragraphStart ? 1 : 0)).join("") === "1011");
  check("delete: the last line", removeLine(lines, 4).length === 4);
  const first = removeLine(lines, 0);
  check("delete: the very first sentence hands the story start on", first[0].id === "b" && first[0].paragraphStart === true);
}

/* ---------------- paragraphs in the video, and the fingerprint ---------------- */

{
  const lines = [
    line("a", "یەک", 0, 1, { paragraphStart: true }),
    line("b", "دوو", 1, 2),
    line("c", "سێ", 2, 3, { skip: true }),
    line("d", "چوار", 3, 4),
  ];
  const sources = { main: source([]), takes: new Map() };
  const base = project("story", { lines });
  const marked = project("story", { lines: lines.map((l) => (l.id === "c" ? { ...l, paragraphStart: true } : l)) });

  const plain = videoLinesFrom(base, sources).map((l) => l.paragraph).join(",");
  const split = videoLinesFrom(marked, sources).map((l) => l.paragraph).join(",");
  check("paragraphs: the skipped line is left out of the video", videoLinesFrom(base, sources).length === 3);
  check("paragraphs: a mark on a skipped line still starts a paragraph in the video", plain === "0,0,0" && split === "0,0,1", `${plain} / ${split}`);
  check("paragraphs: numbered the same way as the video", paragraphNumbers(marked.lines).join(",") === "0,0,1,1");

  const langs = ["ar"];
  check("fingerprint: the mark on a skipped line changes the fingerprint", fingerprint(base, langs) !== fingerprint(marked, langs));

  // The same paragraphs reached another way: the video is the same, and so is the fingerprint.
  const onNext = project("story", { lines: lines.map((l) => (l.id === "d" ? { ...l, paragraphStart: true } : l)) });
  check("fingerprint: the same paragraphs give the same fingerprint", fingerprint(onNext, langs) === fingerprint(marked, langs));

  const both = project("story", {
    lines: lines.map((l) => (l.id === "c" || l.id === "d" ? { ...l, paragraphStart: true } : l)),
  });
  check("fingerprint: a second mark that changes nothing on screen changes nothing", fingerprint(both, langs) === fingerprint(onNext, langs));

  const unskipped = project("story", { lines: marked.lines.map((l) => ({ ...l, skip: false })) });
  check("fingerprint: unskipping a line still changes it", fingerprint(unskipped, langs) !== fingerprint(marked, langs));
}

{
  // Splitting a line that has a take gives a video with the take in two halves, not twice.
  const takeAudio = source([{ start: 0.35, end: 1.2 }, { start: 1.5, end: 3.4 }], 4);
  const L = line("l1", "سڵاو چۆنی باشی", 10, 14, { take });
  const [a, b] = splitLine(L, 4, null, takeAudio);
  const p = project("lesson", { lines: [a, b] });
  const sources = { main: source([]), takes: new Map([[a.take.id, takeAudio], [b.take.id, takeAudio]]) };
  const video = videoLinesFrom(p, sources);
  const total = video.reduce((sum, l) => sum + l.clip.duration, 0);
  check("video: the split take is heard once in all", video.length === 2 && near(total, 3.3, 0.01), total.toFixed(3));
}

done("lineEdits");
