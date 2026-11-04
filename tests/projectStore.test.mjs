/**
 * The project store and the writes that land in a project after an await:
 * migrating projects saved by earlier versions, and routing a finished job's
 * result into the project it was started for — never into whichever project
 * is open by then. IndexedDB is not touched: the writer is given fakes.
 */
import { createProject, normalizeProject } from "../src/utils/projectStore.ts";
import { createProjectWriter, recordingSignature, serialQueue } from "../src/utils/projectWrites.ts";
import { holdLeave, workInProgress } from "../src/utils/leaveGuard.ts";
import { linePieces } from "../src/audio/clipBuilder.ts";
import { check, done } from "./harness.mjs";

/* ---------------- migrating 1.0 projects ---------------- */

// A lesson exactly as 1.0 saved it: no kind, no audioFx, no cards, one theme.
const old = {
  id: "p-old",
  name: "Greetings",
  createdAt: 1,
  updatedAt: 1,
  taughtLang: "ckb",
  audiences: ["ar", "en"],
  context: "",
  note: "",
  lines: [{ id: "l1", kurdish: "سڵاو", start: 0.5, end: 3, transliteration: "", translations: {} }],
  titles: {},
  captions: {},
  step: "video",
  video: {
    theme: "sun",
    resolution: "1080",
    plays: 2,
    repeatGapMode: "auto",
    repeatGapSeconds: 2.5,
    gapBetweenLines: 0.6,
    showTransliteration: true,
    karaoke: false,
    intro: false,
    outro: true,
    outputs: [["ar"], ["en"]],
  },
  renders: [],
  usage: { inputTokens: 0, audioTokens: 0, outputTokens: 0, costUsd: 0 },
};

const migrated = normalizeProject(old);
check("1.0: becomes a lesson", migrated.kind === "lesson");
check("1.0: sound stays as recorded (raw preset)", migrated.audioFx.preset === "raw");
check("1.0: long pauses are not shortened", migrated.audioFx.tightenPauses === false, JSON.stringify(migrated.audioFx));
check("1.0: no room ambience", migrated.audioFx.room === false);
check("1.0: card switches carried over", migrated.intro.enabled === false && migrated.outro.enabled === true);

// The line from the review: speech 0.5–1.2 and 2.2–3.0 with a 1 s pause inside.
const fakeSource = { analysis: { duration: 4, segments: [{ start: 0.5, end: 1.2 }, { start: 2.2, end: 3.0 }] }, gain: 1 };
const pieces = linePieces({ ...old.lines[0], start: 0.5, end: 3.0 }, fakeSource, migrated);
check(
  "1.0: a line plays whole, pause and all, as it did in 1.0",
  pieces.length === 1 && pieces[0].start === 0.5 && pieces[0].end === 3.0,
  JSON.stringify(pieces)
);

const withKindNoFx = normalizeProject({ ...old, kind: "lesson" });
check(
  "2.0 project without audioFx: today's defaults",
  withKindNoFx.audioFx.preset === "clean" && withKindNoFx.audioFx.tightenPauses === true
);
const chosen = normalizeProject({ ...old, kind: "story", audioFx: { preset: "warm", room: true, tightenPauses: false, maxPause: 0.8 } });
check(
  "saved audioFx kept as chosen",
  chosen.audioFx.preset === "warm" && chosen.audioFx.room && !chosen.audioFx.tightenPauses && chosen.audioFx.maxPause === 0.8
);
const partialFx = normalizeProject({ ...old, kind: "lesson", audioFx: { preset: "noisy" } });
check("a partial saved audioFx is filled from the defaults", partialFx.audioFx.preset === "noisy" && partialFx.audioFx.maxPause === 0.45);

/* ---------------- recording signature ---------------- */

const blob = (n) => new Blob([new Uint8Array(n)], { type: "audio/webm" });
const rec = (n, d) => ({ blob: blob(n), mimeType: "audio/webm", durationSeconds: d });
check("signature: same audio read back from storage matches", recordingSignature(rec(100, 2.5)) === recordingSignature(rec(100, 2.5)));
check("signature: another take does not match", recordingSignature(rec(100, 2.5)) !== recordingSignature(rec(120, 2.7)));
check("signature: no recording", recordingSignature(undefined) === "");

