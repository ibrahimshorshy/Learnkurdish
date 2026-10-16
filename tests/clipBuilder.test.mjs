/**
 * Which parts of the recording make up each line: cuts, tightened pauses,
 * takes, and video projects (which must never change timing). Pure — the
 * sources are fake RecordingAudio objects with only an analysis, because
 * linePieces never touches the samples.
 */
import {
  subtractRanges,
  pauseTrims,
  pauseTrimsAcrossCuts,
  linePieces,
  lineDuration,
  piecesDuration,
  normalizeCuts,
  addCut,
  restoreCutAt,
  cutAt,
  cutSummary,
  softLimit,
  JOIN_CROSSFADE,
} from "../src/audio/clipBuilder.ts";
import { speechRange, nudgeTake, TAKE_LEAD, TAKE_TAIL } from "../src/audio/takes.ts";
import { createProject } from "../src/utils/projectStore.ts";
import { check, near, done } from "./harness.mjs";

const eq = (a, b, tol = 1e-6) =>
  a.length === b.length && a.every((r, i) => near(r.start, b[i].start, tol) && near(r.end, b[i].end, tol));
const show = (ranges) => ranges.map((r) => `[${r.start.toFixed(3)},${r.end.toFixed(3)}]`).join(" ");

/** A fake source: only the analysis is read by linePieces. */
const source = (segments, duration = 20) => ({ analysis: { duration, segments }, gain: 1, buffer: null, mono: null });

function project(kind = "lesson", patch = {}) {
  const p = createProject(kind, ["ar", "en"]);
  return { ...p, ...patch, audioFx: { ...p.audioFx, ...(patch.audioFx ?? {}) } };
}

const line = (start, end, extra = {}) => ({
  id: "l1",
  kurdish: "سڵاو",
  start,
  end,
  transliteration: "",
  translations: {},
  ...extra,
});

/* ---------------- subtractRanges ---------------- */

check("subtract: nothing removed", eq(subtractRanges(1, 3, []), [{ start: 1, end: 3 }]));
check("subtract: a hole in the middle", eq(subtractRanges(1, 3, [{ start: 1.5, end: 2 }]), [{ start: 1, end: 1.5 }, { start: 2, end: 3 }]));
check("subtract: overlapping the start", eq(subtractRanges(1, 3, [{ start: 0.5, end: 1.2 }]), [{ start: 1.2, end: 3 }]));
check("subtract: overlapping the end", eq(subtractRanges(1, 3, [{ start: 2.8, end: 4 }]), [{ start: 1, end: 2.8 }]));
check("subtract: covering everything", subtractRanges(1, 3, [{ start: 0, end: 5 }]).length === 0);
check("subtract: outside the range changes nothing", eq(subtractRanges(1, 3, [{ start: 4, end: 5 }, { start: 0, end: 0.9 }]), [{ start: 1, end: 3 }]));
check(
  "subtract: several holes, given out of order",
  eq(subtractRanges(0, 10, [{ start: 6, end: 7 }, { start: 2, end: 3 }]), [{ start: 0, end: 2 }, { start: 3, end: 6 }, { start: 7, end: 10 }])
);
check("subtract: empty or reversed cuts are ignored", eq(subtractRanges(1, 3, [{ start: 2, end: 2 }, { start: 2.5, end: 2.2 }]), [{ start: 1, end: 3 }]));
check("subtract: slivers under 5ms are dropped", eq(subtractRanges(1, 3, [{ start: 1.003, end: 2 }]), [{ start: 2, end: 3 }]));

/* ---------------- pauseTrims ---------------- */

{
  const segs = [{ start: 1, end: 2 }, { start: 3.2, end: 4 }, { start: 4.2, end: 5 }];
  const trims = pauseTrims([{ start: 0.8, end: 5.2 }], segs, 0.5);
  check("trims: only the long pause is shortened, keeping half the limit each side", eq(trims, [{ start: 2.25, end: 2.95 }]), show(trims));
  check("trims: a pause under the limit is left alone", pauseTrims([{ start: 0.8, end: 5.2 }], segs, 1.5).length === 0);
  const trimsClipped = pauseTrims([{ start: 0.8, end: 2.6 }], segs, 0.3);
  check("trims: a gap running past the piece's end is not trimmed beyond it", trimsClipped.every((t) => t.end <= 2.6), show(trimsClipped));
  const tiny = pauseTrims([{ start: 0, end: 5 }], segs, 0);
  check("trims: a zero limit still keeps 50ms either side", eq(tiny, [{ start: 2.05, end: 3.15 }, { start: 4.05, end: 4.15 }]), show(tiny));
}

/* ---------------- linePieces ---------------- */

