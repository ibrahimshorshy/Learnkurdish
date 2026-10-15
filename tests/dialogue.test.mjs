import { dialogueMode, dialoguePrompt, toSpeakerIndex, cleanSpeakerName } from "../src/config/prompts/dialogue.ts";
import { transcribeMode } from "../src/config/transcribeModes.ts";
import { findTaughtLanguage } from "../src/config/languages.ts";
import { normalizeTranscript } from "../src/utils/transcript.ts";
import {
  APPEAR_SECONDS,
  DIMMED_ALPHA,
  SCROLL_SECONDS,
  bubbleAlpha,
  currentBubble,
  planScroll,
  restShift,
  shiftAt,
  speakerSide,
  stackBubbles,
  visibleRange,
  colorsDistinct,
  dialogueSpeakerName,
  parseColor,
  speakerColors,
  withAlpha,
} from "../src/render/dialogueLayout.ts";
import { THEMES } from "../src/render/themes.ts";
import { check, near, done } from "./harness.mjs";

const ckb = findTaughtLanguage("ckb");

/* ---------- the mode is registered ---------- */

check("the dialogue mode is the one registered", transcribeMode("dialogue") === dialogueMode);

/* ---------- toRawLines: 1 and 2 become 0 and 1 ---------- */

const raw = dialogueMode.toRawLines(
  {
    lines: [
      { text: "سڵاو، چۆنی؟", start: 0.2, end: 1.4, speaker: 1 },
      { text: "باشم، سوپاس. تۆ چۆنی؟", start: 1.9, end: 3.6, speaker: 2 },
      { text: "منیش باشم", start: 4, end: 5, speaker: "2" },
      { text: "?", start: 5.2, end: 5.6, speaker: 7 },
      { text: "-", start: 5.8, end: 6, speaker: null },
      { text: "x", start: 6.1, end: 6.5 },
      { text: "y", start: 6.6, end: 7, speaker: "Speaker 2" },
    ],
  },
  { language: ckb, durationSeconds: 8 }
);
check("speaker 1 becomes 0", raw[0].speaker === 0);
check("speaker 2 becomes 1", raw[1].speaker === 1);
check("a numeric string is read", raw[2].speaker === 1);
check("an out-of-range speaker falls back to the first", raw[3].speaker === 0);
check("a null speaker falls back to the first", raw[4].speaker === 0);
check("a missing speaker falls back to the first", raw[5].speaker === 0);
check("'Speaker 2' is read as 2", raw[6].speaker === 1);
check("text and times pass through", raw[1].text === "باشم، سوپاس. تۆ چۆنی؟" && raw[1].start === 1.9 && raw[1].end === 3.6);
check("every line has a speaker", raw.every((l) => l.speaker === 0 || l.speaker === 1));

const zeroBased = dialogueMode.toRawLines(
  { lines: [{ text: "a", start: 0, end: 1, speaker: 0 }, { text: "b", start: 1, end: 2, speaker: 1 }] },
  { language: ckb, durationSeconds: 3 }
);
check("an answer numbered 0 and 1 is read as 0-based", zeroBased[0].speaker === 0 && zeroBased[1].speaker === 1);

check("no lines is fine", dialogueMode.toRawLines({}, { language: ckb, durationSeconds: 1 }).length === 0);
check("junk entries are dropped", dialogueMode.toRawLines({ lines: [null, 3, "x"] }, { language: ckb, durationSeconds: 1 }).length === 0);
check("toSpeakerIndex 1 → 0", toSpeakerIndex(1) === 0);
check("toSpeakerIndex 2 → 1", toSpeakerIndex(2) === 1);
check("toSpeakerIndex garbage → 0", toSpeakerIndex("B") === 0 && toSpeakerIndex(undefined) === 0);

// The speakers survive normalizeTranscript, which is what the server runs next.
const normalized = normalizeTranscript(raw, 8);
check("speakers survive normalizing", normalized.lines[1].speaker === 1 && normalized.lines[0].speaker === 0);

/* ---------- the schema asks for the speaker ---------- */

const schema = dialogueMode.schema({ language: ckb, durationSeconds: 8 });
const item = schema.properties.lines.items;
check("schema has an INTEGER speaker", item.properties.speaker?.type === "INTEGER");
check("schema requires the speaker", item.required.includes("speaker"));
check("schema still requires text and times", ["text", "start", "end"].every((k) => item.required.includes(k)));

/* ---------- the prompt ---------- */

