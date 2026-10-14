/**
 * Transcription of a two-speaker dialogue.
 *
 * STUB — owned by the dialogue builder. Until it is written, a dialogue is
 * transcribed like a lesson and every line is given to the first speaker.
 */

import type { TranscribeModeSpec } from "../transcribeModes";
import { transcribePrompt, transcribeSystemPrompt } from "../prompts";

export const dialogueMode: TranscribeModeSpec = {
  systemPrompt: ({ language }) => transcribeSystemPrompt(language),
  prompt: ({ language, durationSeconds, context }) => transcribePrompt({ language, durationSeconds, context }),
  schema: () => ({
    type: "OBJECT",
    properties: {
      lines: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: { text: { type: "STRING" }, start: { type: "NUMBER" }, end: { type: "NUMBER" } },
          required: ["text", "start", "end"],
        },
      },
    },
    required: ["lines"],
  }),
  toRawLines: (data) => (Array.isArray(data?.lines) ? data.lines.map((l: any) => ({ ...l, speaker: 0 })) : []),
};