{
  const segs = [{ start: 1.1, end: 2 }, { start: 3.5, end: 4.4 }];
  const src = source(segs);
  const L = line(1, 4.6);

  const plain = project("lesson", { audioFx: { tightenPauses: false } });
  check("pieces: no cuts, no tightening — the line as marked", eq(linePieces(L, src, plain), [{ start: 1, end: 4.6 }]));

  const tightened = project("lesson", { audioFx: { tightenPauses: true, maxPause: 0.5 } });
  const tp = linePieces(L, src, tightened);
  check("pieces: tightening removes the long pause", eq(tp, [{ start: 1, end: 2.25 }, { start: 3.25, end: 4.6 }]), show(tp));
  check("pieces: tightened line is shorter by the trimmed pause", near(piecesDuration(tp), 3.6 - 1.0 - JOIN_CROSSFADE, 1e-6), piecesDuration(tp).toFixed(4));

  const cut = project("lesson", { cuts: [{ start: 2.5, end: 3 }], audioFx: { tightenPauses: false } });
  check("pieces: a cut inside the line is skipped", eq(linePieces(L, src, cut), [{ start: 1, end: 2.5 }, { start: 3, end: 4.6 }]));

  const both = project("lesson", { cuts: [{ start: 1.4, end: 1.6 }], audioFx: { tightenPauses: true, maxPause: 0.5 } });
  const bp = linePieces(L, src, both);
  check(
    "pieces: cuts and tightening together",
    eq(bp, [{ start: 1, end: 1.4 }, { start: 1.6, end: 2.25 }, { start: 3.25, end: 4.6 }]),
    show(bp)
  );

  const video = project("video", { cuts: [{ start: 2.5, end: 3 }], audioFx: { tightenPauses: true, maxPause: 0.3 } });
  check("pieces: a video project never cuts or tightens", eq(linePieces(L, src, video), [{ start: 1, end: 4.6 }]));

  // A take: its own timeline, its own pauses, and the main recording's cuts do not apply.
  const take = { id: "t1", blob: null, mimeType: "audio/webm", durationSeconds: 6, start: 0.4, end: 5.5 };
  const takeSrc = source([{ start: 0.55, end: 1.5 }, { start: 3.0, end: 5.2 }], 6);
  const withTake = line(1, 4.6, { take });
  const tc = project("lesson", { cuts: [{ start: 0.5, end: 5 }], audioFx: { tightenPauses: false } });
  check("pieces: a take ignores the main recording's cuts", eq(linePieces(withTake, takeSrc, tc), [{ start: 0.4, end: 5.5 }]));
  const tt = project("lesson", { audioFx: { tightenPauses: true, maxPause: 0.6 } });
  const ttp = linePieces(withTake, takeSrc, tt);
  check("pieces: a take is tightened by its own pauses", eq(ttp, [{ start: 0.4, end: 1.8 }, { start: 2.7, end: 5.5 }]), show(ttp));

  const tct = project("lesson", { cuts: [{ start: 1.6, end: 2.9 }], audioFx: { tightenPauses: true, maxPause: 0.6 } });
  const tctp = linePieces(withTake, takeSrc, tct);
  check("pieces: a tightened take still ignores the main recording's cuts", eq(tctp, [{ start: 0.4, end: 1.8 }, { start: 2.7, end: 5.5 }]), show(tctp));

  const sources = { main: src, takes: new Map([["t1", takeSrc]]) };
  check("duration: uses the take when the line has one", near(lineDuration(withTake, sources, tc), 5.1, 1e-6));
  check("duration: falls back to the marked length while audio loads", near(lineDuration(withTake, { main: null, takes: new Map() }, tc), 5.1, 1e-6));
  check("duration: main recording line", near(lineDuration(L, sources, plain), 3.6, 1e-6));
}

/* ---------------- tightening across cuts ---------------- */

