/**
 * The ways a recording can be transcribed. Each mode is its own prompt, its own
 * response shape, and a function that turns the model's answer into lines.
 *
 *   lines    — a lesson: one line per sentence, words as heard
 *   dialogue — the same, plus which of the two speakers says each line
 *   aligned  — the words are already known (a story you pasted, a script you
 *              read from); the model only says where each one is
 *
 * Pure: imported by the server and the tests.
 */

import type { TaughtLanguage } from "./languages";
import type { RawTranscriptLine } from "../utils/transcript";
import { transcribePrompt, transcribeSystemPrompt } from "./prompts";
import { dialogueMode } from "./prompts/dialogue";
import { alignedMode } from "./prompts/aligned";

export type TranscribeMode = "lines" | "dialogue" | "aligned";

export interface TranscribeInput {
  language: TaughtLanguage;
  durationSeconds: number;
  context?: string;
  /** aligned: the text being read, one sentence per entry. */
  knownLines?: string[];
  /** dialogue: the speakers' names, if the user has given them. */
  speakers?: string[];
}

export interface TranscribeModeSpec {
  systemPrompt: (input: TranscribeInput) => string;
  prompt: (input: TranscribeInput) => string;
  /** JSON schema in Gemini's type names: "OBJECT", "ARRAY", "STRING", "NUMBER", "INTEGER", "BOOLEAN". */
  schema: (input: TranscribeInput) => any;
  /** The model's parsed JSON → raw lines for normalizeTranscript. */
  toRawLines: (data: any, input: TranscribeInput) => RawTranscriptLine[];
}

export const linesMode: TranscribeModeSpec = {
  systemPrompt: ({ language }) => transcribeSystemPrompt(language),
  prompt: ({ language, durationSeconds, context }) => transcribePrompt({ language, durationSeconds, context }),
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
          },
          required: ["text", "start", "end"],
        },
      },
    },
    required: ["lines"],
  }),
  toRawLines: (data) => (Array.isArray(data?.lines) ? data.lines : []),
};

const MODES: Record<TranscribeMode, TranscribeModeSpec> = {
  lines: linesMode,
  dialogue: dialogueMode,
  aligned: alignedMode,
};

export function transcribeMode(mode: string | undefined): TranscribeModeSpec {
  return MODES[mode as TranscribeMode] ?? linesMode;
}
