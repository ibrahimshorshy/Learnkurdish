/**
 * App-wide preferences, kept in this browser's localStorage. Everything
 * per-lesson lives in the project instead.
 */

import { AUDIENCE_LANGUAGES, defaultAudienceIds } from "../config/languages";
import { DEFAULT_TRANSCRIBE_MODEL, DEFAULT_TRANSLATE_MODEL } from "../config/models";

export interface AppSettings {
  /** Overrides the key in .env for requests from this browser. */
  apiKey: string;
  transcribeModel: string;
  translateModel: string;
  /** Audience languages new projects start with. */
  audiences: string[];
  /** Let the browser filter background noise while recording. */
  noiseSuppression: boolean;
  /** A replacement for /logo.png on the videos, as a data URL. */
  logoDataUrl: string;
}

const KEY = "leen-kurdish-settings";

export function loadSettings(): AppSettings {
  const defaults: AppSettings = {
    apiKey: "",
    transcribeModel: DEFAULT_TRANSCRIBE_MODEL,
    translateModel: DEFAULT_TRANSLATE_MODEL,
    audiences: defaultAudienceIds(),
    noiseSuppression: true,
    logoDataUrl: "",
  };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    const merged = { ...defaults, ...saved } as AppSettings;
    const known = new Set(AUDIENCE_LANGUAGES.map((l) => l.id));
    merged.audiences = (Array.isArray(merged.audiences) ? merged.audiences : []).filter((id) => known.has(id));
    if (!merged.audiences.length) merged.audiences = defaults.audiences;
    return merged;
  } catch {
    return defaults;
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // A full or blocked localStorage only costs the preference, not the app.
  }
}

export const LAST_PROJECT_KEY = "leen-kurdish-last-project";