{
  // Cutting an "um" out of a pause joins the silence either side of it into one pause.
  const tighten = (cuts) => project("lesson", { cuts, audioFx: { tightenPauses: true, maxPause: 0.45 } });
  const L = line(0, 6);
  const withUm = source([{ start: 0, end: 2 }, { start: 2.8, end: 3.1 }, { start: 3.9, end: 6 }]);
  const before = linePieces(L, withUm, tighten([]));
  const after = linePieces(L, withUm, tighten([{ start: 2.75, end: 3.15 }]));
  check("across cuts: the um cut out, the pause around it is one pause, trimmed to the limit", eq(after, [{ start: 0, end: 2.225 }, { start: 3.675, end: 6 }]), show(after));
  check("across cuts: cutting the um makes the line shorter, not longer", piecesDuration(after) < piecesDuration(before), `${piecesDuration(before)} → ${piecesDuration(after)}`);

  // A cut in plain silence changes nothing once the pause is tightened.
  const plain = source([{ start: 0, end: 2 }, { start: 3.9, end: 6 }]);
  const plainCut = linePieces(L, plain, tighten([{ start: 2.75, end: 3.15 }]));
  check(
    "across cuts: a cut inside a long pause gives the same line as no cut",
    eq(plainCut, linePieces(L, plain, tighten([]))) && near(piecesDuration(plainCut), 4.538, 1e-9),
    show(plainCut)
  );

  // A cut that takes the end of a word and some of the pause: what is left of the pause is measured.
  const clipped = linePieces(line(0, 5), source([{ start: 0, end: 2 }, { start: 3, end: 5 }]), tighten([{ start: 1.8, end: 2.5 }]));
  check(
    "across cuts: a cut over a word's end leaves at most the limit of silence",
    eq(clipped, [{ start: 0, end: 1.8 }, { start: 2.5, end: 2.725 }, { start: 2.775, end: 5 }]),
    show(clipped)
  );

  // Under the limit once the cut is out: left alone.
  const short = project("lesson", { cuts: [{ start: 2.45, end: 2.65 }], audioFx: { tightenPauses: true, maxPause: 0.8 } });
  const sp = linePieces(line(0, 5), source([{ start: 0, end: 2 }, { start: 2.5, end: 2.6 }, { start: 3, end: 5 }]), short);
  check("across cuts: a pause within the limit after the cut is not trimmed", eq(sp, [{ start: 0, end: 2.45 }, { start: 2.65, end: 5 }]), show(sp));

  // A cut in the middle of continuous speech makes no pause to trim.
  const words = linePieces(line(0, 4), source([{ start: 0.2, end: 3.8 }]), tighten([{ start: 1.5, end: 2.5 }]));
  check("across cuts: a cut inside a word is only the cut", eq(words, [{ start: 0, end: 1.5 }, { start: 2.5, end: 4 }]), show(words));

  // Several cuts in one pause.
  const many = linePieces(L, plain, tighten([{ start: 2.3, end: 2.5 }, { start: 3.0, end: 3.2 }, { start: 3.6, end: 3.7 }]));
  // 0.225s kept after the first word; before the second, the 0.2s after the last cut and 0.025s before it.
  check(
    "across cuts: several cuts in one pause still leave the limit",
    eq(many, [{ start: 0, end: 2.225 }, { start: 3.575, end: 3.6 }, { start: 3.7, end: 6 }]),
    show(many)
  );
  const nearEdge = linePieces(L, plain, tighten([{ start: 2.1, end: 2.4 }]));
  check(
    "across cuts: a cut right after the word, the half-pause kept is sound after the cut",
    eq(nearEdge, [{ start: 0, end: 2.1 }, { start: 2.4, end: 2.525 }, { start: 3.675, end: 6 }]),
    show(nearEdge)
  );

  // Without cuts the trims are exactly what pauseTrims gives on the whole line.
  let same = true;
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let n = 0; n < 200 && same; n++) {
    const segs = [];
    let t = rand();
    for (let k = 0; k < 6; k++) {
      const s = t + rand() * 1.2;
      const e = s + 0.05 + rand();
      segs.push({ start: s, end: e });
      t = e;
    }
    const a = rand() * 2;
    const b = a + 1 + rand() * 6;
    const max = rand();
    const now = subtractRanges(a, b, pauseTrimsAcrossCuts(a, b, segs, [], max));
    const old = subtractRanges(a, b, pauseTrims([{ start: a, end: b }], segs, max));
    same = eq(now, old, 1e-12);
  }
  check("across cuts: with no cuts, exactly the old pieces", same);

  const video = project("video", { cuts: [{ start: 2.75, end: 3.15 }], audioFx: { tightenPauses: true, maxPause: 0.45 } });
  check("across cuts: a video project still never cuts or tightens", eq(linePieces(L, withUm, video), [{ start: 0, end: 6 }]));
}

/* ---------------- piecesDuration ---------------- */

check("crossfade: one piece has no joins", near(piecesDuration([{ start: 0, end: 1 }]), 1, 1e-9));
check("crossfade: each join overlaps by the crossfade", near(piecesDuration([{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 }]), 3 - 2 * JOIN_CROSSFADE, 1e-9));
check("crossfade: never more than half a short piece", near(piecesDuration([{ start: 0, end: 0.01 }, { start: 1, end: 1.01 }]), 0.015, 1e-9));
check("crossfade: nothing is nothing", piecesDuration([]) === 0);

/* ---------------- cuts ---------------- */

