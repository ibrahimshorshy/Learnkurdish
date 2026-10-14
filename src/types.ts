import type { ThemeId } from "./render/themes";
import type { ResolutionId } from "./render/renderLesson";
import type { RepeatGapMode } from "./render/timeline";

export type StepId = "record" | "transcript" | "translate" | "video";

export const STEPS: { id: StepId; label: string; hint: string }[] = [
  { id: "record", label: "Record", hint: "Your Kurdish voice" },
  { id: "transcript", label: "Transcript", hint: "Line by line, plus your note" },
  { id: "translate", label: "Translate & review", hint: "Arabic, English — proof it" },
  { id: "video", label: "Video", hint: "MP4 for each language" },
];

export interface LessonLine {
  id: string;
  /** The line as spoken, in Sorani script. */
  kurdish: string;
  /** Where the line sits in the recording, in seconds. */
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
}

export interface VideoSettings {
  theme: ThemeId;
  resolution: ResolutionId;
  /** Times each line is played, 1 to 3. */
  plays: number;
  repeatGapMode: RepeatGapMode;
  repeatGapSeconds: number;
  gapBetweenLines: number;
  showTransliteration: boolean;
  karaoke: boolean;
  intro: boolean;
  outro: boolean;
  /** One video per entry; each entry lists the languages shown in it. */
  outputs: string[][];
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

export interface Project {
  id: string;
  /** Working name in the library. Defaults to the English title once there is one. */
  name: string;
  createdAt: number;
  updatedAt: number;
  taughtLang: string;
  /** Languages this lesson is translated into. */
  audiences: string[];
  recording?: Recording;
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
  video: VideoSettings;
  renders: RenderedVideo[];
  usage: UsageTotals;
}
