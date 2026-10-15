import JSZip from "jszip";
import {
  PARAGRAPH_MARK,
  splitSentences,
  splitStory,
  toScript,
  stripMarker,
  scriptParagraphs,
  scriptToText,
  paragraphsToText,
  storyStats,
  matchLinesToScript,
  sentenceKey,
  readStoryFile,
  cleanStoryText,
} from "../src/utils/storyText.ts";
import { check, done } from "./harness.mjs";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (v) => JSON.stringify(v);

/* ---------- sentences ---------- */

const sorani = splitSentences("ڕۆژێک لە ڕۆژان کوڕێک هەبوو. ناوی ئازاد بوو! دەیزانی؟ نەخێر.");
check("Sorani: splits on . ! ؟", same(sorani, ["ڕۆژێک لە ڕۆژان کوڕێک هەبوو.", "ناوی ئازاد بوو!", "دەیزانی؟", "نەخێر."]), show(sorani));

check("punctuation stays with its sentence", splitSentences("سڵاو. چۆنی؟")[1] === "چۆنی؟");
check("Arabic semicolon ends a sentence", same(splitSentences("هات؛ ڕۆیشت."), ["هات؛", "ڕۆیشت."]));
check("ellipsis character ends a sentence", same(splitSentences("وتی… نازانم."), ["وتی…", "نازانم."]));
check("three dots end a sentence, kept whole", same(splitSentences("Well... I know."), ["Well...", "I know."]));
check("?! stays together", same(splitSentences("Really?! Yes."), ["Really?!", "Yes."]));
check("؟! stays together", same(splitSentences("ڕاستە؟! بەڵێ."), ["ڕاستە؟!", "بەڵێ."]));
check("Urdu full stop ۔ ends a sentence", same(splitSentences("یەک۔ دوو۔"), ["یەک۔", "دوو۔"]));
check("no end mark: one sentence", same(splitSentences("سڵاو هاوڕێکەم"), ["سڵاو هاوڕێکەم"]));
check("text after the last mark is its own sentence", same(splitSentences("سڵاو. هاوڕێکەم"), ["سڵاو.", "هاوڕێکەم"]));
check("empty line: no sentences", splitSentences("   ").length === 0);
check("spaces collapsed", same(splitSentences("aa   bb.   cc."), ["aa bb.", "cc."]));
check("a one-letter word before a stop is read as an initial", same(splitSentences("Plan a. Then b."), ["Plan a. Then b."]));

// Numbers and abbreviations.
check("Latin decimal not split", same(splitSentences("It costs 3.5 dollars. Cheap."), ["It costs 3.5 dollars.", "Cheap."]));
check("Arabic-Indic decimal not split", same(splitSentences("نرخی ٣.٥ دینارە. هەرزانە."), ["نرخی ٣.٥ دینارە.", "هەرزانە."]));
check("Persian digits decimal not split", same(splitSentences("۱۰.۵ کیلۆ. زۆرە."), ["۱۰.۵ کیلۆ.", "زۆرە."]));
check("year at the end of a sentence still splits", same(splitSentences("لە ساڵی ٢٠٢٤. دواتر هات."), ["لە ساڵی ٢٠٢٤.", "دواتر هات."]));
check("د. abbreviation not split", same(splitSentences("د. ئەحمەد هات. نەخۆشەکەی بینی."), ["د. ئەحمەد هات.", "نەخۆشەکەی بینی."]));
check("م. abbreviation mid-sentence", same(splitSentences("ئەمڕۆ م. ئازاد وانەی وتەوە."), ["ئەمڕۆ م. ئازاد وانەی وتەوە."]));
check("د.ئەحمەد with no space", same(splitSentences("د.ئەحمەد هات."), ["د.ئەحمەد هات."]));
check("initials not split", same(splitSentences("J. K. Rowling wrote it. Then more."), ["J. K. Rowling wrote it.", "Then more."]));
check("U.S. not split", same(splitSentences("He went to the U.S. last year."), ["He went to the U.S. last year."]));
check("e.g. not split", same(splitSentences("Fruit, e.g. apples, is good. Yes."), ["Fruit, e.g. apples, is good.", "Yes."]));
check("Mr. not split", same(splitSentences("Mr. Smith came. He sat."), ["Mr. Smith came.", "He sat."]));
check("پ.ز. not split", same(splitSentences("ساڵی ٥٠٠ پ.ز. شارێک هەبوو."), ["ساڵی ٥٠٠ پ.ز. شارێک هەبوو."]));
check("web address not split", same(splitSentences("Visit leen.krd today. Bye."), ["Visit leen.krd today.", "Bye."]));
check("list number at line start not split", same(splitSentences("1. Go home."), ["1. Go home."]));
check("Kurdish list number at line start not split", same(splitSentences("١. بڕۆ ماڵەوە."), ["١. بڕۆ ماڵەوە."]));
check("the word no still ends a sentence", same(splitSentences("I said no. Then left."), ["I said no.", "Then left."]));