check("cuts: sorted and merged where they overlap", eq(normalizeCuts([{ start: 3, end: 4 }, { start: 1, end: 2 }, { start: 1.5, end: 2.5 }]), [{ start: 1, end: 2.5 }, { start: 3, end: 4 }]));
check("cuts: touching cuts merge", eq(normalizeCuts([{ start: 1, end: 2 }, { start: 2.005, end: 3 }]), [{ start: 1, end: 3 }]));
check("cuts: empty and broken ones are dropped", eq(normalizeCuts([{ start: 1, end: 1 }, { start: NaN, end: 2 }, { start: 2, end: 3 }]), [{ start: 2, end: 3 }]));
check("cuts: adding one that spans two merges all three", eq(addCut([{ start: 1, end: 2 }, { start: 3, end: 4 }], { start: 1.5, end: 3.5 }), [{ start: 1, end: 4 }]));
check("cuts: a selection dragged right to left still adds", eq(addCut([], { start: 5, end: 4 }), [{ start: 4, end: 5 }]));
check("cuts: restore the one under the click", eq(restoreCutAt([{ start: 1, end: 2 }, { start: 3, end: 4 }], 3.5), [{ start: 1, end: 2 }]));
check("cuts: find the one under a time", cutAt([{ start: 1, end: 2 }], 1.5)?.start === 1 && cutAt([{ start: 1, end: 2 }], 2.5) === undefined);
{
  const p = project("lesson", {
    cuts: [{ start: 1.5, end: 2 }, { start: 5, end: 6 }, { start: 8.2, end: 8.4 }],
    lines: [line(1, 3), line(4.5, 5.5, { take: { id: "t", start: 0, end: 1, durationSeconds: 1 } }), line(8, 9)],
  });
  const s = cutSummary(p);
  check("summary: counts the cuts and their total", s.count === 3 && near(s.total, 1.7, 1e-9));
  check("summary: only what is cut from lines you hear (not between lines, not under a take)", near(s.inLines, 0.7, 1e-9), s.inLines);
}

/* ---------------- soft limit ---------------- */

check("limit: quiet samples untouched", softLimit(0.5) === 0.5 && softLimit(-0.79) === -0.79);
check("limit: loud samples stay under full scale", softLimit(3) < 1 && softLimit(-3) > -1);
check("limit: continuous at the knee", near(softLimit(0.80001), 0.80001, 1e-4));
check("limit: never turns louder into quieter", softLimit(0.9) < softLimit(0.95) && softLimit(0.95) < softLimit(1.2));

/* ---------------- takes ---------------- */

{
  const analysis = { duration: 4, segments: [{ start: 0.05, end: 0.08 }, { start: 0.9, end: 2.1 }, { start: 2.3, end: 2.9 }, { start: 3.85, end: 3.92 }] };
  const r = speechRange(analysis, 4);
  check("take: trimmed to the speech with a little air, button clicks at either end ignored", near(r.start, 0.9 - TAKE_LEAD, 1e-9) && near(r.end, 2.9 + TAKE_TAIL, 1e-9), `${r.start} ${r.end}`);
  const whole = speechRange({ duration: 3, segments: [{ start: 0, end: 3 }] }, 3);
  check("take: no speech/silence contrast keeps the whole take", whole.start === 0 && whole.end === 3);
  const edge = speechRange({ duration: 2, segments: [{ start: 0.02, end: 1.95 }] }, 2);
  check("take: air is clamped to the take", edge.start === 0 && edge.end === 2);
  const word = speechRange({ duration: 3, segments: [{ start: 0.2, end: 0.3 }, { start: 0.45, end: 1.2 }] }, 3);
  check("take: a short real word near the speech is kept", near(word.start, 0.2 - TAKE_LEAD, 1e-9), `${word.start}`);
  const blips = speechRange({ duration: 4, segments: [{ start: 0.5, end: 0.56 }, { start: 1.5, end: 1.56 }, { start: 2.5, end: 2.56 }] }, 4);
  check(
    "take: nothing but short sounds is kept whole, not whittled down to one",
    near(blips.start, 0.5 - TAKE_LEAD, 1e-9) && near(blips.end, 2.56 + TAKE_TAIL, 1e-9),
    `${blips.start} ${blips.end}`
  );

  const take = { id: "t", start: 0.5, end: 2, durationSeconds: 3 };
  check("nudge: start earlier", near(nudgeTake(take, "start", -0.05).start, 0.45, 1e-9));
  check("nudge: start never before the take", nudgeTake({ ...take, start: 0.02 }, "start", -0.05).start === 0);
  check("nudge: end never past the take", nudgeTake({ ...take, end: 2.98 }, "end", 0.05).end === 3);
  check("nudge: never shorter than 0.15s", near(nudgeTake({ ...take, end: 0.66 }, "start", 0.1).start, 0.51, 1e-9));
}

done("clipBuilder");
