/**
 * A pasted story, cut into paragraphs and sentences, and the script form the
 * transcriber aligns against.
 *
 * Every sentence becomes one line of the reading video, so where the text is
 * cut matters as much as the words. The rules:
 *
 *   - a blank line starts a new paragraph
 *   - a single line break always ends a sentence (a poem, a list, a heading)
 *   - . ! ? ؟ ؛ … ۔ end a sentence, and stay with it, together with any closing
 *     quote or bracket straight after them
 *   - a full stop does not end a sentence inside a number (3.5, ١٠.٥), in a
 *     web address, after a one-letter abbreviation (د. ئەحمەد, م. ئازاد,
 *     J. K. Rowling), after a dotted abbreviation (U.S., پ.ز.) or a known Latin
 *     one (Mr., Dr., e.g.), or after list numbering at the start of a line
 *   - inside «…», “…”, "…" and (…), nothing ends a sentence until the quote
 *     closes: a line of dialogue stays whole instead of leaving half a quote
 *     on screen
 *
 * The script is the list of sentences, in order, with the first sentence of
 * each paragraph marked by PARAGRAPH_MARK. It is what project.script holds and
 * what the "aligned" transcription mode receives as known lines.
 *
 * Pure except readStoryFile, which only touches a File when called: imported by
 * the server (through the aligned prompt), the browser and the tests.
 */

/** Marks a sentence that starts a paragraph, in project.script. */
export const PARAGRAPH_MARK = "¶ ";

export interface StorySplit {
  /** Each paragraph is its sentences, in order. Never contains an empty one. */
  paragraphs: string[][];
}

/* ------------------------------------------------------------------ */
/* Characters                                                           */
/* ------------------------------------------------------------------ */

/** Always end a sentence, wherever they are (outside a quote). */
const STRONG_ENDS = new Set(["!", "?", "؟", "؛", "…", "۔"]);
/** A closing mark that belongs to the sentence it follows. */
const CLOSERS = new Set(["»", "”", "’", "\"", "'", ")", "]", "›"]);
/** Pairs that hold a sentence open until they close. */
const OPENERS: Record<string, string> = { "«": "»", "“": "”", "„": "”", "(": ")" };

const DIGIT = /[0-9٠-٩۰-۹]/;
const LETTER = /\p{L}/u;
const WHITESPACE = /\s/;

/** Latin abbreviations that take a full stop and rarely end a sentence. */
const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "prof", "st", "jr", "sr", "vs", "mt"]);

/**
 * Invisible characters that only get in the way: byte order marks, bidi
 * controls and zero-width spaces. The zero-width non-joiner and joiner are
 * kept — they are part of how Sorani and Persian words are spelled.
 */
const INVISIBLES = /[​‎‏‪-‮⁦-⁩﻿]/g;

/* ------------------------------------------------------------------ */
/* Sentences                                                            */
/* ------------------------------------------------------------------ */

/** The word in front of position `end` (exclusive), back to the last space. */
function wordBefore(text: string, end: number): string {
  let i = end;
  while (i > 0 && !WHITESPACE.test(text[i - 1])) i--;
  return text.slice(i, end);
}

/**
 * Whether a lone full stop at `at` is part of the word rather than the end of
 * the sentence. Only called when the stop is followed by whitespace or the
 * end of the line — a stop with text straight after it (3.5, a.com, د.ئەحمەد)
 * never ends a sentence anyway.
 */
