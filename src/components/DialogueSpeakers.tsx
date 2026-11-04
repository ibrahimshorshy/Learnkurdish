import type { Project } from "../types";

/** The two speakers' names in a dialogue. Empty names show as "Speaker 1/2". */
export default function DialogueSpeakers({
  project,
  update,
}: {
  project: Project;
  update: (patch: Partial<Project> | ((p: Project) => Partial<Project>)) => void;
}) {
  const setName = (index: number, name: string) =>
    update((p) => ({ speakers: p.speakers.map((s, i) => (i === index ? { ...s, name } : s)) }));
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {[0, 1].map((i) => (
        <label key={i} className="block">
          <span className="label flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${i === 0 ? "bg-brand-blue" : "bg-brand-green"}`} />
            Speaker {i + 1}
          </span>
          <input
            className="field mt-1.5"
            placeholder={i === 0 ? "e.g. Rêbwar — or leave empty" : "e.g. Shilan — or leave empty"}
            value={project.speakers[i]?.name ?? ""}
            onChange={(e) => setName(i, e.target.value)}
          />
        </label>
      ))}
    </div>
  );
}
