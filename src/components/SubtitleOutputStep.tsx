/**
 * Last step of a video project: your uploaded video, with the Kurdish and its
 * translation burned in as subtitles — one MP4 per chosen output.
 *
 * STUB — owned by the video builder.
 */

import type { Project } from "../types";
import type { AudioSources } from "../audio/clipBuilder";
import type { AppSettings } from "../utils/settings";

export interface SubtitleOutputStepProps {
  project: Project;
  sources: AudioSources;
  settings: AppSettings;
  ffmpeg: boolean | null;
  logoSrc: string;
  update: (patch: Partial<Project> | ((p: Project) => Partial<Project>)) => void;
}

export default function SubtitleOutputStep(_props: SubtitleOutputStepProps) {
  return <div className="card p-6 text-paper/60">Subtitled video export is coming.</div>;
}
