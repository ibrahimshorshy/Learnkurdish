/**
 * Line boundaries against recordings whose real sentence breaks are known,
 * because they were built here: bursts of "speech" (shaped noise, with short
 * word gaps inside) separated by sentence pauses.
 */
import { analyzeSpeech } from "../src/render/audioAlign.ts";
import { snapLinesToPauses, placeLinesByLength, pausesOf, finish, LEFT_OUT_MARGIN } from "../src/audio/segmentation.ts";
import { check, near, done } from "./harness.mjs";

const RATE = 16000;

/** plan: array of { speech: [wordSeconds...] } or { pause: seconds }. Returns samples and the true line spans. */
function synth(plan, { floor = 0.002, seed = 3 } = {}) {
  let rand = seed;
  const noise = () => {
    rand = (rand * 1103515245 + 12345) & 0x7fffffff;
    return rand / 0x7fffffff - 0.5;
  };
  const chunks = [];
  const lines = [];
  let t = 0;
  for (const part of plan) {
    if (part.pause) {
      const n = Math.round(part.pause * RATE);
      chunks.push(Float32Array.from({ length: n }, () => noise() * floor));
      t += part.pause;
    } else {
      const start = t;
      part.speech.forEach((word, i) => {
        const n = Math.round(word * RATE);
        chunks.push(
          Float32Array.from({ length: n }, (_, k) => {
            const env = Math.sin((Math.PI * k) / n);
            return noise() * 0.9 * env + noise() * floor;
          })
        );
        t += word;
        if (i < part.speech.length - 1) {
          const g = Math.round(0.06 * RATE); // a short gap between words
          chunks.push(Float32Array.from({ length: g }, () => noise() * floor));
          t += 0.06;
        }
      });
      lines.push({ start, end: t });
    }
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const samples = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    samples.set(c, o);
    o += c.length;
  }
  return { samples, lines, duration: total / RATE };
}

const plan = [
  { pause: 0.6 },
  { speech: [0.3, 0.25, 0.4] },
  { pause: 0.9 },
  { speech: [0.35, 0.3] },
  { pause: 1.1 },
  { speech: [0.2, 0.45, 0.3, 0.25] },
  { pause: 0.8 },
];
const { samples, lines: truth, duration } = synth(plan);
const analysis = analyzeSpeech(samples, RATE);

check("analysis finds speech", analysis.segments.length >= 3, `segments=${analysis.segments.length}`);
const pauses = pausesOf(analysis);
check("the two sentence pauses are found", pauses.filter((p) => p.end - p.start > 0.5).length === 2,
  JSON.stringify(pauses));

// The model's times are off by up to ~0.5s in both directions.
const modelTimes = [
  { start: truth[0].start + 0.3, end: truth[0].end - 0.4 },
  { start: truth[1].start - 0.5, end: truth[1].end + 0.45 },
  { start: truth[2].start + 0.2, end: truth[2].end - 0.3 },
];
const snapped = snapLinesToPauses(modelTimes, analysis);

for (let i = 0; i < truth.length; i++) {
  check(
    `line ${i + 1} snapped start covers the first word`,
    snapped[i].start <= truth[i].start + 0.02 && snapped[i].start >= truth[i].start - 0.35,
    `got ${snapped[i].start.toFixed(2)}, truth ${truth[i].start.toFixed(2)}`
  );
  check(
    `line ${i + 1} snapped end covers the last word`,
    snapped[i].end >= truth[i].end - 0.02 && snapped[i].end <= truth[i].end + 0.4,
    `got ${snapped[i].end.toFixed(2)}, truth ${truth[i].end.toFixed(2)}`
  );
}
check("snapped lines do not overlap", snapped.every((r, i) => i === 0 || r.start >= snapped[i - 1].end));

// No times at all: placed by length over the pauses.
const placed = placeLinesByLength(["ئەمە یەکەمە", "باشم", "زۆر سوپاس بۆ هەمووتان"], analysis);
check("placed by length: three lines", placed.length === 3);
for (let i = 0; i < truth.length; i++) {
  check(
    `placed line ${i + 1} lands on its sentence`,
    near(placed[i].start, truth[i].start, 0.35) && near(placed[i].end, truth[i].end, 0.4),
    `got ${placed[i].start.toFixed(2)}–${placed[i].end.toFixed(2)}, truth ${truth[i].start.toFixed(2)}–${truth[i].end.toFixed(2)}`
  );
}

// A boundary inside one sentence (model split a sentence oddly) must not steal a later pause twice.
const crowded = snapLinesToPauses(
  [
    { start: 0.5, end: 1.2 },
    { start: 1.2, end: 1.8 },
    { start: 1.8, end: 3.0 },
    { start: 3.0, end: duration },
  ],
  analysis
);
check("four lines over three sentences stay ordered",
  crowded.every((r, i) => r.end > r.start && (i === 0 || r.start >= crowded[i - 1].end - 1e-9)),
  JSON.stringify(crowded));

// finish(): clamps, orders and gives a minimum length.
const fixed = finish([{ start: -1, end: 0.1 }, { start: 0.05, end: 9 }], 5);
check("finish clamps into the recording", fixed[0].start === 0 && fixed[1].end === 5);
check("finish removes overlap", fixed[1].start >= fixed[0].end);

// Silence only: nothing to snap to, lines left alone.
const silent = analyzeSpeech(new Float32Array(RATE * 2), RATE);
const untouched = snapLinesToPauses([{ start: 0.2, end: 1.4 }], silent);
check("silence leaves lines usable", untouched.length === 1 && untouched[0].end > untouched[0].start);

