import type { ThemeId } from "./render/themes";
import type { ResolutionId } from "./render/renderLesson";
import type { RepeatGapMode } from "./render/timeline";

/* ------------------------------------------------------------------ */
/* Kinds of project                                                     */
/* ------------------------------------------------------------------ */

/**
 * What a project is made from and what it turns into.
 *
 *   lesson   — you record sentences; a card-style lesson video with listen
 *              and repeat pauses
 *   video    — you upload a video of yourself; the same video comes back
 *              with Kurdish and translated subtitles burned in
 *   dialogue — a recording of two speakers; a chat-thread video with each
 *              line on its speaker's side
 *   story    — a longer text read aloud; a reading video, paragraph by
 *              paragraph, the current sentence highlighted
 */
export type ProjectKind = "lesson" | "video" | "dialogue" | "story";

export const KINDS: { id: ProjectKind; label: string; blurb: string }[] = [
  { id: "lesson", label: "Lesson", blurb: "Record sentences → listen-and-repeat lesson" },
  { id: "video", label: "Video", blurb: "Upload a video → subtitled in Kurdish + translation" },
  { id: "dialogue", label: "Dialogue", blurb: "Two speakers → chat-thread video" },
  { id: "story", label: "Story", blurb: "A longer text read aloud → reading video" },
];

export type StepId = "record" | "transcript" | "translate" | "video";

const STEP_LABELS: Record<ProjectKind, Record<StepId, { label: string; hint: string }>> = {
  lesson: {
    record: { label: "Record", hint: "Your Kurdish voice" },
    transcript: { label: "Transcript", hint: "Line by line, plus your note" },
    translate: { label: "Translate & review", hint: "Arabic, English — proof it" },
    video: { label: "Video", hint: "MP4 for each language" },
  },
  video: {
    record: { label: "Upload video", hint: "A video of you speaking" },
    transcript: { label: "Transcript", hint: "Line by line, plus your note" },
    translate: { label: "Translate & review", hint: "Arabic, English — proof it" },
    video: { label: "Subtitled video", hint: "Your video, subtitled" },
  },
  dialogue: {
    record: { label: "Record dialogue", hint: "Two voices, one recording" },
    transcript: { label: "Lines & speakers", hint: "Who says what" },
    translate: { label: "Translate & review", hint: "Arabic, English — proof it" },
    video: { label: "Video", hint: "Chat-thread MP4" },
  },
  story: {
    record: { label: "Text & recording", hint: "Paste it, read it aloud" },
    transcript: { label: "Sentences", hint: "Timing and paragraphs" },
    translate: { label: "Translate & review", hint: "Arabic, English — proof it" },
    video: { label: "Video", hint: "Reading MP4" },
  },
};

export const STEP_ORDER: StepId[] = ["record", "transcript", "translate", "video"];

export function stepsFor(kind: ProjectKind): { id: StepId; label: string; hint: string }[] {
  return STEP_ORDER.map((id) => ({ id, ...STEP_LABELS[kind][id] }));
}

/** Kept for code that predates kinds: the lesson labels. */
export const STEPS = stepsFor("lesson");

/* ------------------------------------------------------------------ */
/* Lines and their audio                                                */
/* ------------------------------------------------------------------ */

export interface TimeRange {
  start: number;
  end: number;
}

/**
 * A fresh recording of a single line, used instead of that line's slice of
 * the main recording. Everything else about the line — its text, its
 * translations — stays.
 */
export interface Take {
  id: string;
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
  /** The part of the take that is the line, in seconds within the take. */
  start: number;
  end: number;
  /** A cleaned-up version of `blob`, made with the project's audio preset. */
  processed?: ProcessedAudio;
}

export interface LessonLine {
  id: string;
  /** The line as spoken, in Sorani script. */
  kurdish: string;
  /** Where the line sits in the main recording, in seconds. Ignored when `take` is set. */
  start: number;
  end: number;
  /** Latin pronunciation helper. */
  transliteration: string;
  /** Keyed by audience language id. */
  translations: Record<string, string>;
  /** The Kurdish the current translations were made from; differs once edited. */
  translatedFrom?: string;
  /** Kept in the project but left out of the video. */
  skip?: boolean;
  /** A re-recorded take that replaces this line's audio. */
  take?: Take;
  /** Dialogue: who says this line — 0 for the first speaker, 1 for the second. */
  speaker?: number;
  /** Story: this line starts a new paragraph. */
  paragraphStart?: boolean;
}

/* ------------------------------------------------------------------ */
/* Audio clean-up                                                       */
/* ------------------------------------------------------------------ */

export type AudioPresetId = "raw" | "clean" | "noisy" | "studio" | "warm";

