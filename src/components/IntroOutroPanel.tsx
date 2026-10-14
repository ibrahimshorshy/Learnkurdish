/**
 * Title and closing cards: on or off, their text per language, and their sound
 * — an AI voice, your own clip, or silence.
 *
 * STUB — owned by the intro/outro builder. For now: on/off only.
 */

import type { Project } from "../types";
import type { AppSettings } from "../utils/settings";
import { Toggle } from "./ui";

interface Props {
  project: Project;
  settings: AppSettings;
  update: (patch: Partial<Project> | ((p: Project) => Partial<Project>)) => void;
}

export default function IntroOutroPanel({ project, update }: Props) {
  return (
    <section className="card p-5 space-y-3">
      <h2 className="text-lg font-bold">Title &amp; closing cards</h2>
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <Toggle checked={project.intro.enabled} onChange={(on) => update((p) => ({ intro: { ...p.intro, enabled: on } }))}>
          Title card
        </Toggle>
        <Toggle checked={project.outro.enabled} onChange={(on) => update((p) => ({ outro: { ...p.outro, enabled: on } }))}>
          Closing card
        </Toggle>
      </div>
    </section>
  );
}
