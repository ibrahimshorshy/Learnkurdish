import {
  alignedMode,
  alignedPrompt,
  alignedSchema,
  alignedToRawLines,
  knownSentences,
} from "../src/config/prompts/aligned.ts";
import { transcribeMode } from "../src/config/transcribeModes.ts";
import { findTaughtLanguage } from "../src/config/languages.ts";
import { normalizeTranscript } from "../src/utils/transcript.ts";
import { toScript, matchLinesToScript } from "../src/utils/storyText.ts";
import { check, near, done } from "./harness.mjs";

const language = findTaughtLanguage("ckb");
const script = toScript(`ڕۆژێک لە ڕۆژان کوڕێک هەبوو. ناوی ئازاد بوو.

ڕۆژێک چووە بازاڕ. سێوێکی کڕی.

کۆتایی.`);
const input = { language, durationSeconds: 20, knownLines: script, context: "Names: Azad" };

/* ---------- registry ---------- */

check("aligned mode is registered", transcribeMode("aligned") === alignedMode);

/* ---------- known sentences ---------- */

const known = knownSentences(input);
check("five sentences", known.length === 5);
check("numbered from 1", known[0].n === 1 && known[4].n === 5);
check("markers stripped", known.every((s) => !s.text.includes("¶")));
check("paragraph starts kept", known.map((s) => s.paragraphStart).join() === "true,false,true,false,true");
check("lesson script: no paragraphs", knownSentences({ knownLines: ["a", "b"] }).every((s) => !s.paragraphStart));
const blanks = knownSentences({ knownLines: ["¶ ", "a", "", "b"] });
check("blank entries are not numbered", blanks.length === 2 && blanks[1].n === 2);
check("a mark on a blank entry passes on", blanks[0].paragraphStart === true && blanks[1].paragraphStart === false);
check("no known lines", knownSentences({}).length === 0);

/* ---------- prompt ---------- */

const prompt = alignedPrompt(input);
check("prompt numbers the sentences", prompt.includes("1. ڕۆژێک لە ڕۆژان کوڕێک هەبوو.") && prompt.includes("5. کۆتایی."));
check("prompt never shows the marker", !prompt.includes("¶"));
check("prompt bounds the timestamps by the duration", prompt.includes("20.00"));
check("prompt asks for two decimals", /two decimals/.test(prompt));
check("prompt asks for every number", prompt.includes("exactly 5 entries"));
check("prompt forbids rewriting", /Do not transcribe, rewrite, correct/.test(prompt));
check("prompt carries the context", prompt.includes("Names: Azad"));
check("prompt names the variety", prompt.includes("Sorani"));
check("one sentence: singular", alignedPrompt({ ...input, knownLines: ["a"] }).includes("exactly 1 entry,"));
check("system prompt", /never rewrite/.test(alignedMode.systemPrompt(input)));

const schema = alignedSchema();
const item = schema.properties.sentences.items;
check("schema asks for n, heard, start, end", ["n", "heard", "start", "end"].every((k) => item.required.includes(k)));
check("schema types", item.properties.heard.type === "BOOLEAN" && item.properties.n.type === "INTEGER");

/* ---------- answer → lines ---------- */

const answer = {
  sentences: [
    { n: 1, heard: true, start: 0.4, end: 3.1 },
    { n: 2, heard: true, start: 3.5, end: 5.2 },
    { n: 3, heard: true, start: 6.4, end: 8.0 },
    { n: 4, heard: true, start: 8.3, end: 9.9 },
    { n: 5, heard: true, start: 11.0, end: 12.0 },
  ],
};
const lines = alignedToRawLines(answer, input);
check("one line per heard sentence", lines.length === 5);
check("text comes from the script", lines[0].text === "ڕۆژێک لە ڕۆژان کوڕێک هەبوو." && lines[4].text === "کۆتایی.");
check("times come from the model", lines[2].start === 6.4 && lines[2].end === 8.0);
check("paragraph starts on the lines", lines.map((l) => Boolean(l.paragraphStart)).join() === "true,false,true,false,true");

const rewritten = alignedToRawLines(
  { sentences: answer.sentences.map((s) => ({ ...s, text: "something else" })) },
  input
);
check("a text the model sends back is ignored", rewritten[0].text === "ڕۆژێک لە ڕۆژان کوڕێک هەبوو.");

const shuffled = alignedToRawLines({ sentences: [...answer.sentences].reverse() }, input);
check("entries matched by number, not position", shuffled[0].start === 0.4 && shuffled[4].start === 11.0);

const skipped = alignedToRawLines(
  {
    sentences: answer.sentences.map((s) => (s.n === 3 ? { ...s, heard: false, start: 0, end: 0 } : s)),
  },
  input
);
check("a sentence not heard is dropped", skipped.length === 4 && !skipped.some((l) => l.text === "ڕۆژێک چووە بازاڕ."));
check("its paragraph start passes to the next sentence read", skipped[2].text === "سێوێکی کڕی." && skipped[2].paragraphStart === true);

const wholeParagraphSkipped = alignedToRawLines(
  { sentences: answer.sentences.map((s) => (s.n === 3 || s.n === 4 ? { ...s, heard: false } : s)) },
  input
);
check(
  "a whole paragraph skipped: still one paragraph start",
  wholeParagraphSkipped.length === 3 && wholeParagraphSkipped[2].paragraphStart === true
);

