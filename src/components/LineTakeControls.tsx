/**
 * Re-record a single line: record or upload a fresh take that replaces this
 * line's slice of the main recording, hear it, trim it, or go back to the
 * original.
 *
 * STUB — owned by the audio builder.
 */

import type { LessonLine, Project } from "../types";
import type { LessonAudio, Playback } from "../audio/useRecordingAudio";
import type { AppSettings } from "../utils/settings";

export interface LineTakeControlsProps {
  line: LessonLine;
  project: Project;
  audio: LessonAudio;
  playback: Playback;
  settings: AppSettings;
  /** Smaller layout for the review step. */
  compact?: boolean;
  update: (patch: Partial<Project> | ((p: Project) => Partial<Project>)) => void;
}

export default function LineTakeControls(_props: LineTakeControlsProps) {
  return null;
}
