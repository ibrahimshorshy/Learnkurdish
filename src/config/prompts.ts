/**
 * The two prompts the whole app rests on: hearing the Kurdish, and translating
 * it.
 *
 * Kept out of server.ts so they can be read and tested on their own, and pure
 * so the browser could build them too if it ever needed to.
 */

import type { AudienceLanguage, TaughtLanguage } from "./languages";

/* ------------------------------------------------------------------ */
/* Transcription                                                        */
/* ------------------------------------------------------------------ */

export interface TranscribePromptInput {
  language: TaughtLanguage;
  /** Length of the recording in seconds, so timestamps can be bounded. */
  durationSeconds: number;
  /** Optional words from the speaker about what the recording contains. */
  context?: string;
}

export function transcribeSystemPrompt(language: TaughtLanguage): string {
  return `You are a meticulous transcriber of ${language.label} (${language.endonym}) and a native speaker of it. You write down exactly what you hear, in correct ${language.label} spelling, and nothing else. You return only JSON matching the requested schema.`;
}

export function transcribePrompt({ language, durationSeconds, context }: TranscribePromptInput): string {
  const duration = Math.max(0, durationSeconds).toFixed(2);
  const contextBlock = context?.trim()
    ? `\nWHAT THE SPEAKER SAYS THIS RECORDING IS ABOUT (use it only to spell names and topic words correctly — never add a word that was not said):\n${context.trim()}\n`
    : "";

  return `Transcribe this recording of ${language.variety}.

A Kurdish teacher recorded these sentences for a short language-lesson video. Every sentence or short phrase they say becomes one line of the lesson, so how you split the lines matters as much as the words.

RULES
1. Verbatim. Write exactly the words that were spoken, in the dialect they were spoken in. Do not translate, explain, summarise, correct, complete or "improve" anything.
2. One line per sentence or short phrase, in the order spoken. Start a new line wherever the speaker pauses between sentences. Never merge two sentences into one line, and never split one short sentence across two lines.
3. A false start — an attempt the speaker abandons and immediately says again — is not a line. Keep only the final, complete attempt, and time the line to that attempt.
4. Leave out what is not part of the lesson: coughs, laughter, "umm" and "aaa" hesitations, and anything said off-mic to someone else.
5. Timestamps: for every line give "start" and "end" in seconds from the very beginning of the recording, as decimal numbers with two decimals (for example 3.25). "start" is the moment the first word begins; "end" is the moment the last word finishes. Lines must not overlap. The recording is ${duration} seconds long, so no timestamp may be larger than ${duration}.
6. Punctuation: end a question with ؟ and use ، for a comma, the way Sorani is printed. No other symbols.

SPELLING — these are not optional:
${language.orthography.map((rule) => `- ${rule}`).join("\n")}

NEVER:
${language.avoid.map((rule) => `- ${rule}`).join("\n")}
${contextBlock}
If the recording contains no speech, return an empty "lines" list.`;
}

/* ------------------------------------------------------------------ */
/* Translation                                                          */
/* ------------------------------------------------------------------ */

export interface TranslatePromptInput {
  language: TaughtLanguage;
  audiences: AudienceLanguage[];
  /** The Kurdish lines, in order. Numbered 1.. in the prompt. */
  lines: string[];
  /** The teacher's note on what to focus on. Overrides the defaults. */
  note?: string;
  context?: string;
  /** Whether to also ask for lesson titles and post captions. */
  withTitles: boolean;
  /**
   * The rest of the lesson, for context only, when a single line is being
   * re-translated. Never translated itself.
   */
  surrounding?: string[];
  /** What kind of text this is: lesson lines, a dialogue, a story or video subtitles. */
  kind?: string;
}

const KIND_NOTES: Record<string, string> = {
  dialogue:
    "These lines are a conversation between two people, in the order spoken. Keep forms of address, pronouns and politeness consistent with who is talking to whom.",
  story:
    "These lines are consecutive sentences of one story. Translate them so they read as one continuous text — consistent tense, names and pronouns from sentence to sentence.",
  video: "These lines are subtitles for a video of the teacher speaking, in the order spoken.",
};

export function translateSystemPrompt(language: TaughtLanguage): string {
  return `You are a professional translator and an experienced teacher of ${language.label} (${language.endonym}) to adults. You translate short spoken lines for subtitles in a language-learning video. You return only JSON matching the requested schema.`;
}

export function translatePrompt(input: TranslatePromptInput): string {
  const { language, audiences, lines, note, context, withTitles, surrounding, kind } = input;
  const kindNote = kind && KIND_NOTES[kind] ? `\n\n${KIND_NOTES[kind]}` : "";

  const perLine = [
    `- "n": the line number, unchanged.`,
    `- "transliteration": the ${language.label} line written in Latin letters so a learner can pronounce it. ${language.romanization}`,
    ...audiences.map(
      (a) => `- "${a.id}": the ${a.label} translation. ${a.brief}`
    ),
  ].join("\n");

  const titles = withTitles
    ? `

ALSO RETURN
- "titles": for each language (${audiences.map((a) => `"${a.id}"`).join(", ")}), a short title for this lesson, at most six words, in that language — what a learner will be able to say after watching (e.g. "Ordering food at a restaurant"). No quotation marks, no emoji.
- "captions": for each language, a ready-to-post caption for Instagram and TikTok in that language: one or two short, warm sentences about what the lesson teaches, then a blank line, then 5 to 8 hashtags that fit (always include #LearnKurdish and #Kurdish, plus some in that language).`
    : "";

  const noteBlock = note?.trim()
    ? `

THE TEACHER'S NOTE — follow it. Where it conflicts with the rules above, the note wins:
${note.trim()}`
    : "";

  const contextBlock = context?.trim() ? `\n\nTOPIC OF THE LESSON: ${context.trim()}` : "";

  const surroundingBlock = surrounding?.length
    ? `\n\nTHE REST OF THE LESSON, for context only — do not translate these:\n${surrounding
        .map((line) => `· ${line}`)
        .join("\n")}`
    : "";

  return `Below are numbered lines of ${language.variety}. A teacher recorded them for a short video that teaches ${language.label}. Translate every line for learners.${kindNote}

FOR EACH LINE RETURN
${perLine}

TRANSLATION RULES
- Translate the meaning the way a native speaker would say it, but stay close enough to the ${language.label} that a learner can match the words up.
- Keep each translation about as short as the line itself — it is a subtitle under the ${language.label}, read in a few seconds.
- No explanations, notes, brackets, alternatives or slashes inside a translation.
- Do not change, correct or comment on the ${language.label}. Translate what is there.
- Names stay names. Numbers stay numbers.
- Return exactly ${lines.length} line${lines.length === 1 ? "" : "s"}, one per numbered line, in order.${titles}${noteBlock}${contextBlock}${surroundingBlock}

LINES
${lines.map((line, i) => `${i + 1}. ${line}`).join("\n")}`;
}