// Quotes.
check(
  "dialogue in «» stays whole",
  same(splitSentences("دایکم وتی: «وەرە ماڵەوە. نان ئامادەیە.» منیش چووم."), ["دایکم وتی: «وەرە ماڵەوە. نان ئامادەیە.»", "منیش چووم."]),
  show(splitSentences("دایکم وتی: «وەرە ماڵەوە. نان ئامادەیە.» منیش چووم."))
);
check("«چۆنی؟» ends with its quote", same(splitSentences("«چۆنی؟» وتی."), ["«چۆنی؟»", "وتی."]));
check("quote without an end mark does not split", same(splitSentences("وتی «باشە» و ڕۆیشت."), ["وتی «باشە» و ڕۆیشت."]));
check("straight quotes stay whole", same(splitSentences('He said "Go. Now." Then left.'), ['He said "Go. Now."', "Then left."]));
check("curly quotes stay whole", same(splitSentences("She said “Stop. Wait.” I did."), ["She said “Stop. Wait.”", "I did."]));
check("closing mark after a stop stays", same(splitSentences("(It was late.) We slept."), ["(It was late.)", "We slept."]));
check("quote inside brackets", same(splitSentences("(«چۆنی؟») وتی."), ["(«چۆنی؟»)", "وتی."]), show(splitSentences("(«چۆنی؟») وتی.")));
check(
  "an unclosed quote does not swallow the line",
  same(splitSentences("«وەرە ماڵەوە. نان ئامادەیە."), ["«وەرە ماڵەوە.", "نان ئامادەیە."]),
  show(splitSentences("«وەرە ماڵەوە. نان ئامادەیە."))
);
check("apostrophes are not quotes", same(splitSentences("Don't go. It's late."), ["Don't go.", "It's late."]));

/* ---------- paragraphs ---------- */

const story = `ڕۆژێک لە ڕۆژان کوڕێک هەبوو. ناوی ئازاد بوو.
ئازاد زۆر حەزی لە خوێندن بوو.

ڕۆژێک چووە بازاڕ! سێوێکی کڕی؟


کۆتایی.`;
const split = splitStory(story);
check("three paragraphs", split.paragraphs.length === 3, show(split.paragraphs));
check("line break ends a sentence", split.paragraphs[0].length === 3 && split.paragraphs[0][2] === "ئازاد زۆر حەزی لە خوێندن بوو.");
check("whitespace-only line is a paragraph break", split.paragraphs[2][0] === "کۆتایی.");
check("Windows line endings", splitStory("a.\r\n\r\nb.").paragraphs.length === 2);
check("many blank lines are one break", splitStory("a.\n\n\n\nb.").paragraphs.length === 2);
check("empty text", splitStory("").paragraphs.length === 0 && splitStory("  \n\n ").paragraphs.length === 0);
check("non-breaking spaces are spaces", same(splitStory("aa.\u00A0bb.").paragraphs[0], ["aa.", "bb."]));
check("invisible marks removed", splitStory("﻿‏سڵاو.").paragraphs[0][0] === "سڵاو.");
check("zero-width non-joiner kept", splitStory("دە‌چم.").paragraphs[0][0] === "دە‌چم.");
check("a pasted ¶ starts a paragraph", splitStory("a. b.\n¶ c.").paragraphs.length === 2);
check("cleanStoryText keeps text", cleanStoryText("a\r\nb") === "a\nb");

/* ---------- the script ---------- */

const script = toScript(story);
check("script has every sentence", script.length === 6, show(script));
check("first sentence is always marked", script[0].startsWith(PARAGRAPH_MARK));
check("paragraph starts are marked", script[3].startsWith(PARAGRAPH_MARK) && script[5].startsWith(PARAGRAPH_MARK));
check("other sentences are not", !script[1].startsWith(PARAGRAPH_MARK) && !script[4].startsWith(PARAGRAPH_MARK));
check("a one-sentence story", same(toScript("سڵاو."), [`${PARAGRAPH_MARK}سڵاو.`]));
check("an empty story", toScript("").length === 0);

