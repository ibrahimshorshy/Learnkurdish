import { buildTimeline, eventAt, turnLength } from "../src/render/timeline.ts";
import { check, near, done } from "./harness.mjs";

const base = {
  clipDurations: [2, 3],
  plays: 2,
  repeatGapMode: "auto",
  repeatGapSeconds: 2,
  gapBetweenLines: 0.5,
  intro: true,
  outro: true,
  introSeconds: 2,
  outroSeconds: 3,
};

const t = buildTimeline(base);
// intro 2 + line1 (2 + 2.4 + 2 + 2.4) + gap .5 + line2 (3 + 3.4 + 3 + 3.4) + outro 3
check("total length adds up", near(t.total, 2 + 8.8 + 0.5 + 12.8 + 3, 1e-9), String(t.total));
check("events are contiguous", t.events.every((e, i) => i === 0 || near(e.start, t.events[i - 1].end, 1e-9)));
check("each line plays twice", t.events.filter((e) => e.type === "play").length === 4);
check("a turn follows every play", t.events.filter((e) => e.type === "turn").length === 4);
check("first event is the intro", t.events[0].type === "intro");
check("last event is the outro", t.events[t.events.length - 1].type === "outro");

check("eventAt finds the first play", eventAt(t, 2.5)?.type === "play" && eventAt(t, 2.5)?.line === 0);
check("eventAt finds a turn", eventAt(t, 4.5)?.type === "turn");
check("eventAt past the end is the outro", eventAt(t, 999)?.type === "outro");

check("auto turn is the line plus a little", near(turnLength(2, "auto", 0), 2.4, 1e-9));
check("auto turn has a floor", turnLength(0.3, "auto", 0) === 1.2);
check("auto turn has a ceiling", turnLength(20, "auto", 0) === 8);
check("fixed turn uses the setting", turnLength(5, "fixed", 1.5) === 1.5);
check("no turn when off", turnLength(5, "off", 3) === 0);

const quick = buildTimeline({ ...base, repeatGapMode: "off", plays: 1, intro: false, outro: false });
check("one play, no turns: plays and gaps only",
  quick.events.every((e) => e.type === "play" || e.type === "gap"), JSON.stringify(quick.events.map((e) => e.type)));

const twiceNoTurn = buildTimeline({ ...base, repeatGapMode: "off", intro: false, outro: false, clipDurations: [1] });
check("two plays without turns still breathe between them",
  twiceNoTurn.events.some((e) => e.type === "turn" && near(e.end - e.start, 0.6, 1e-9)));

const clamped = buildTimeline({ ...base, plays: 9 });
check("plays clamp to three", clamped.events.filter((e) => e.type === "play" && e.line === 0).length === 3);

done("timeline");
