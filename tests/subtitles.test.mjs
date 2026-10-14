import { cueTimings, cueIndexAt, subtitleTint, JOIN_GAP, HOLD_AFTER, MIN_ON_SCREEN } from "../src/render/subtitles.ts";
import { tidyCues, concatList, frameFilter } from "../server/routes/media.ts";
import { check, near, done } from "./harness.mjs";

const line = (id, start, end, extra = {}) => ({
  id,
  kurdish: `ڕستەی ${id}`,
  start,
  end,
  transliteration: "",
  translations: {},
  ...extra,
});

/* ---------- when each subtitle shows ---------- */

{
  const cues = cueTimings([line("a", 1, 2), line("b", 2.5, 4), line("c", 8, 9)]);
  check("one cue per usable line", cues.length === 3, JSON.stringify(cues));
  check("a cue starts with its line", near(cues[0].start, 1, 1e-9));
  check("a short pause joins: held until the next line", near(cues[0].end, 2.5, 1e-9), String(cues[0].end));
  check("a long pause: held a little past the line", near(cues[1].end, 4 + HOLD_AFTER, 1e-9), String(cues[1].end));
  check("the last line holds past its end too", near(cues[2].end, 9 + HOLD_AFTER, 1e-9));
  check("cue keeps its line's index and id", cues[2].index === 2 && cues[2].lineId === "c");
}

{
  const gap = JOIN_GAP - 0.01;
  const cues = cueTimings([line("a", 0, 1), line("b", 1 + gap, 3)]);
  check("a pause just under the join gap joins", near(cues[0].end, 1 + gap, 1e-9));
  const apart = cueTimings([line("a", 0, 1), line("b", 1 + JOIN_GAP + 0.01, 3)]);
  check("a pause just over the join gap does not", near(apart[0].end, 1 + HOLD_AFTER, 1e-9));
}

{
  const cues = cueTimings([
    line("a", 0, 1),
    line("skipped", 1.1, 2, { skip: true }),
    line("empty", 2.1, 3, { kurdish: "   " }),
    line("b", 5, 6),
  ]);
  check("skipped and empty lines get no cue", cues.map((c) => c.lineId).join() === "a,b", cues.map((c) => c.lineId).join());
  check("a skipped line does not hold the previous one", near(cues[0].end, 1 + HOLD_AFTER, 1e-9));
}

{
  const cues = cueTimings([line("a", 0, 0.2), line("b", 3, 4)]);
  check("a very short line is held long enough to read", near(cues[0].end, MIN_ON_SCREEN, 1e-9), String(cues[0].end));
  const tight = cueTimings([line("a", 0, 0.2), line("b", 0.5, 4)]);
  check("…but never into the next line", near(tight[0].end, 0.5, 1e-9));
}

{
  const cues = cueTimings([line("a", 0, 1), line("b", 0.8, 2)]);
  check("overlapping lines never overlap on screen", cues[0].end <= cues[1].start + 1e-9);
}

{
  const cues = cueTimings([line("a", 1, 2), line("b", 9, 9.8), line("c", 12, 13)], 10);
  check("cues past the video's end are dropped", cues.length === 2);
  check("the last cue stops at the video's end", near(cues[1].end, 10, 1e-9), String(cues[1].end));
}

{
  const cues = cueTimings([line("b", 5, 6), line("a", 1, 2)]);
  check("cues come out in time order", cues[0].lineId === "a" && cues[1].lineId === "b");
  check("bad times are ignored", cueTimings([line("x", 3, 3), line("y", NaN, 2)]).length === 0);
}

/* ---------- which cue is on screen ---------- */

{
  const cues = [
    { start: 1, end: 2 },
    { start: 2, end: 3 },
    { start: 5, end: 6 },
  ];
  check("nothing before the first cue", cueIndexAt(cues, 0.5) === -1);
  check("first cue at its start", cueIndexAt(cues, 1) === 0);
  check("the next cue takes over at its start", cueIndexAt(cues, 2) === 1);
  check("nothing in a gap", cueIndexAt(cues, 4) === -1);
  check("last cue", cueIndexAt(cues, 5.5) === 2);
  check("nothing after the end", cueIndexAt(cues, 6) === -1);
  check("no cues at all", cueIndexAt([], 1) === -1);
}

/* ---------- box colour ---------- */

check("Arabic is green", subtitleTint(["ar"]).kind === "green");
check("English is purple", subtitleTint(["en"]).kind === "purple");
check("both melt green into purple", subtitleTint(["ar", "en"]).kind === "twilight" && subtitleTint(["ar", "en"]).fill.length === 2);
check("order does not matter", subtitleTint(["en", "ar"]).kind === "twilight");
check("others are neutral", subtitleTint(["fa"]).kind === "neutral" && subtitleTint(["tr", "fa"]).kind === "neutral");
check("one translation colour per language", subtitleTint(["ar", "en", "fa"]).translations.length === 3);
check(
  "Arabic and English translations keep their colours together",
  subtitleTint(["ar", "en"]).translations[0] === subtitleTint(["ar"]).translations[0] &&
    subtitleTint(["ar", "en"]).translations[1] === subtitleTint(["en"]).translations[0]
);

/* ---------- server: cue list and frame ---------- */

{
  const tidy = tidyCues(
    [
      { file: "b.png", start: 3, end: 5 },
      { file: "a.png", start: 1, end: 3.5 },
      { file: "late.png", start: 12, end: 13 },
      { file: "bad.png", start: NaN, end: 2 },
    ],
    10
  );
  check("server sorts cues and trims overlaps", tidy.map((c) => c.file).join() === "a.png,b.png" && near(tidy[0].end, 3, 1e-9), JSON.stringify(tidy));
  const list = concatList(tidy, "blank.png", 10);
  const durations = [...list.matchAll(/duration ([\d.]+)/g)].map((m) => Number(m[1]));
  check("concat list adds up to past the video's end", durations.reduce((a, b) => a + b, 0) >= 10, list);
  check("concat list holds each cue for its span", list.includes("file 'a.png'\noption framerate 1000\nduration 2.000"), list);
  check("concat list names the last file twice", /file 'blank.png'\noption framerate 1000\n$/.test(list));
}

check("crop fills the frame", frameFilter("crop", { width: 1920, height: 1080 }, 1080, 1920).includes("force_original_aspect_ratio=increase,crop=1080:1920"));
check("blur puts the picture over a blurred copy", frameFilter("blur", { width: 1920, height: 1080 }, 1080, 1920).includes("boxblur"));
check("an upright video needs no blur", !frameFilter("blur", { width: 720, height: 1280 }, 1080, 1920).includes("boxblur"));

done("subtitles");
