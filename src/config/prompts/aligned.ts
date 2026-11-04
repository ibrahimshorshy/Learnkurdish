/**
 * Alignment of a known text (a story, a script) to a recording of it being
 * read.
 *
 * When the words are already written down there is nothing to transcribe, and
 * asking a model to transcribe anyway invites it to "correct" the text, merge
 * sentences or drop a word it misheard. So this mode hands the model the
 * numbered sentences and asks one narrower question per sentence: where does
 * it start and end, and was it read at all? The text of every line comes back
 * from the script, never from the model.
 *
 * Sentences that start a paragraph are marked in the script (see
 * utils/storyText); the marks are stripped before the model sees anything and
 * put back on the lines afterwards. A lesson script has no marks, so its lines
 * have no paragraphs.
 *
 * Pure: imported by the server and the tests.
 */

import type { TranscribeInput, TranscribeModeSpec } from "../transcribeModes";
import type { RawTranscriptLine } from "../../utils/transcript";
import { stripMarker } from "../../utils/storyText";

export interface KnownSentence {
  /** 1-based, as numbered in the prompt. */
  n: number;
  text: string;
  paragraphStart: boolean;
}

/**
 * The script as the model sees it, numbered. Empty entries are left out of
 * the numbering; a paragraph mark on one passes to the next sentence.
 */
export function knownSentences(input: Pick<TranscribeInput, "knownLines">): KnownSentence[] {
  const out: KnownSentence[] = [];
  let carryParagraph = false;
  for (const line of input.knownLines ?? []) {
    const { text, paragraphStart } = stripMarker(line);
    if (!text) {
      carryParagraph = carryParagraph || paragraphStart;
      continue;
    }
    out.push({ n: out.length + 1, text, paragraphStart: paragraphStart || carryParagraph });
    carryParagraph = false;
  }
  return out;
}

export function alignedSystemPrompt({ language }: TranscribeInput): string {
  return `You are a meticulous listener of ${language.label} (${language.endonym}) and a native speaker of it. You are given a recording and the exact text that was read aloud in it, and you find where each sentence of that text is spoken. You never rewrite the text. You return only JSON matching the requested schema.`;
}

export function alignedPrompt(input: TranscribeInput): string {
  const { language, durationSeconds, context } = input;
  const sentences = knownSentences(input);
  const duration = Math.max(0, durationSeconds).toFixed(2);
  const count = sentences.length;
  const contextBlock = context?.trim()
    ? `\nWHAT THE SPEAKER SAYS THIS RECORDING IS ABOUT (only to help you recognise names and topic words):\n${context.trim()}\n`
    : "";

  return `A Kurdish teacher recorded himself reading the text below aloud, in ${language.variety}. The text is already written: it is numbered below, one sentence per number. Your job is only to find each sentence in the recording.

FOR EACH NUMBERED SENTENCE RETURN
- "n": its number, unchanged.
- "heard": true if the sentence was read aloud in the recording, even with a small slip or a word changed; false if it was skipped entirely.
- "start": the moment the first word of the sentence begins, in seconds from the very beginning of the recording.
- "end": the moment the last word of the sentence finishes, in seconds from the very beginning of the recording.

RULES
1. Do not transcribe, rewrite, correct, translate, merge or split the sentences. The text is fixed; you only give times.
2. The sentences were read in this order. Times must grow with the number, and two sentences must not overlap.
3. Timestamps are decimal numbers with two decimals (for example 3.25). The recording is ${duration} seconds long, so no timestamp may be larger than ${duration}.
4. "start" is where the speech of the sentence begins and "end" where it stops — do not include the silence before or after it.
5. If the reader stumbled and started a sentence again, time the final, complete reading of it.
6. Anything said that is not in the text — a comment, a cough, a word to someone in the room — belongs to no sentence; leave it out of every sentence's time.
7. If a sentence was not read at all, set "heard" to false and give 0 for both "start" and "end".
8. Return exactly ${count} entr${count === 1 ? "y" : "ies"}, one for every number from 1 to ${count}, in order.
${contextBlock}
THE TEXT
${sentences.map((s) => `${s.n}. ${s.text}`).join("\n")}`;
}

export function alignedSchema(): any {
  return {
    type: "OBJECT",
    properties: {
      sentences: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            n: { type: "INTEGER" },
            heard: { type: "BOOLEAN" },
            start: { type: "NUMBER" },
            end: { type: "NUMBER" },
          },
          required: ["n", "heard", "start", "end"],
        },
      },
    },
    required: ["sentences"],
  };
}

/** Reads "heard" leniently: a model may send "false", or leave it out and give no time. */
function wasHeard(entry: any): boolean {
  const flag = entry?.heard;
  if (flag === false || flag === 0) return false;
  if (typeof flag === "string") return !/^\s*(false|no|0)\s*$/i.test(flag);
  if (flag === true || flag === 1) return true;
  // No flag: heard if it was given a span at all.
  const start = Number(entry?.start);
  const end = Number(entry?.end);
  return !(Number.isFinite(start) && Number.isFinite(end) && start === 0 && end === 0);
}

/**
 * The model's answer → lines in the order of the text, with the text's own
 * words. Sentences that were not read are dropped; if one of them started a
 * paragraph, the next sentence that was read starts it instead, so the
 * paragraph is not lost.
 */
export function alignedToRawLines(data: any, input: TranscribeInput): RawTranscriptLine[] {
  const sentences = knownSentences(input);
  const entries: any[] = Array.isArray(data?.sentences)
    ? data.sentences
    : Array.isArray(data?.lines)
      ? data.lines
      : Array.isArray(data)
        ? data
        : [];
  if (!sentences.length || !entries.length) return [];

  // Match by the echoed number; when no entry carries a usable one, by position.
  const byNumber = new Map<number, any>();
  for (const entry of entries) {
    const n = Number(entry?.n);
    if (Number.isInteger(n) && n >= 1 && n <= sentences.length && !byNumber.has(n)) byNumber.set(n, entry);
  }
  const entryFor = (s: KnownSentence) => (byNumber.size ? byNumber.get(s.n) : entries[s.n - 1]);

  const out: RawTranscriptLine[] = [];
  let carryParagraph = false;
  for (const sentence of sentences) {
    const entry = entryFor(sentence);
    if (!entry || !wasHeard(entry)) {
      carryParagraph = carryParagraph || sentence.paragraphStart;
      continue;
    }
    const paragraphStart = sentence.paragraphStart || carryParagraph;
    out.push({
      text: sentence.text,
      start: entry.start,
      end: entry.end,
      ...(paragraphStart ? { paragraphStart: true } : {}),
    });
    carryParagraph = false;
  }
  return out;
}

export const alignedMode: TranscribeModeSpec = {
  systemPrompt: alignedSystemPrompt,
  prompt: alignedPrompt,
  schema: alignedSchema,
  toRawLines: alignedToRawLines,
  // The text and its order are the script's: the server must neither "clean"
  // a sentence (a quote, a dash, a list number are the teacher's) nor sort
  // the sentences by the model's rough times.
  normalize: { keepText: true, keepOrder: true },
};