/* ---------- speech the model left out between two lines ---------- */

// Hand-made analyses: the speech runs are exactly these.
const runsAt = (spans, duration) => ({ duration, segments: spans.map(([start, end]) => ({ start, end })) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A remark ("sorry, again") between two sentences, which the model left out.
const remark = snapLinesToPauses(
  [{ start: 1, end: 5 }, { start: 11, end: 15 }],
  runsAt([[1, 5], [6.5, 9.5], [11, 15]], 16)
);
check("a remark left out: the first line ends before it", remark[0].end <= 6.5 && remark[0].end >= 5, JSON.stringify(remark));
check("a remark left out: the second line starts after it", remark[1].start >= 9.5 && remark[1].start <= 11, JSON.stringify(remark));
check("a remark left out: both lines keep all their own speech", remark[0].start <= 1 && remark[0].end >= 5 && remark[1].start <= 11 && remark[1].end >= 15);

// A false start before the second sentence.
const stumble = snapLinesToPauses(
  [{ start: 20, end: 24 }, { start: 27, end: 31 }],
  runsAt([[20, 24], [25, 26], [27, 31]], 32)
);
check("a false start stays out of the next line", stumble[1].start >= 26 && stumble[1].start <= 27, JSON.stringify(stumble));
check("a false start stays out of the line before", stumble[0].end <= 25, JSON.stringify(stumble));

// A restart close to the sentence it restarts: only a short pause in between.
const restart = snapLinesToPauses(
  [{ start: 1, end: 3 }, { start: 5.5, end: 8 }],
  runsAt([[1, 3], [3.9, 5.05], [5.5, 8]], 9)
);
check("a restart just before its sentence still stays out", restart[1].start >= 5.05 && restart[0].end <= 3.9, JSON.stringify(restart));

// Three lines: one boundary with speech left out, one without.
const mixed = snapLinesToPauses(
  [{ start: 1, end: 3 }, { start: 3.6, end: 5 }, { start: 9, end: 11 }],
  runsAt([[1, 3], [3.5, 5], [6.4, 7.6], [9, 11]], 12)
);
check("mixed: the ordinary boundary still shares its pause", mixed[0].end <= mixed[1].start && mixed[1].start - mixed[0].end < 0.5, JSON.stringify(mixed));
check("mixed: the speech left out is in neither line", mixed[1].end <= 6.4 && mixed[2].start >= 7.6, JSON.stringify(mixed));
check("mixed: in order, not overlapping", mixed.every((r, i) => r.end > r.start && (i === 0 || r.start >= mixed[i - 1].end)));

// Nothing changes where the gap holds no whole run of speech (these are the
// results from before speech could be left out).
check(
  "unchanged: a run starting within the margin of the model's end",
  same(snapLinesToPauses([{ start: 1, end: 3.2 }, { start: 5, end: 7 }], runsAt([[1, 3.0], [3.4, 4.0], [5, 7]], 8)), [
    { start: 0.88, end: 4.2 },
    { start: 4.88, end: 7.2 },
  ])
);
check(
  "unchanged: only pauses between the lines",
  same(
    snapLinesToPauses(
      [{ start: 0.9, end: 2.6 }, { start: 3.3, end: 5.1 }, { start: 6.0, end: 8 }],
      runsAt([[1, 1.8], [1.9, 2.8], [3.5, 5.0], [5.9, 7.9]], 9)
    ),
    [
      { start: 0.88, end: 3 },
      { start: 3.38, end: 5.2 },
      { start: 5.78, end: 8.1 },
    ]
  )
);
check(
  "unchanged: speech straddling the model's end",
  same(snapLinesToPauses([{ start: 1, end: 4.5 }, { start: 7, end: 9 }], runsAt([[1, 4], [4.4, 5.2], [7, 9]], 10)), [
    { start: 0.88, end: 5.4 },
    { start: 6.88, end: 9.2 },
  ])
);
check("the margin is a quarter second", LEFT_OUT_MARGIN === 0.25);

// The same through real (synthesized) audio: a sentence, a stumble, the next sentence.
const withStumble = synth([
  { pause: 0.5 },
  { speech: [0.3, 0.35, 0.3] },
  { pause: 0.9 },
  { speech: [0.3, 0.2] }, // a false start
  { pause: 0.6 },
  { speech: [0.35, 0.3, 0.4] },
  { pause: 0.7 },
]);
const stumbleAnalysis = analyzeSpeech(withStumble.samples, RATE);
const [sentenceA, falseStart, sentenceB] = withStumble.lines;
const stumbleSnapped = snapLinesToPauses(
  [
    { start: sentenceA.start + 0.1, end: sentenceA.end - 0.1 },
    { start: sentenceB.start + 0.1, end: sentenceB.end - 0.15 },
  ],
  stumbleAnalysis
);
check(
  "audio: the false start is in neither clip",
  stumbleSnapped[0].end <= falseStart.start + 0.02 && stumbleSnapped[1].start >= falseStart.end - 0.02,
  `${JSON.stringify(stumbleSnapped)} false start ${falseStart.start.toFixed(2)}–${falseStart.end.toFixed(2)}`
);
check(
  "audio: each sentence is whole",
  stumbleSnapped[0].start <= sentenceA.start + 0.02 && stumbleSnapped[0].end >= sentenceA.end - 0.02 &&
    stumbleSnapped[1].start <= sentenceB.start + 0.02 && stumbleSnapped[1].end >= sentenceB.end - 0.02,
  JSON.stringify(stumbleSnapped)
);

done("segmentation");