check("stripMarker: marked", same(stripMarker("¶ سڵاو."), { text: "سڵاو.", paragraphStart: true }));
check("stripMarker: unmarked", same(stripMarker("سڵاو."), { text: "سڵاو.", paragraphStart: false }));
check("stripMarker: marker without a space", same(stripMarker("¶سڵاو."), { text: "سڵاو.", paragraphStart: true }));
check("stripMarker: leading space", same(stripMarker("  ¶  x "), { text: "x", paragraphStart: true }));
check("stripMarker: junk", same(stripMarker(undefined), { text: "", paragraphStart: false }));

check("scriptParagraphs round-trips", same(scriptParagraphs(script), split.paragraphs));
check("a lesson script is one paragraph", same(scriptParagraphs(["a", "b"]), [["a", "b"]]));
check("no script: nothing", scriptParagraphs(undefined).length === 0);
check("scriptToText then toScript round-trips the sentences", same(toScript(scriptToText(script)), script));
check("paragraphsToText", paragraphsToText([["a.", "b."], ["c."]]) === "a. b.\n\nc.");

const stats = storyStats(split);
check("stats count paragraphs and sentences", stats.paragraphs === 3 && stats.sentences === 6);
check("stats count words", stats.words === 20, String(stats.words));
check("reading time is plausible", stats.readingSeconds > 10 && stats.readingSeconds < 20, String(stats.readingSeconds));

/* ---------- matching lines to the text ---------- */

check("sentenceKey ignores punctuation and quotes", sentenceKey("«چۆنی؟»") === sentenceKey("چۆنی"));
const sentences = script.map((l) => stripMarker(l).text);
check("lines that are the text match", same(matchLinesToScript(sentences, script), { strayLines: 0, missingSentences: 0 }));
check(
  "a skipped sentence is missing, not stray",
  same(matchLinesToScript(sentences.filter((_, i) => i !== 2), script), { strayLines: 0, missingSentences: 1 })
);
check(
  "an edited text makes the old line stray",
  same(matchLinesToScript(sentences, toScript(story.replace("کۆتایی.", "تەواو."))), { strayLines: 1, missingSentences: 1 })
);
check(
  "lines out of order do not all pair up",
  matchLinesToScript([sentences[1], sentences[0]], script).strayLines === 1
);
check("no script: every line is stray", matchLinesToScript(["a"], []).strayLines === 1);
check("cleaned-up line (quotes stripped) still matches", matchLinesToScript(["چۆنی؟"], ["¶ «چۆنی؟»"]).strayLines === 0);

/* ---------- files ---------- */

const txt = new File([new TextEncoder().encode("سڵاو.\r\n\r\nچۆنی؟")], "story.txt", { type: "text/plain" });
check("reads a .txt file", (await readStoryFile(txt)) === "سڵاو.\n\nچۆنی؟");

const utf16 = new Uint8Array([0xff, 0xfe, ...new Uint8Array(new Uint16Array([...("سڵاو.")].map((c) => c.charCodeAt(0))).buffer)]);
check("reads a UTF-16 .txt file", (await readStoryFile(new File([utf16], "story.txt"))) === "سڵاو.");

// A minimal Word document: two paragraphs.
const zip = new JSZip();
zip.file(
  "[Content_Types].xml",
  `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
);
zip.file(
  "_rels/.rels",
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
);
zip.file(
  "word/document.xml",
  `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>ڕۆژێک لە ڕۆژان کوڕێک هەبوو. ناوی ئازاد بوو.</w:t></w:r></w:p><w:p><w:r><w:t>کۆتایی.</w:t></w:r></w:p></w:body></w:document>`
);
const docxBytes = await zip.generateAsync({ type: "uint8array" });
const docx = new File([docxBytes], "story.docx", {
  type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
});
let docxText = "";
try {
  docxText = await readStoryFile(docx);
} catch (err) {
  docxText = `ERROR ${err?.message}`;
}
check("reads a .docx file", docxText === "ڕۆژێک لە ڕۆژان کوڕێک هەبوو. ناوی ئازاد بوو.\n\nکۆتایی.", show(docxText));
check("a .docx becomes paragraphs", splitStory(docxText).paragraphs.length === 2);

let refused = "";
try {
  await readStoryFile(new File(["x"], "story.pdf", { type: "application/pdf" }));
} catch (err) {
  refused = err?.message || "";
}
check("a .pdf is refused with a message", /docx/.test(refused));

done("story text");
