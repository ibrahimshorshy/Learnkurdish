/**
 * Every language the app knows about, in one place.
 *
 * Two lists, because the app deals with languages in two different roles:
 *
 *   TAUGHT    — the language you speak into the microphone. The lesson is
 *               *about* this language. Kurdish Sorani is the default and, for
 *               now, the only one switched on.
 *   AUDIENCE  — the languages the lesson is explained *in*. Every line you
 *               record is translated into each enabled audience language, and
 *               a video can be made for each one (or one video that shows
 *               several side by side).
 *
 * Adding a language later is an entry here and nothing else: the prompts, the
 * pickers, the on-video labels and the text direction all read from these
 * records. Persian and Turkish are already written up as audience languages and
 * only need switching on in Settings.
 *
 * Imported by both server.ts and the React UI, so it must stay free of any
 * Node- or browser-only imports.
 */

/* ------------------------------------------------------------------ */
/* Taught language — what is in the recording                          */
/* ------------------------------------------------------------------ */

export interface TaughtLanguage {
  id: string;
  /** English name, used in prompts and the UI. */
  label: string;
  /** What speakers call it themselves. */
  endonym: string;
  /** Pinned precisely enough that a model does not drift to a neighbour. */
  variety: string;
  /** Spelling rules the transcript has to follow. */
  orthography: string[];
  /** How the Latin pronunciation helper should be written. */
  romanization: string;
  /** What the transcriber must never produce. */
  avoid: string[];
  /** Whether the script runs right to left. */
  rtl: boolean;
  /** False until the language is ready for use. */
  enabled: boolean;
}

export const TAUGHT_LANGUAGES: TaughtLanguage[] = [
  {
    id: "ckb",
    label: "Kurdish Sorani",
    endonym: "کوردیی سۆرانی",
    variety:
      "Central Kurdish (Sorani) as spoken in the Kurdistan Region of Iraq — Sulaymaniyah, Erbil and the surrounding cities — in natural everyday speech",
    orthography: [
      "Write in the standard Arabic-based Sorani alphabet, right to left.",
      "Sorani's own letters are not optional: ڕ (rolled r), ڵ (velar l), ۆ (o), ێ (ê), وو (û), ە (a / schwa), and پ، چ، ژ، گ، ڤ where they are said.",
      "Use ە for the vowel a / schwa, including at the end of a word — never ه in that role; ه (or ھ) is only ever the consonant h. Never ة or ى anywhere.",
      "No Arabic tashkeel, tanwin or hamza-on-a-seat. A word-initial vowel is written with ئ as Sorani does: ئەو، ئێمە، ئاو.",
      "Write the definite ـەکە, the indefinite ـێک, the plural ـەکان / ـان and the pronoun clitics joined to their word, the way Sorani is printed: کتێبەکە، کوڕێک، ماڵەکەمان.",
      "Write the present prefix joined: دەچم، دەڵێم، نازانم. Keep the negative نا / نە / مە joined too.",
    ],
    romanization:
      "Kurdish Latin (Hawar / Bedirxan) alphabet as Kurds write it themselves: ç ş ê î û, x for خ, ẍ for غ, ḧ for ح, ř for ڕ, ł for ڵ, e for ە, i for the short unwritten vowel. Example: «چۆنی؟ باشم، زۆر سوپاس» → «Çonî? Başim, zor supas.»",
    avoid: [
      "Translating, paraphrasing or correcting what was said. A transcript is what the speaker said, word for word, including dialect forms.",
      "Kurmanji forms, or the Latin alphabet in the transcript itself.",
      "Plain Arabic lookalikes in place of Sorani letters: ر for ڕ، ل for ڵ، و for ۆ، ي / ی for ێ، ه for ە.",
      "Persian or Arabic spellings of words that Sorani writes its own way.",
    ],
    rtl: true,
    enabled: true,
  },
];

export const DEFAULT_TAUGHT_LANGUAGE = "ckb";

export function findTaughtLanguage(id: string | undefined): TaughtLanguage {
  return TAUGHT_LANGUAGES.find((l) => l.id === id) ?? TAUGHT_LANGUAGES[0];
}

/* ------------------------------------------------------------------ */
/* Audience languages — what the lesson is explained in                */
/* ------------------------------------------------------------------ */

