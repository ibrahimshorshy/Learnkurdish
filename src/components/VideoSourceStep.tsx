/**
 * Step 1 of a video project: upload a video of yourself speaking Kurdish. Its
 * audio is pulled out and becomes the recording the rest of the steps use.
 *
 * STUB — owned by the video builder.
 */

import type { Project } from "../types";
import type { AppSettings } from "../utils/settings";
import type { LessonAudio } from "../audio/useRecordingAudio";

export interface VideoSourceStepProps {
  project: Project;
  settings: AppSettings;
  audio: LessonAudio;
  busy: boolean;
  update: (patch: Partial<Project> | ((p: Project) => Partial<Project>)) => void;
  onTranscribe: () => void;
}

export default function VideoSourceStep(_props: VideoSourceStepProps) {
  return <div className="card p-6 text-paper/60">Video upload is coming.</div>;
}