export interface AudioFxSettings {
  /** Noise removal and tone; see config/audioPresets. */
  preset: AudioPresetId;
  /** A touch of room ambience, so a very dry recording sounds less boxed in. */
  room: boolean;
  /** Shorten silences inside a line that are longer than `maxPause`. */
  tightenPauses: boolean;
  maxPause: number;
}

export interface ProcessedAudio {
  /** Which source and settings produced it; a different key means it is stale. */
  key: string;
  blob: Blob;
}

/* ------------------------------------------------------------------ */
/* Intro and outro cards                                                */
/* ------------------------------------------------------------------ */

export type CardAudioMode = "ai" | "recorded" | "silent";

export interface CardClip {
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
  source: "ai" | "recorded";
  /** For AI clips: the text and voice it was made from, so an edit marks it stale. */
  madeFrom?: string;
}

export interface CardSettings {
  enabled: boolean;
  /** "ai": an AI voice reads the text; "recorded": your own clip; "silent": text only. */
  audio: CardAudioMode;
  /** Card text per audience language. Empty falls back to the default wording. */
  text: Record<string, string>;
  /** One clip per audience language. */
  clips: Record<string, CardClip>;
  /** Gemini voice name for "ai". */
  voice: string;
}

/* ------------------------------------------------------------------ */
/* Video settings                                                       */
/* ------------------------------------------------------------------ */

export interface VideoSettings {
  /** Look per output, keyed by outputKey (e.g. "ar", "en", "ar+en"). Missing keys use the language default. */
  themes: Record<string, ThemeId>;
  resolution: ResolutionId;
  /** Times each line is played, 1 to 3. */
  plays: number;
  repeatGapMode: RepeatGapMode;
  repeatGapSeconds: number;
  gapBetweenLines: number;
  showTransliteration: boolean;
  karaoke: boolean;
  /** One video per entry; each entry lists the languages shown in it. */
  outputs: string[][];
  /** Story: translate the sentence being read, or show the whole paragraph's translation. */
  storyTranslation: "sentence" | "paragraph";
  /** Video kind: where the subtitles sit. */
  subtitlePosition: "lower" | "middle";
  /** Video kind: how a video that is not 9:16 fills the frame. */
  videoFit: "blur" | "crop";
  /** @deprecated single theme from 1.0; read once by the migration. */
  theme?: ThemeId;
  /** @deprecated moved to Project.intro / Project.outro. */
  intro?: boolean;
  /** @deprecated moved to Project.intro / Project.outro. */
  outro?: boolean;
}

export interface RenderedVideo {
  id: string;
  languages: string[];
  blob: Blob;
  createdAt: number;
  durationSeconds: number;
  /** What it was made from, so a video made before an edit is flagged as old. */
  fingerprint: string;
}

export interface UsageTotals {
  inputTokens: number;
  audioTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface Recording {
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
  fileName?: string;
}

/** The uploaded video a "video" project subtitles. Its audio becomes the recording. */
export interface SourceVideo {
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
  width: number;
  height: number;
  fileName?: string;
}

export interface Speaker {
  name: string;
}

export interface Project {
  id: string;
  kind: ProjectKind;
  /** Working name in the library. Defaults to the English title once there is one. */
  name: string;
  createdAt: number;
  updatedAt: number;
  taughtLang: string;
  /** Languages this lesson is translated into. */
  audiences: string[];
  /** The main recording (for a video project: its extracted audio). */
  recording?: Recording;
  /** Cleaned-up version of the main recording for the current audio settings. */
  processed?: ProcessedAudio;
  /** Stretches of the main recording to leave out, in its own timeline. */
  cuts: TimeRange[];
  audioFx: AudioFxSettings;
  /** Video projects: the uploaded video. */
  sourceVideo?: SourceVideo;
  /**
   * Text you are reading from — a post script or a story. When set, the
   * transcriber aligns these known lines to the recording instead of
   * guessing the words.
   */
  script?: string[];
  /** Which built-in script it came from, if any. */
  scriptId?: string;
  /** Story projects: the text as pasted, paragraphs and all. */
  storyText?: string;
  /** Dialogue projects: the two speakers. */
  speakers: Speaker[];
  /** Optional: what the recording is about, given to the transcriber. */
  context: string;
  /** Optional: what to focus on, given to the translator. */
  note: string;
  lines: LessonLine[];
  /** Whether the line times came from the model or were placed from the audio. */
  timesSource?: "model" | "audio" | "manual";
  titles: Record<string, string>;
  captions: Record<string, string>;
  step: StepId;
  /** Set when the translations were approved for video. */
  approvedAt?: number;
  intro: CardSettings;
  outro: CardSettings;
  video: VideoSettings;
  renders: RenderedVideo[];
  usage: UsageTotals;
}