const plain = dialoguePrompt({ language: ckb, durationSeconds: 42.5 });
check("prompt carries the Sorani letters", ["ڕ", "ڵ", "ۆ", "ێ", "ە"].every((c) => plain.includes(c)));
check("prompt keeps the lesson's verbatim rule", /Do not translate/.test(plain));
check("prompt bounds the timestamps", plain.includes("42.50"));
check("prompt asks for speaker 1 or 2", /"speaker": 1 or 2/.test(plain));
check("speaker 1 is whoever speaks first", /Speaker 1 is whoever speaks first/.test(plain));
check("prompt says one person may voice both parts", /same person may be voicing both parts/.test(plain));
check("prompt leans on turn-taking, not voice alone", /not decide who is speaking by the sound of the voice alone/.test(plain));
check("no names section without names", !/SPEAKERS' NAMES/.test(plain));

const named = dialoguePrompt({ language: ckb, durationSeconds: 10, speakers: ["Ahmad", "سارا"], context: "At the market" });
check("prompt carries the first speaker's name", named.includes("«Ahmad»"));
check("prompt carries the second speaker's name", named.includes("«سارا»"));
check("prompt carries the context", named.includes("At the market"));
check("names section present with names", /SPEAKERS' NAMES/.test(named));

const oneName = dialoguePrompt({ language: ckb, durationSeconds: 10, speakers: ["", "Sara"] });
check("one name alone is used", oneName.includes("speaker 2 is «Sara»") && !oneName.includes("speaker 1 is «"));

const blank = dialoguePrompt({ language: ckb, durationSeconds: 10, speakers: ["  ", ""] });
check("blank names are ignored", !/SPEAKERS' NAMES/.test(blank));

check("names are cleaned of quotes and newlines", cleanSpeakerName('  "Ah\nmad"  ') === "Ah mad");
check("names are capped", cleanSpeakerName("x".repeat(200)).length === 60);

const system = dialogueMode.systemPrompt({ language: ckb, durationSeconds: 1 });
check("system prompt still demands JSON", /only JSON/.test(system));

/* ---------- which side ---------- */

check("RTL video: first speaker on the right", speakerSide(0, true) === "right" && speakerSide(1, true) === "left");
check("LTR video: first speaker on the left", speakerSide(0, false) === "left" && speakerSide(1, false) === "right");
check("an unknown speaker sits with the first", speakerSide(5, false) === "left");

/* ---------- stacking ---------- */

const tops = stackBubbles([100, 80, 60, 90], [0, 1, 1, 0], 16, 8);
check("first bubble at the top", tops[0] === 0);
check("change of speaker leaves the full gap", tops[1] === 116);
check("same speaker sits closer", tops[2] === 116 + 80 + 8);
check("back to the first speaker: full gap", tops[3] === 116 + 80 + 8 + 60 + 16);

/* ---------- resting place ---------- */

const geo = { viewHeight: 600, fadeTop: 40, padBottom: 20 };
const room = 600 - 40 - 20;
check("a short thread is centred below the fade", near(restShift(100, geo), 40 + (room - 100) / 2, 1e-9));
check("a thread that just fits starts at the fade", near(restShift(room, geo), 40, 1e-9));
check("a long thread rests on the bottom", near(restShift(1000, geo) + 1000, 600 - 20, 1e-9));
check("the rest is continuous where it starts to overflow", near(restShift(room, geo), restShift(room + 1e-6, geo), 1e-3));

/* ---------- scrolling ---------- */

const heights = [150, 150, 150, 150, 150, 150];
const stack = stackBubbles(heights, [0, 1, 0, 1, 0, 1], 16, 8);
const appear = [0, 2, 4, 6, 8, 10];
const plan = planScroll(stack, heights, appear, geo);
check("starts settled on the first bubble", near(shiftAt(plan, 0), plan.to[0], 1e-9));
check("settles on each bubble", appear.every((a, i) => near(shiftAt(plan, a + SCROLL_SECONDS + 0.01), plan.to[i], 1e-6)));
check("only ever moves up", plan.to.every((v, i) => i === 0 || v <= plan.to[i - 1] + 1e-9));
let smooth = true;
for (let t = 0; t < 12; t += 1 / 30) {
  if (Math.abs(shiftAt(plan, t + 1 / 30) - shiftAt(plan, t)) > 40) smooth = false;
}
check("no jumps between frames", smooth);
for (let i = 0; i < heights.length; i++) {
  const t = appear[i] + SCROLL_SECONDS + 0.05;
  const bottom = stack[i] + heights[i] + shiftAt(plan, t);
  if (bottom > geo.viewHeight - geo.padBottom + 1e-6) check(`bubble ${i} in view once settled`, false, String(bottom));
}
check("the newest bubble is always in view once settled", true);

// Lines quicker than the scroll: each move starts where the last had got to.
const quickAppear = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
const quick = planScroll(stack, heights, quickAppear, geo);
check(
  "rapid lines never make the thread jump",
  quickAppear.every((a) => Math.abs(shiftAt(quick, a - 1e-6) - shiftAt(quick, a + 1e-6)) < 0.01)
);
check("rapid lines still settle on the last", near(shiftAt(quick, 0.5 + SCROLL_SECONDS + 0.01), quick.to[5], 1e-6));

check("no bubbles: no shift", shiftAt(planScroll([], [], [], geo), 3) === 0);

/* ---------- which bubble, how visible ---------- */

check("before the first: none", currentBubble([1, 2], 0.5) === -1);
check("the latest to have appeared", currentBubble(appear, 5) === 2);
check("exactly on an appearance", currentBubble(appear, 6) === 3);
check("past the end: the last", currentBubble(appear, 99) === 5);

check("not yet appeared: invisible", bubbleAlpha(3, appear, 5) === 0);
check("fading in", near(bubbleAlpha(3, appear, 6 + APPEAR_SECONDS / 2), 0.5, 1e-9));
check("the newest is at full strength", bubbleAlpha(3, appear, 7) === 1);
check("earlier ones dim", near(bubbleAlpha(1, appear, 7), DIMMED_ALPHA, 1e-9));
check("the last stays bright to the end", bubbleAlpha(5, appear, 99) === 1);

/* ---------- long dialogues ---------- */

const many = 300;
const longHeights = Array.from({ length: many }, (_, i) => 120 + (i % 3) * 40);
const longStack = stackBubbles(longHeights, longHeights.map((_, i) => i % 2), 16, 8);
const longAppear = longHeights.map((_, i) => i * 2.5);
const longPlan = planScroll(longStack, longHeights, longAppear, geo);
const lastT = longAppear[many - 1] + 1;
const seen = visibleRange(longStack, longHeights, many - 1, shiftAt(longPlan, lastT), geo.viewHeight, 40);
check("a long dialogue draws only a handful of bubbles", seen.length > 0 && seen.length <= 6, String(seen.length));
check("the newest is among them", seen[seen.length - 1] === many - 1);
check("oldest first", seen.every((v, i) => i === 0 || v > seen[i - 1]));

/* ---------- the speakers' colours ---------- */

check("reads #rrggbb", JSON.stringify(parseColor("#33AFD5")) === "[51,175,213]");
check("reads #rgb", JSON.stringify(parseColor("#fff")) === "[255,255,255]");
check("reads rgba()", JSON.stringify(parseColor("rgba(4, 23, 48, 0.3)")) === "[4,23,48]");
check("unreadable is null", parseColor("teal") === null);
check("withAlpha rewrites the opacity", withAlpha("#33AFD5", 0.5) === "rgba(51, 175, 213, 0.5)");
check("withAlpha leaves what it cannot read", withAlpha("teal", 0.5) === "teal");
check("two golds are not distinct", !colorsDistinct("#C7A057", "#DAC192"));
check("blue and green are distinct", colorsDistinct("#1D6989", "#456539"));
check("dark and light are distinct", colorsDistinct("#041730", "#D7E1F2"));

for (const theme of Object.values(THEMES)) {
  const [a, b] = speakerColors(theme.palette);
  check(`${theme.label}: the two speakers' colours are distinct`, colorsDistinct(a, b), `${a} vs ${b}`);
  check(`${theme.label}: the first speaker keeps the accent`, a === theme.palette.accent);
}
check("Emerald keeps its gold for the second speaker", speakerColors(THEMES.emerald.palette)[1] === THEMES.emerald.palette.accentAlt);
check("Cinematic's second speaker is not a second gold", speakerColors(THEMES.cinematic.palette)[1] !== THEMES.cinematic.palette.accentAlt);

/* ---------- the speakers' names ---------- */

check("a typed name is kept", dialogueSpeakerName("سارا", 1, "ar") === "سارا");
check("the English placeholder becomes Arabic in an Arabic video", dialogueSpeakerName("Speaker 1", 0, "ar") === "المتحدث الأول");
check("no name becomes the placeholder", dialogueSpeakerName("", 1, "en") === "Speaker 2");
check("an unknown language falls back to English", dialogueSpeakerName(undefined, 0, "xx") === "Speaker 1");

done("dialogue");
