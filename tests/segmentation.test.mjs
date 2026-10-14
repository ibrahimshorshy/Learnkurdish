/**
 * Line boundaries against recordings whose real sentence breaks are known,
 * because they were built here: bursts of "speech" (shaped noise, with short
 * word gaps inside) separated by sentence pauses.
 */
import { analyzeSpeech } from "../src/render/audioAlign.ts";
import { snapLinesToPauses, placeLinesByLength, pausesOf, finish } from "../src/audio/segmentation.ts";
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

done("segmentation");
