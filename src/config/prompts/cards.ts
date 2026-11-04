/**
 * Writing the title and closing cards: a line or two per audience language
 * that an AI voice reads aloud and the card shows.
 *
 * Kept pure, like the other prompts, so it can be read and tested on its own.
 */

import type { AudienceLanguage, TaughtLanguage } from "../languages";

export type CardWhich = "intro" | "outro";

/** How long a card's text may be. A card is on screen for a few seconds. */
export const CARD_MAX_WORDS = 12;

/** How many lines of the lesson the writer is shown — enough to know the topic. */
export const CARD_LINES_SENT = 12;

export interface CardWriteInput {
  which: CardWhich;
  /** lesson | video | dialogue | story */
  kind: string;
  language: TaughtLanguage;
  audiences: AudienceLanguage[];
  /** Lesson titles per audience language, when there are any. */
  titles: Record<string, string>;
  /** The first lines of the lesson, with their translations. */
  lines: { kurdish: string; translations: Record<string, string> }[];
  /** The teacher's own instruction for this card. */
  note?: string;
  /** What the card said last time, when the teacher asked for another version. */
  previous?: Record<string, string>;
}

const KIND_DESCRIPTIONS: Record<string, string> = {
  lesson:
    "a listen-and-repeat lesson: the teacher says short Kurdish phrases, each is played again, and the viewer repeats it",
  dialogue: "a short conversation between two people in Kurdish, shown as a chat thread",
  story: "a short story read aloud in Kurdish, sentence by sentence, with the translation underneath",
  video: "a video of the teacher speaking Kurdish, with subtitles",
};

const PURPOSE: Record<CardWhich, string> = {
  intro: `the OPENING card. It is the first thing a viewer hears, so it is a hook: tell the viewer, directly and warmly, what they are about to learn or hear, in a way that makes them stay for it. At most ${CARD_MAX_WORDS} words.`,
  outro: `the CLOSING card. Praise the viewer for practising and invite them to follow for more Kurdish (or to practise again, or to comment what they learned). Warm and short — at most ${CARD_MAX_WORDS} words.`,
};

export function cardWriteSystemPrompt(language: TaughtLanguage): string {
  return `You write short, warm, natural copy for language-learning videos that teach ${language.label} (${language.endonym}). Your words are read aloud by an AI voice and shown on screen. You return only JSON matching the requested schema.`;
}

export function cardWritePrompt(input: CardWriteInput): string {
  const { which, kind, language, audiences, titles, lines, note, previous } = input;
  const what = KIND_DESCRIPTIONS[kind] ?? KIND_DESCRIPTIONS.lesson;

  const titleBlock = audiences
    .map((a) => (titles[a.id]?.trim() ? `- ${a.label}: ${titles[a.id].trim()}` : ""))
    .filter(Boolean)
    .join("\n");

  const lineBlock = lines
    .slice(0, CARD_LINES_SENT)
    .map((line, i) => {
      const meaning = audiences
        .map((a) => (line.translations[a.id]?.trim() ? `${a.label}: ${line.translations[a.id].trim()}` : ""))
        .filter(Boolean)
        .join(" · ");
      return `${i + 1}. ${line.kurdish.trim()}${meaning ? `  (${meaning})` : ""}`;
    })
    .join("\n");

  const perLanguage = audiences.map((a) => `- "${a.id}": the card in ${a.label}. ${a.brief}`).join("\n");

  const previousBlock =
    previous && Object.values(previous).some((t) => t?.trim())
      ? `

THE TEACHER ASKED FOR A DIFFERENT VERSION. Do not repeat these or reword them closely:
${audiences
  .map((a) => (previous[a.id]?.trim() ? `- ${a.label}: ${previous[a.id].trim()}` : ""))
  .filter(Boolean)
  .join("\n")}`
      : "";

  const noteBlock = note?.trim()
    ? `

THE TEACHER'S NOTE — follow it. Where it conflicts with the rules above, the note wins:
${note.trim()}`
    : "";

  return `A ${language.label} teacher made a short vertical video for social media: ${what}. Write ${PURPOSE[which]}

RETURN, FOR EACH LANGUAGE
${perLanguage}

RULES
- One or two short sentences, at most ${CARD_MAX_WORDS} words, in the everyday register of that language — how a friendly teacher would actually say it.
- The same message in every language, but each one written naturally in its own language — not a word-for-word translation of another.
- It will be spoken by an AI voice that cannot pronounce ${language.label}, so never write ${language.label} words or ${language.label} script. Say "${language.label}" or describe the phrase instead.
- Plain words only: no emoji, no hashtags, no quotation marks, no brackets, no lists.
- Do not invent facts — no day numbers, names, levels or promises the material does not support.
${titleBlock ? `\nTHE VIDEO'S TITLE\n${titleBlock}\n` : ""}
WHAT THE VIDEO CONTAINS${lines.length > CARD_LINES_SENT ? ` (the first ${CARD_LINES_SENT} lines)` : ""}
${lineBlock || "(no lines yet — write a general card for a Kurdish lesson)"}${previousBlock}${noteBlock}`;
}

/**
 * Tidies what came back so the voice reads only words: no wrapping quotes, no
 * emoji or hashtags that slipped through, one line, single spaces.
 */
export function cleanCardText(text: unknown): string {
  return String(text ?? "")
    .replace(/#[\p{L}\p{N}_]+/gu, " ")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’«»„]+|["'“”‘’«»„]+$/g, "")
    .trim();
}