/** The words burned into the video, in the audience's own language. */
export interface VideoStrings {
  /** Under the logo: "Learn Kurdish Sorani". */
  tagline: string;
  /** Shown while the line is playing. */
  listen: string;
  /** Shown while the same line plays again. */
  listenAgain: string;
  /** Shown during the silence left for the viewer to repeat. */
  yourTurn: string;
  /** Under the title on the opening card. */
  getReady: string;
  /** Closing card headline. */
  wellDone: string;
  /** Closing card call to action. */
  follow: string;
  /** Label above the pronunciation line. */
  pronunciation: string;
}

export interface AudienceLanguage {
  id: string;
  /** English name, used in prompts and pickers. */
  label: string;
  /** Its own name, for the picker. */
  nativeLabel: string;
  rtl: boolean;
  /** Translation guidance handed to the model. */
  brief: string;
  strings: VideoStrings;
  /** On for every new project unless changed in Settings. */
  enabledByDefault: boolean;
}

export const AUDIENCE_LANGUAGES: AudienceLanguage[] = [
  {
    id: "ar",
    label: "Arabic",
    nativeLabel: "العربية",
    rtl: true,
    brief:
      "Arabic for a general Arab audience: clear, modern, simple Arabic that any Arab reader understands at a glance — the register of a good subtitle, not a literary text. Use ordinary everyday vocabulary; avoid rare classical words. Correct spelling (ة، ى، أ، إ where they belong), no tashkeel except where a word would otherwise be ambiguous. Keep the speaker's tone: a casual line stays casual, a question stays a question.",
    strings: {
      tagline: "تعلّم الكردية السورانية",
      listen: "استمع",
      listenAgain: "استمع مرة أخرى",
      yourTurn: "دورك — كرّر",
      getReady: "استعد للاستماع",
      wellDone: "أحسنت!",
      follow: "تابعنا لدرس جديد كل يوم",
      pronunciation: "النطق",
    },
    enabledByDefault: true,
  },
  {
    id: "en",
    label: "English",
    nativeLabel: "English",
    rtl: false,
    brief:
      "Natural, idiomatic English as a native speaker would say it — a good subtitle, not a word-for-word gloss. Keep it short and plain. Keep the speaker's tone: a casual line stays casual, a question stays a question.",
    strings: {
      tagline: "Learn Kurdish Sorani",
      listen: "LISTEN",
      listenAgain: "LISTEN AGAIN",
      yourTurn: "YOUR TURN — REPEAT",
      getReady: "GET READY TO LISTEN",
      wellDone: "Well done!",
      follow: "Follow for a new Kurdish lesson",
      pronunciation: "Pronunciation",
    },
    enabledByDefault: true,
  },
  {
    id: "fa",
    label: "Persian",
    nativeLabel: "فارسی",
    rtl: true,
    brief:
      "Natural contemporary Persian (Farsi) as used in Iran, in standard Persian spelling with ی and ک (never Arabic ي or ك) and the zero-width non-joiner where Persian uses it (می‌روم). Plain everyday register, like a good subtitle.",
    strings: {
      tagline: "کُردی سورانی بیاموزید",
      listen: "گوش کن",
      listenAgain: "دوباره گوش کن",
      yourTurn: "نوبت توست — تکرار کن",
      getReady: "آماده‌ی شنیدن باش",
      wellDone: "آفرین!",
      follow: "برای درس‌های بیشتر دنبال کنید",
      pronunciation: "تلفظ",
    },
    enabledByDefault: false,
  },
  {
    id: "tr",
    label: "Turkish",
    nativeLabel: "Türkçe",
    rtl: false,
    brief:
      "Natural, everyday Turkish as spoken in Turkey, correctly spelled with ç ğ ı İ ö ş ü. Plain conversational register, like a good subtitle.",
    strings: {
      tagline: "Sorani Kürtçe öğren",
      listen: "DİNLE",
      listenAgain: "TEKRAR DİNLE",
      yourTurn: "SIRA SENDE — TEKRARLA",
      getReady: "DİNLEMEYE HAZIR OL",
      wellDone: "Harika!",
      follow: "Yeni Kürtçe dersler için takip et",
      pronunciation: "Telaffuz",
    },
    enabledByDefault: false,
  },
];

export function findAudienceLanguage(id: string): AudienceLanguage | undefined {
  return AUDIENCE_LANGUAGES.find((l) => l.id === id);
}

export function defaultAudienceIds(): string[] {
  return AUDIENCE_LANGUAGES.filter((l) => l.enabledByDefault).map((l) => l.id);
}

/** True when a run of text is in a right-to-left script. */
export function isRtlText(text: string): boolean {
  return /[֐-ࣿיִ-﷿ﹰ-﻿]/.test(text || "");
}