function isAbbreviationStop(line: string, at: number, sentenceStart: number): boolean {
  const word = wordBefore(line, at).replace(/^[«“„"'(\[]+/, "");
  if (!word) return false;
  // One letter: an initial or a Sorani abbreviation like د. (doctor) or م. (teacher).
  if ([...word].length === 1 && LETTER.test(word)) return true;
  // Dotted letters: U.S. / e.g. / پ.ز. — the stop being looked at is the last one.
  if (/^(?:\p{L}\.)+\p{L}$/u.test(word)) return true;
  if (ABBREVIATIONS.has(word.toLowerCase())) return true;
  // "1. " or "١. " at the very start of the line is list numbering.
  const sofar = line.slice(sentenceStart, at).trim();
  if (sentenceStart === 0 && /^[0-9٠-٩۰-۹]{1,3}$/.test(sofar)) return true;
  return false;
}

/**
 * Splits one line of text (no line breaks) into sentences, punctuation kept
 * with the sentence it ends.
 */
export function splitSentences(line: string): string[] {
  const text = line.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const result = cutSentences(text, true);
  // A quote or bracket that never closes would hold the rest of the line in
  // one sentence; split that line as if it had no quotes at all.
  return result.balanced ? result.sentences : cutSentences(text, false).sentences;
}

function cutSentences(text: string, trackQuotes: boolean): { sentences: string[]; balanced: boolean } {
  const out: string[] = [];
  let start = 0;
  // Open quotes and brackets, as the character that closes each, innermost last.
  const open: string[] = [];
  // A straight " opens and closes itself.
  let straight = false;
  const inside = () => open.length > 0 || straight;

  const cut = (end: number) => {
    const sentence = text.slice(start, end).trim();
    if (sentence) out.push(sentence);
    start = end;
  };

  /** After a quote closes on an end mark — «چۆنی؟» — the sentence ends with it. */
  const closeQuote = (after: number): number => {
    // The end mark may sit inside more than one closing mark: («چۆنی؟»)
    let back = after - 2;
    while (back >= 0 && CLOSERS.has(text[back])) back--;
    if (inside() || !isEndMark(text[back] ?? "")) return after;
    let j = after;
    while (j < text.length && CLOSERS.has(text[j]) && text[j] !== "\"") j++;
    if (!endsHere(text, j)) return after;
    cut(j);
    return j;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (trackQuotes) {
      if (ch === "\"") {
        straight = !straight;
        i = straight ? i + 1 : closeQuote(i + 1);
        continue;
      }
      if (open.length && ch === open[open.length - 1]) {
        open.pop();
        i = closeQuote(i + 1);
        continue;
      }
      if (OPENERS[ch]) {
        open.push(OPENERS[ch]);
        i++;
        continue;
      }
    }

    if (!isEndMark(ch)) {
      i++;
      continue;
    }

    // A run of end marks: "?!", "...", "؟!".
    let j = i;
    while (j < text.length && isEndMark(text[j])) j++;
    const run = text.slice(i, j);
    if (inside()) {
      i = j;
      continue;
    }
    // Closing marks straight after belong to this sentence: ".»", "?)".
    let k = j;
    while (k < text.length && CLOSERS.has(text[k]) && !(trackQuotes && text[k] === "\"")) k++;

    const strong = [...run].some((c) => STRONG_ENDS.has(c)) || run.length > 1;
    if (strong) {
      cut(k);
      i = k;
      continue;
    }

    // A single full stop. Text straight after it (3.5, a.com, د.ئەحمەد) means
    // it is inside a word; an abbreviation or list number keeps the sentence going.
    if (!endsHere(text, k) || (k === j && isAbbreviationStop(text, i, start))) {
      i = k;
      continue;
    }
    cut(k);
    i = k;
  }
  cut(text.length);
  return { sentences: out, balanced: !inside() };
}

function isEndMark(ch: string): boolean {
  return ch === "." || STRONG_ENDS.has(ch);
}

/** True when position `at` is the end of the text or a space. */
function endsHere(text: string, at: number): boolean {
  return at >= text.length || WHITESPACE.test(text[at]);
}

/* ------------------------------------------------------------------ */
/* Paragraphs and the script                                            */
/* ------------------------------------------------------------------ */

/** Line endings unified, invisible marks removed, a pasted ¶ turned into a paragraph break. */
export function cleanStoryText(text: string): string {
  return (text || "")
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLES, "")
    .replace(/ /g, " ")
    .replace(/^[ \t]*¶[ \t]*/gm, "\n");
}

/** The story as paragraphs of sentences. */
export function splitStory(text: string): StorySplit {
  const paragraphs = cleanStoryText(text)
    .split(/\n[ \t]*\n/)
    .map((block) =>
      block
        .split("\n")
        .flatMap((line) => splitSentences(line))
        .filter(Boolean)
    )
    .filter((sentences) => sentences.length > 0);
  return { paragraphs };
}

/** The story as project.script: one sentence per entry, paragraph starts marked. */
export function toScript(text: string): string[] {
  return splitStory(text).paragraphs.flatMap((sentences) =>
    sentences.map((sentence, i) => (i === 0 ? `${PARAGRAPH_MARK}${sentence}` : sentence))
  );
}

/** A script line without its marker, and whether it starts a paragraph. */
export function stripMarker(line: string): { text: string; paragraphStart: boolean } {
  const raw = String(line ?? "");
  const match = /^\s*¶\s*/.exec(raw);
  return match ? { text: raw.slice(match[0].length).trim(), paragraphStart: true } : { text: raw.trim(), paragraphStart: false };
}

/**
 * A script back into paragraphs of sentences. A script with no markers at all
 * (a lesson script) is one paragraph.
 */
export function scriptParagraphs(script: string[] | undefined): string[][] {
  const paragraphs: string[][] = [];
  for (const line of script ?? []) {
    const { text, paragraphStart } = stripMarker(line);
    if (paragraphStart || !paragraphs.length) {
      paragraphs.push([]);
    }
    if (text) paragraphs[paragraphs.length - 1].push(text);
  }
  return paragraphs.filter((p) => p.length > 0);
}

/** Paragraphs of sentences as plain text: sentences joined by a space, paragraphs by a blank line. */
export function paragraphsToText(paragraphs: string[][]): string {
  return paragraphs
    .map((sentences) => sentences.map((s) => s.trim()).filter(Boolean).join(" "))
    .filter(Boolean)
    .join("\n\n");
}

/** The text to show for a project that has a script but no pasted text. */
export function scriptToText(script: string[] | undefined): string {
  return paragraphsToText(scriptParagraphs(script));
}

/* ------------------------------------------------------------------ */
/* Numbers for the UI                                                   */
/* ------------------------------------------------------------------ */

export interface StoryStats {
  paragraphs: number;
  sentences: number;
  words: number;
  /** A rough time to read it aloud, in seconds. */
  readingSeconds: number;
}

/**
 * Read aloud carefully for learners, Sorani runs at about two words a second;
 * a short breath between sentences and a longer one between paragraphs.
 */
const WORDS_PER_SECOND = 2;

export function storyStats(split: StorySplit): StoryStats {
  const sentences = split.paragraphs.flat();
  const words = sentences.reduce((n, s) => n + s.split(/\s+/).filter(Boolean).length, 0);
  return {
    paragraphs: split.paragraphs.length,
    sentences: sentences.length,
    words,
    readingSeconds: words / WORDS_PER_SECOND + sentences.length * 0.4 + split.paragraphs.length * 0.6,
  };
}

/* ------------------------------------------------------------------ */
/* Matching the text against transcribed lines                          */
/* ------------------------------------------------------------------ */

/** What is compared: no punctuation, quotes or spacing, so a cleaned-up line still matches. */
export function sentenceKey(text: string): string {
  return (text || "")
    .normalize("NFC")
    .replace(INVISIBLES, "")
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .toLowerCase();
}

export interface TextMatch {
  /** Lines whose words are not in the text, in order — the text changed after transcribing, or the line was edited. */
  strayLines: number;
  /** Sentences of the text that no line holds — not heard in the recording, or added afterwards. */
  missingSentences: number;
}

/**
 * How a project's lines line up with its script: the lines should be the
 * script's sentences, in order, minus any the reader skipped.
 *
 * Lines merged or split on the transcript step still match: a line that is two
 * or more sentences in a row, or a sentence spread over two or more lines in a
 * row, pairs up as a whole, however many there are. Their words are all in the
 * text, and a text built from such lines (one line per text line) splits back
 * into the same words.
 */
export function matchLinesToScript(lineTexts: string[], script: string[] | undefined): TextMatch {
  const sentences = (script ?? []).map((l) => sentenceKey(stripMarker(l).text)).filter(Boolean);
  const lines = lineTexts.map(sentenceKey).filter(Boolean);
  const n = lines.length;
  const m = sentences.length;

  // An ordered pairing, like a longest common subsequence, except that one
  // line may pair with any number of sentences in a row and the other way
  // round. score: lines and sentences paired; paired: of which lines.
  const width = m + 1;
  const score = new Int32Array((n + 1) * width);
  const paired = new Int32Array((n + 1) * width);
  let best = 0;
  let bestLines = 0;
  /** Reaching the current cell from cell `from`, pairing `lineCount` lines with `sentenceCount` sentences. */
  const take = (from: number, lineCount: number, sentenceCount: number) => {
    const s = score[from] + lineCount + sentenceCount;
    const p = paired[from] + lineCount;
    if (s > best || (s === best && p > bestLines)) {
      best = s;
      bestLines = p;
    }
  };
  /**
   * How many keys in a row, read back from keys[last], run together into
   * exactly `whole`; 0 if they do not. Each step checks that the run so far
   * is still the end of `whole`, so a mismatch stops it at once.
   */
  const joinedCount = (whole: string, keys: string[], last: number): number => {
    let length = 0;
    for (let k = 1; k <= last + 1; k++) {
      const key = keys[last + 1 - k];
      length += key.length;
      if (length > whole.length || !whole.startsWith(key, whole.length - length)) return 0;
      if (length === whole.length) return k;
    }
    return 0;
  };
  for (let i = 1; i <= n; i++) {
    const line = lines[i - 1];
    for (let j = 1; j <= m; j++) {
      const sentence = sentences[j - 1];
      best = -1;
      bestLines = 0;
      take((i - 1) * width + j, 0, 0); // the line is stray
      take(i * width + j - 1, 0, 0); // the sentence is missing
      // One line, one or more sentences in a row.
      const merged = joinedCount(line, sentences, j - 1);
      if (merged) take((i - 1) * width + j - merged, 1, merged);
      // One sentence over two or more lines in a row.
      if (line.length < sentence.length) {
        const split = joinedCount(sentence, lines, i - 1);
        if (split) take((i - split) * width + j - 1, split, 1);
      }
      score[i * width + j] = best;
      paired[i * width + j] = bestLines;
    }
  }
  const pairedLines = paired[n * width + m];
  const pairedSentences = score[n * width + m] - pairedLines;
  return { strayLines: n - pairedLines, missingSentences: m - pairedSentences };
}

/**
 * Transcribed lines back into story text: one line per text line, a blank
 * line before each paragraph. What "Use the sentences as the text" writes.
 * A line holding two sentences is split again when the text becomes the
 * script, and matchLinesToScript pairs it with both.
 */
export function linesToStoryText(lines: { kurdish: string; paragraphStart?: boolean }[]): string {
  const paragraphs: string[][] = [];
  lines.forEach((line, i) => {
    const text = line.kurdish.replace(/\s+/g, " ").trim();
    if (!text) return;
    if (i === 0 || line.paragraphStart || !paragraphs.length) paragraphs.push([]);
    paragraphs[paragraphs.length - 1].push(text);
  });
  return paragraphs.map((p) => p.join("\n")).join("\n\n");
}

/* ------------------------------------------------------------------ */
/* Files                                                                */
/* ------------------------------------------------------------------ */

/** What a story file may be. Anything else is refused with a clear message. */
export const STORY_FILE_ACCEPT = ".txt,.docx,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

interface MammothLike {
  extractRawText: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
}

/**
 * Reads a .txt or .docx file to plain text. Word documents are read with
 * mammoth's self-contained browser build, loaded only when one is opened, so
 * the app does not carry it otherwise.
 */
export async function readStoryFile(file: Blob & { name?: string }): Promise<string> {
  const name = (file.name || "").toLowerCase();
  const isDocx =
    name.endsWith(".docx") || file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const isText = name.endsWith(".txt") || file.type.startsWith("text/");

  if (isDocx) {
    const module: any = await import("mammoth/mammoth.browser.js");
    const mammoth: MammothLike = module?.extractRawText ? module : module?.default;
    if (!mammoth?.extractRawText) throw new Error("Could not load the Word reader.");
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    // Word puts a blank line after every paragraph; keep at most one.
    return cleanStoryText(result.value).replace(/\n{3,}/g, "\n\n").trim();
  }
  if (name.endsWith(".doc") || name.endsWith(".rtf") || name.endsWith(".odt") || name.endsWith(".pdf")) {
    throw new Error("That kind of file cannot be read here. Save it as .docx or .txt (or copy the text) and try again.");
  }
  if (isText || !name.includes(".")) {
    const text = decodeText(await file.arrayBuffer());
    return cleanStoryText(text).trim();
  }
  throw new Error("Upload a .txt or .docx file — or paste the text straight into the box.");
}

/**
 * UTF-8, unless the file says otherwise with a byte order mark. Windows
 * Notepad still saves UTF-16 with a BOM when asked for "Unicode".
 */
function decodeText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  return new TextDecoder("utf-8").decode(bytes);
}
