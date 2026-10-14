import { AUDIENCE_LANGUAGES, TAUGHT_LANGUAGES, findTaughtLanguage, defaultAudienceIds } from "../src/config/languages.ts";
import { transcribePrompt, translatePrompt } from "../src/config/prompts.ts";
import { check, done } from "./harness.mjs";

check("Kurdish Sorani is the default taught language", findTaughtLanguage(undefined).id === "ckb");
check("unknown taught language falls back to Sorani", findTaughtLanguage("xx").id === "ckb");
check("Arabic and English are on by default", JSON.stringify(defaultAudienceIds()) === JSON.stringify(["ar", "en"]));

const ids = AUDIENCE_LANGUAGES.map((a) => a.id);
check("audience ids are unique", new Set(ids).size === ids.length);
for (const a of AUDIENCE_LANGUAGES) {
  const missing = Object.entries(a.strings).filter(([, v]) => !String(v).trim());
  check(`${a.label} has every on-video string`, missing.length === 0, missing.map(([k]) => k).join(","));
  check(`${a.label} has a translation brief`, a.brief.length > 40);
}
check("Arabic and Persian are right to left", AUDIENCE_LANGUAGES.filter((a) => a.rtl).map((a) => a.id).join() === "ar,fa");

const ckb = TAUGHT_LANGUAGES[0];
const tp = transcribePrompt({ language: ckb, durationSeconds: 12.345, context: "Greetings — names: Rêbwar" });
check("transcription prompt bounds the timestamps", tp.includes("12.35"));
check("transcription prompt carries the Sorani letters", tp.includes("ڕ") && tp.includes("ڵ") && tp.includes("ێ"));
check("transcription prompt carries the context", tp.includes("Rêbwar"));
check("transcription prompt forbids translating", /Do not translate/.test(tp));

const ar = AUDIENCE_LANGUAGES.find((a) => a.id === "ar");
const en = AUDIENCE_LANGUAGES.find((a) => a.id === "en");
const xp = translatePrompt({
  language: ckb,
  audiences: [ar, en],
  lines: ["چۆنی؟", "باشم، سوپاس"],
  note: "Keep the English very simple.",
  withTitles: true,
});
check("translation prompt numbers the lines", xp.includes("1. چۆنی؟") && xp.includes("2. باشم، سوپاس"));
check("translation prompt asks for each language by id", xp.includes('"ar"') && xp.includes('"en"'));
check("translation prompt carries the teacher's note", xp.includes("Keep the English very simple."));
check("translation prompt asks for titles when wanted", xp.includes('"titles"'));
check("the note is said to win", /the note wins/i.test(xp));

const single = translatePrompt({
  language: ckb,
  audiences: [en],
  lines: ["باشم"],
  withTitles: false,
  surrounding: ["چۆنی؟"],
});
check("single-line prompt has no titles", !single.includes('"titles"'));
check("single-line prompt shows the rest for context only", single.includes("for context only") && single.includes("· چۆنی؟"));
check("single-line prompt says one line", single.includes("Return exactly 1 line,"));

done("languages and prompts");
