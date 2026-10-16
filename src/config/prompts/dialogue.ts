/**
 * Transcription of a two-speaker dialogue.
 *
 * Built on the lesson prompt rather than beside it: everything that makes a
 * good lesson transcript — verbatim words, one line per sentence, Sorani
 * spelling, honest timestamps — is just as true of a dialogue, and keeping one
 * source for those rules means a fix to the Sorani spelling reaches both. What
 * a dialogue adds is who says each line.
 *
 * Telling two people apart by voice alone is not enough here. The teacher
 * often records both parts himself, changing his voice a little or not at
 * all, so the model is told to lean on how a conversation works — a question
 * is answered by the other person, a greeting is returned, someone addressed
 * by name is not the one speaking — as much as on the sound.
 *
 * The model numbers the speakers 1 and 2, the way a person would; the app
 * stores them as 0 and 1. toRawLines does that conversion and is the only
 * place that knows about it.
 *
 * Pure: imported by the server and the tests.
 */

import type { TranscribeInput, TranscribeModeSpec } from "../transcribeModes";
import type { RawTranscriptLine } from "../../utils/transcript";
import { transcribePrompt, transcribeSystemPrompt } from "../prompts";

/** A name the teacher typed, made safe to quote in a prompt. Empty when there is none. */
export function cleanSpeakerName(name: unknown): string {
  return String(name ?? "")
    .replace(/[\r\n\t"«»“”]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/** The two names as given, cleaned; either may be empty. */
export function speakerNames(input: Pick<TranscribeInput, "speakers">): [string, string] {
  const list = Array.isArray(input.speakers) ? input.speakers : [];
  return [cleanSpeakerName(list[0]), cleanSpeakerName(list[1])];
}

function namesBlock(input: TranscribeInput): string {
  const [first, second] = speakerNames(input);
  if (!first && !second) return "";

  const named = [
    first ? `speaker 1 is «${first}»` : "",
    second ? `speaker 2 is «${second}»` : "",
  ].filter(Boolean);
  const both = first && second;

  return `
THE SPEAKERS' NAMES
The teacher has named them: ${named.join(" and ")}.
- Use ${both ? "the names" : "the name"} to tell who is who: a line that greets or addresses ${both ? "one of them by name is said by the other one" : "someone by that name is said by the other speaker"}, and a line where someone says "I am …" or "my name is …" with ${both ? "a name" : "that name"} is said by that person.
- Only when nothing in the recording ties a line to a name does the order decide: speaker 1 is whoever speaks first.
- When a name is spoken, spell it the way it is written here.`;
}

/**
 * The lesson prompt, then what is different about a dialogue. The lesson
 * rules stay in force; the section below adds to them and says where one of
 * them reads differently for a conversation.
 */
export function dialoguePrompt(input: TranscribeInput): string {
  const base = transcribePrompt({
    language: input.language,
    durationSeconds: input.durationSeconds,
    context: input.context,
  });

  const named = speakerNames(input).some(Boolean);

  return `${base}

THIS RECORDING IS A DIALOGUE
It is a conversation between two people, recorded for a lesson that shows it as a chat between them. Everything above still applies, and in addition:

A. For every line also give "speaker": 1 or 2. ${named ? "Speaker 1 and speaker 2 are the people named below; where the recording does not show which is which, speaker 1 is whoever speaks first." : "Speaker 1 is whoever speaks first; speaker 2 is the other person."} There are never more than two.
B. The same person may be voicing both parts — the teacher often records a dialogue alone, sometimes changing his voice for the second person and sometimes not at all. So do not decide who is speaking by the sound of the voice alone. Use how a conversation works:
   - A question is normally answered by the other person, and a greeting, a thank-you or a goodbye is normally returned by the other person.
   - Someone addressed by name, or as "you", is the one listening, not the one speaking.
   - Turns usually alternate. The same person says two lines in a row only when the words show it — a statement followed by their own question, or a list they continue.
   - A pause, a change of pitch or tone, or a different voice usually marks a change of speaker.
C. One line belongs to one speaker. If one person says two sentences in a row, they are two lines with the same speaker. If the speaker changes in the middle of what sounds like one sentence, split it where the other person starts.
D. Both people are part of the recording, so rule 4's "said to someone else" never covers the two of them talking to each other — every turn of the conversation is a line.
E. If the teacher reads out who is speaking before a line, the way a script is read aloud ("Ahmad: …"), that label is not part of the line. Leave it out, start the line's time at the first word after it, and use it to choose the speaker. A name said inside a sentence, to call or greet someone, is part of the line — keep it.
${namesBlock(input)}`;
}

/**
 * The model's speaker number → the app's speaker index.
 *
 * 1 → 0 and 2 → 1; anything unreadable → 0, the first speaker, which the
 * transcript step lets the teacher change with one tap. `zeroBased` is for an
 * answer that numbered the speakers 0 and 1 despite being asked for 1 and 2.
 */
export function toSpeakerIndex(value: unknown, zeroBased = false): number {
  const n = typeof value === "string" ? Number(value.replace(/[^\d.-]/g, "") || NaN) : Number(value);
  if (!Number.isFinite(n)) return 0;
  if (zeroBased) return n === 1 ? 1 : 0;
  return n === 2 ? 1 : 0;
}

/**
 * A model asked for 1 and 2 occasionally answers 0 and 1. A 1-based answer
 * never contains 0, so an answer with a 0 and nothing above 1 can only be
 * 0-based — read that way, nobody is moved to the wrong side.
 */
function looksZeroBased(values: unknown[]): boolean {
  const numbers = values.map((v) => Number(v)).filter((n) => Number.isFinite(n));
  return numbers.includes(0) && numbers.every((n) => n === 0 || n === 1);
}

export const dialogueMode: TranscribeModeSpec = {
  systemPrompt: ({ language }) =>
    `${transcribeSystemPrompt(language)} You also say which of the two people in a conversation says each line.`,
  prompt: (input) => dialoguePrompt(input),
  schema: () => ({
    type: "OBJECT",
    properties: {
      lines: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            text: { type: "STRING" },
            start: { type: "NUMBER" },
            end: { type: "NUMBER" },
            speaker: { type: "INTEGER", description: "1 for whoever speaks first, 2 for the other person." },
          },
          required: ["text", "start", "end", "speaker"],
        },
      },
    },
    required: ["lines"],
  }),
  toRawLines: (data): RawTranscriptLine[] => {
    if (!Array.isArray(data?.lines)) return [];
    const items = data.lines.filter((l: unknown) => l && typeof l === "object");
    const zeroBased = looksZeroBased(items.map((l: any) => l.speaker));
    return items.map((l: any) => ({
      text: l.text,
      start: l.start,
      end: l.end,
      speaker: toSpeakerIndex(l.speaker, zeroBased),
    }));
  },
};
