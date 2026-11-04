/**
 * The AI voices, and the speech models that make them.
 *
 * Used for one thing only: reading the title and closing cards aloud in the
 * audience's language — Arabic, English, and so on. The lesson itself is
 * never synthesized; speech models mispronounce Kurdish, which is the whole
 * reason the teacher records his own voice.
 *
 * Imported by both the server and the React UI, so it must stay free of any
 * Node- or browser-only imports. The list follows Reels Creator.
 */

export interface VoiceModelInfo {
  id: string;
  label: string;
  blurb: string;
  /** USD per 1M characters of input text. Only drives the in-app estimate. */
  charsPerM: number;
}

/*
 * Every model here is sent the spoken words and nothing else — no pace, no
 * accent, no style. See config/ttsRequest for why.
 */
export const VOICE_MODELS: VoiceModelInfo[] = [
  {
    id: "gemini-3.1-flash-tts-preview",
    label: "Gemini 3.1 Flash TTS",
    blurb: "The default. Returns plain audio with nothing appended.",
    charsPerM: 10.0,
  },
  {
    id: "gemini-3.8-flash-tts",
    label: "Gemini 3.8 Flash TTS",
    blurb: "Newer voices. Returns a WAV with a provenance manifest, which is stripped.",
    charsPerM: 10.0,
  },
  {
    id: "gemini-3.8-flash-lite-tts",
    label: "Gemini 3.8 Flash Lite TTS",
    blurb: "Lower latency and cheaper.",
    // An estimate from the Flash/Lite ratio on the text models, not a quoted price.
    charsPerM: 4.0,
  },
];

/*
 * 3.1 returns plain audio/L16; 3.8 returns a WAV with a manifest after the
 * audio. Both decode correctly, but plain audio is the one with less that can
 * go wrong.
 */
export const DEFAULT_VOICE_MODEL = "gemini-3.1-flash-tts-preview";

/** Order the server walks when the preferred speech model is refusing rather than busy. */
export const VOICE_FALLBACK_CHAIN = [
  "gemini-3.1-flash-tts-preview",
  "gemini-3.8-flash-tts",
  "gemini-3.8-flash-lite-tts",
];

export function findVoiceModel(id: string): VoiceModelInfo | undefined {
  return VOICE_MODELS.find((m) => m.id === id);
}

/** Estimated USD for reading `text` aloud. Unknown models are priced as the default. */
export function estimateVoiceCost(modelId: string, text: string): number {
  const model = findVoiceModel(modelId) ?? findVoiceModel(DEFAULT_VOICE_MODEL)!;
  return (text.length * model.charsPerM) / 1_000_000;
}

/**
 * Prebuilt Gemini speech voices, grouped so the picker can suggest a fit
 * rather than listing thirty names. Every one of them speaks Arabic and
 * English; the language comes from the text.
 */
export interface VoiceOption {
  name: string;
  gender: "male" | "female";
  character: string;
}

export const PREBUILT_VOICES: VoiceOption[] = [
  { name: "Charon", gender: "male", character: "Informative, steady" },
  { name: "Puck", gender: "male", character: "Upbeat, energetic" },
  { name: "Fenrir", gender: "male", character: "Warm, grounded" },
  { name: "Orus", gender: "male", character: "Firm, authoritative" },
  { name: "Enceladus", gender: "male", character: "Breathy, gentle" },
  { name: "Iapetus", gender: "male", character: "Clear, neutral" },
  { name: "Algenib", gender: "male", character: "Gravelly, mature" },
  { name: "Rasalgethi", gender: "male", character: "Knowledgeable, calm" },
  { name: "Aoede", gender: "female", character: "Breezy, friendly" },
  { name: "Kore", gender: "female", character: "Confident, crisp" },
  { name: "Leda", gender: "female", character: "Youthful, bright" },
  { name: "Zephyr", gender: "female", character: "Bright, lively" },
  { name: "Autonoe", gender: "female", character: "Bright, articulate" },
  { name: "Callirrhoe", gender: "female", character: "Easygoing, relaxed" },
  { name: "Despina", gender: "female", character: "Smooth, polished" },
  { name: "Erinome", gender: "female", character: "Clear, precise" },
];

export const DEFAULT_MALE_VOICE = "Charon";
export const DEFAULT_FEMALE_VOICE = "Aoede";

export function findVoice(name: string): VoiceOption | undefined {
  return PREBUILT_VOICES.find((v) => v.name === name);
}

/**
 * A voice name safe to hand to the API. Gemini has more voices than the picker
 * lists, so any plain name is passed through; anything else gets the default.
 */
export function safeVoiceName(name: unknown): string {
  const text = String(name ?? "").trim();
  return /^[A-Za-z]{2,32}$/.test(text) ? text : DEFAULT_MALE_VOICE;
}

/**
 * The speech model to use for a request. A text model id that arrives here by
 * mistake (the app's translate model, say) would fail every time, so only a
 * known speech model, or something that at least calls itself one, is kept.
 */
export function safeVoiceModel(id: unknown): string {
  const text = String(id ?? "").trim();
  if (findVoiceModel(text)) return text;
  return /^gemini-[\w.-]*tts[\w.-]*$/i.test(text) ? text : DEFAULT_VOICE_MODEL;
}
