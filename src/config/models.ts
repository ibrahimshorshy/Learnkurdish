/**
 * Which Gemini models this app uses, and what they cost.
 *
 * Imported by both server.ts and the React UI, so it must stay free of any
 * Node- or browser-only imports.
 *
 * The list follows the one in Reels Creator. Run
 * `GEMINI_API_KEY=... node list_models.js` to see what your key can actually
 * reach; an id that no longer resolves costs one failed request and then the
 * server walks on down the fallback chain.
 *
 * There are no speech models here on purpose. The whole point of this app is
 * that the voice is yours: speech models mispronounce Kurdish, so nothing in a
 * lesson is ever synthesized.
 */

export type ModelTier = "economy" | "balanced" | "premium";

export interface TextModelInfo {
  id: string;
  label: string;
  tier: ModelTier;
  blurb: string;
  /** USD per 1M text input tokens. */
  inputPerM: number;
  /** USD per 1M audio input tokens. Audio is billed at 32 tokens a second. */
  audioInputPerM: number;
  /** USD per 1M output tokens. */
  outputPerM: number;
}

/**
 * List prices for the paid tier. They only drive the in-app cost estimate,
 * never a request. Check https://ai.google.dev/pricing before trusting them.
 */
export const TEXT_MODELS: TextModelInfo[] = [
  {
    id: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    tier: "balanced",
    blurb: "Newest Flash. The default for both transcription and translation.",
    inputPerM: 0.3,
    audioInputPerM: 1.0,
    outputPerM: 2.5,
  },
  {
    id: "gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    tier: "balanced",
    blurb: "Previous Flash generation. Reliable fallback.",
    inputPerM: 0.3,
    audioInputPerM: 1.0,
    outputPerM: 2.5,
  },
  {
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    tier: "balanced",
    blurb: "Widely available Flash generation.",
    inputPerM: 0.3,
    audioInputPerM: 1.0,
    outputPerM: 2.5,
  },
  {
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro",
    tier: "premium",
    blurb: "Strongest listener. Worth it when Flash mishears your Kurdish.",
    inputPerM: 1.25,
    audioInputPerM: 1.25,
    outputPerM: 10.0,
  },
  {
    id: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash Lite",
    tier: "economy",
    blurb: "Cheapest. Fine for translation, weaker at hearing Kurdish.",
    inputPerM: 0.1,
    audioInputPerM: 0.3,
    outputPerM: 0.4,
  },
  {
    id: "gemini-flash-latest",
    label: "Gemini Flash (auto-latest)",
    tier: "balanced",
    blurb: "Alias that always points at Google's newest Flash.",
    inputPerM: 0.3,
    audioInputPerM: 1.0,
    outputPerM: 2.5,
  },
];

export const DEFAULT_TRANSCRIBE_MODEL = "gemini-3.8-flash";
export const DEFAULT_TRANSLATE_MODEL = "gemini-3.8-flash";

/**
 * Order the server walks when the chosen model errors out. Listening to
 * Kurdish is the hard part, so the chain for audio climbs to Pro rather than
 * down to Lite.
 */
export const TRANSCRIBE_FALLBACK_CHAIN = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-flash-latest",
];

export const TRANSLATE_FALLBACK_CHAIN = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-flash-latest",
  "gemini-3.1-pro-preview",
];

export function findTextModel(id: string): TextModelInfo | undefined {
  return TEXT_MODELS.find((m) => m.id === id);
}

export interface Usage {
  inputTokens: number;
  /** Portion of inputTokens that was audio, billed at the audio rate. */
  audioTokens: number;
  outputTokens: number;
}

/** Estimated USD for one request. Unknown models are priced as Flash. */
export function estimateCost(modelId: string, usage: Usage): number {
  const model = findTextModel(modelId) ?? TEXT_MODELS[0];
  const textIn = Math.max(0, usage.inputTokens - usage.audioTokens);
  return (
    (textIn * model.inputPerM +
      usage.audioTokens * model.audioInputPerM +
      usage.outputTokens * model.outputPerM) /
    1_000_000
  );
}