const stringy = alignedToRawLines(
  { sentences: answer.sentences.map((s) => (s.n === 2 ? { ...s, heard: "false" } : { ...s, heard: "true" })) },
  input
);
check('heard: "false" as a string is not heard', stringy.length === 4);

const noFlag = alignedToRawLines(
  { sentences: answer.sentences.map(({ heard, ...rest }) => (rest.n === 5 ? { ...rest, start: 0, end: 0 } : rest)) },
  input
);
check("no heard flag: a span counts as heard, 0–0 does not", noFlag.length === 4);

const noNumbers = alignedToRawLines({ sentences: answer.sentences.map(({ n, ...rest }) => rest) }, input);
check("no numbers: matched by position", noNumbers.length === 5 && noNumbers[3].start === 8.3);

const duplicateNumbers = alignedToRawLines(
  { sentences: [answer.sentences[0], { ...answer.sentences[0], start: 99 }, ...answer.sentences.slice(1)] },
  input
);
check("a repeated number keeps the first", duplicateNumbers[0].start === 0.4 && duplicateNumbers.length === 5);

const missing = alignedToRawLines({ sentences: answer.sentences.slice(0, 3) }, input);
check("sentences the model left out are dropped", missing.length === 3);

check('a "lines" key is accepted', alignedToRawLines({ lines: answer.sentences }, input).length === 5);
check("malformed answer: no lines", alignedToRawLines(null, input).length === 0 && alignedToRawLines({}, input).length === 0);
check("no script: no lines", alignedToRawLines(answer, { ...input, knownLines: [] }).length === 0);

const lesson = alignedToRawLines(
  { sentences: [{ n: 1, heard: true, start: 0.2, end: 1 }, { n: 2, heard: true, start: 1.4, end: 2 }] },
  { language, durationSeconds: 3, knownLines: ["سڵاو", "چۆنی؟"] }
);
check("lesson script: lines without paragraphs", lesson.length === 2 && lesson.every((l) => l.paragraphStart === undefined));

/* ---------- through the server's normalizer ---------- */

const normalized = normalizeTranscript(alignedMode.toRawLines(answer, input), input.durationSeconds);
check("normalized: times trusted", normalized.timesTrusted);
check("normalized: paragraph starts survive", normalized.lines.filter((l) => l.paragraphStart).length === 3);
check("normalized: text intact", normalized.lines[1].text === "ناوی ئازاد بوو.");
check("normalized: times intact", near(normalized.lines[3].start, 8.3, 1e-9));

const stringTimes = normalizeTranscript(
  alignedMode.toRawLines(
    { sentences: answer.sentences.map((s) => ({ ...s, start: `00:${String(Math.floor(s.start)).padStart(2, "0")}.50`, end: String(s.end) })) },
    input
  ),
  20
);
check("normalized: string timestamps read", stringTimes.timesTrusted && near(stringTimes.lines[0].start, 0.5, 1e-9));

/* ---------- the script's text and order are kept (as the server runs it) ---------- */

check("aligned mode keeps the text and the order", alignedMode.normalize?.keepText === true && alignedMode.normalize?.keepOrder === true);
check("the other modes clean and sort", transcribeMode("lines").normalize === undefined && transcribeMode("dialogue").normalize === undefined);

const serverRun = (data, knownLines, durationSeconds) =>
  normalizeTranscript(alignedMode.toRawLines(data, { language, durationSeconds, knownLines }), durationSeconds, alignedMode.normalize);

const quoted = ["¶ ئازاد گوتی: «بەیانی دێم.»", "«چۆنی؟»", 'He said "go."', "¶ 1. یەکەم شت.", "2. دووەم شت.", "- بۆ کوێ دەچیت؟"];
const quotedLines = serverRun(
  { sentences: quoted.map((_, i) => ({ n: i + 1, heard: true, start: i * 3 + 0.5, end: i * 3 + 2.5 })) },
  quoted,
  20
);
check(
  "quotes, list numbers and dashes reach the lines as written",
  quotedLines.lines.map((l) => l.text).join("|") ===
    "ئازاد گوتی: «بەیانی دێم.»|«چۆنی؟»|He said \"go.\"|1. یەکەم شت.|2. دووەم شت.|- بۆ کوێ دەچیت؟",
  JSON.stringify(quotedLines.lines.map((l) => l.text))
);
check(
  "a fresh transcription matches its own text",
  JSON.stringify(matchLinesToScript(quotedLines.lines.map((l) => l.text), quoted)) === JSON.stringify({ strayLines: 0, missingSentences: 0 })
);

const crossed = serverRun(
  {
    sentences: [
      { n: 1, heard: true, start: 1, end: 3 },
      { n: 2, heard: true, start: 5.3, end: 6 },
      { n: 3, heard: true, start: 5.0, end: 8 },
    ],
  },
  ["¶ یەک.", "¶ دوو.", "سێ."],
  10
);
check("starts that cross a little: the text's order is kept", crossed.lines.map((l) => l.text).join() === "یەک.,دوو.,سێ.");
check("starts that cross a little: paragraph 2 still starts on sentence 2", crossed.lines[1].paragraphStart === true && !crossed.lines[2].paragraphStart);
check("starts that cross a little: times still trusted", crossed.timesTrusted);

done("aligned transcription");
