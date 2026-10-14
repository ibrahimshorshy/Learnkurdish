/**
 * Audio clean-up: noise-removal and tone presets, room ambience, and
 * shortening long pauses inside lines.
 *
 * STUB — owned by the audio builder.
 */

import type { Project } from "../types";
import type { LessonAudio, Playback } from "../audio/useRecordingAudio";

export interface AudioCleanupPanelProps {
  project: Project;
  audio: LessonAudio;
  playback: Playback;
  update: (patch: Partial<Project> | ((p: Project) => Partial<Project>)) => void;
}

export default function AudioCleanupPanel(_props: AudioCleanupPanelProps) {
  return null;
}
