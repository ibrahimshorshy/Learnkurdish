/**
 * Alignment of a known text (a story, a script) to a recording of it being read.
 *
 * STUB — owned by the story builder. Until it is written, the recording is
 * transcribed like a lesson and the known text is ignored.
 */

import type { TranscribeModeSpec } from "../transcribeModes";
import { transcribePrompt, transcribeSystemPrompt } from "../prompts";

export const alignedMode: TranscribeModeSpec = {
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
  toRawLines: (data) => (Array.isArray(data?.lines) ? data.lines : []),
};