/* ---------------- writes that land after an await ---------------- */

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A fake app: one open project in memory, a store with slow reads and writes. */
function fakeApp(...projects) {
  const store = new Map(projects.map((p) => [p.id, structuredClone(p)]));
  const app = { open: null, commits: 0, store };
  const write = createProjectWriter({
    current: () => app.open,
    commit: (next) => {
      app.open = next;
      app.commits++;
    },
    load: async (id) => {
      await tick(5);
      return store.has(id) ? structuredClone(store.get(id)) : null;
    },
    save: async (p) => {
      await tick(5);
      store.set(p.id, structuredClone(p));
    },
    queue: serialQueue(),
  });
  return { app, write };
}

{
  const a = { ...createProject("lesson", ["ar", "en"]), id: "A", name: "A" };
  const b = { ...createProject("dialogue", ["ar", "en"]), id: "B", name: "B", lines: [{ id: "b1", kurdish: "B line" }] };
  const { app, write } = fakeApp(a, b);

  // A is open; a write for A changes it in memory, straight away.
  app.open = structuredClone(a);
  const r1 = write("A", { note: "first" });
  check("open project: changed at once, in memory", app.open.note === "first");
  check("open project: result says so", (await r1) === "open");

  // The teacher opens B. A transcription started on A lands now.
  app.open = structuredClone(b);
  const r2 = await write("A", (p) => ({ lines: [{ id: "a1", kurdish: "A line" }], step: "transcript" }));
  check("closed project: written into its saved copy", r2 === "saved" && app.store.get("A").lines[0]?.kurdish === "A line");
  check("closed project: the open project is untouched", app.open.lines[0].kurdish === "B line" && app.open.step === "record");

  // Two results for A land back to back: neither is lost.
  const both = await Promise.all([
    write("A", (p) => ({ renders: [...p.renders, { id: "v1" }] })),
    write("A", (p) => ({ renders: [...p.renders, { id: "v2" }] })),
  ]);
  check(
    "closed project: back-to-back writes both kept",
    both.every((r) => r === "saved") && app.store.get("A").renders.map((r) => r.id).join() === "v1,v2"
  );

  // A patch that changes nothing does not touch the open project.
  const before = app.commits;
  check("empty patch: unchanged", (await write("B", () => ({}))) === "unchanged" && app.commits === before);

  // Deleted while the job ran: nothing is written, no ghost project appears.
  app.store.delete("A");
  check("deleted project: nothing brought back", (await write("A", { note: "late" })) === "gone" && !app.store.has("A"));
}

{
  // A write queued for a closed project, then that project is opened through
  // the same queue: the open sees the write.
  const a = { ...createProject("lesson", ["ar"]), id: "A" };
  const b = { ...createProject("lesson", ["ar"]), id: "B" };
  const queue = serialQueue();
  const store = new Map([[a.id, structuredClone(a)], [b.id, structuredClone(b)]]);
  const app = { open: structuredClone(b) };
  const write = createProjectWriter({
    current: () => app.open,
    commit: (next) => (app.open = next),
    load: async (id) => (await tick(5), store.has(id) ? structuredClone(store.get(id)) : null),
    save: async (p) => (await tick(5), void store.set(p.id, structuredClone(p))),
    queue,
  });
  const pending = write("A", { name: "Transcribed" });
  const opening = queue(async () => {
    await tick(1);
    app.open = structuredClone(store.get("A"));
  });
  // And a write that arrives after the open was queued lands in memory.
  const after = write("A", { note: "after" });
  await Promise.all([pending, opening, after]);
  check("reopened: the earlier write is in what was opened", app.open.name === "Transcribed");
  check("reopened: the later write lands in memory", app.open.note === "after" && (await after) === "open");
}

{
  // A failure in the queue does not stop what comes after it.
  const queue = serialQueue();
  const failed = queue(async () => {
    throw new Error("disk full");
  }).catch((e) => e.message);
  const next = queue(async () => "ran");
  check("queue: carries on after a failure", (await failed) === "disk full" && (await next) === "ran");
}

/* ---------------- leaving while something is in progress ---------------- */

check("leave guard: nothing in progress", workInProgress().length === 0);
const release1 = holdLeave("A recording is in progress.");
const release2 = holdLeave("A recording is in progress.");
const release3 = holdLeave("A video is being made.");
check("leave guard: each kind of work said once", workInProgress().length === 2, JSON.stringify(workInProgress()));
release1();
release3();
check("leave guard: still held by the other recorder", workInProgress().join() === "A recording is in progress.");
release2();
check("leave guard: released", workInProgress().length === 0);

done("projectStore");
